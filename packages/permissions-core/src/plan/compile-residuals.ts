// `ResidualResponse` -> three-state plan (core.md §5.3).
//
// The pipeline, in order, with the reason each step exists:
//
//   0. errored[] gate — an errored policy gets a `{"Value":false}` residual, so
//      an errored *forbid* is already gone by the time anything here runs. There
//      is no way to recover it, only to refuse. Default: throw.
//   1. decision gate — Cedar hands the three states over directly
//      (`'allow' | 'deny' | null`). Nothing is inferred from the residuals.
//   2. partition by effect, read from the residual policy's own `effect` field.
//   3. normalise each policy's `conditions` (fold, flatten, recover `>`/`>=`).
//   4. translate against the pushdown table, tracking polarity.
//   5. assemble `OR(permits) AND NOT(OR(forbids))`.
//   6. simplify, then re-derive ALWAYS_ALLOW / ALWAYS_DENY if it bottoms out —
//      belt and braces on top of Cedar's own `decision`.
//
// Residual ids are iterated in sorted order throughout, so two identical policy
// sets always compile to the identical tree. A plan that differed by hash-map
// iteration order would make every structural assertion in the test suite (and
// every driver's query cache) non-deterministic.

import type { PolicyJson, ResidualResponse } from "../cedar/binding.ts";
import { ErroredPolicyError } from "../diagnostics/errors.ts";
import { erroredPolicyApproximation, resolveUnsupportedResidual } from "./approximation.ts";
import { clausesToExpr, normalizeExpr } from "./expr-normalize.ts";
import { translateExpr, type PlanTarget } from "./expr-to-plan.ts";
import { PLAN_FALSE, PLAN_TRUE, planAnd, planNot, planOr, simplifyPlanNode } from "./plan-node.ts";
import type {
	OnErroredPolicy,
	PlanApproximation,
	PlanNode,
	QueryPlan,
	UnsupportedResidualPolicy,
} from "./plan.ts";

/** Everything {@link compileResiduals} needs beyond the Cedar response. */
export interface CompileResidualsOptions {
	/** Vocabulary-local resource type being planned over. */
	readonly resourceType: string;
	/** Cedar namespace, stripped from entity types in the compiled values. */
	readonly namespace: string;
	/** Scope being planned in. Diagnostics only. */
	readonly scope: string;
	/** Action being planned for. Diagnostics only. */
	readonly action: string;
	/** What to do about a widening approximation. Default `'error'` upstream. */
	readonly unsupportedResidual: UnsupportedResidualPolicy;
	/** What to do about Cedar's `errored[]`. Default `'error'` upstream. */
	readonly onErroredPolicy: OnErroredPolicy;
}

/** The plan body, before the engine attaches diagnostics and a post-filter. */
export interface CompiledPlan {
	readonly kind: QueryPlan<string>["kind"];
	/** `PLAN_TRUE` for ALWAYS_ALLOW, `PLAN_FALSE` for ALWAYS_DENY. */
	readonly condition: PlanNode;
	readonly approximations: readonly PlanApproximation[];
	/** `true` when at least one subterm resolved to `'post-filter'`. */
	readonly postFilter: boolean;
	/** Cedar's `nontrivialResiduals`. */
	readonly residualPolicyIds: readonly string[];
	/** Cedar's `errored`. */
	readonly erroredPolicyIds: readonly string[];
}

function sortedEntries(
	residuals: Readonly<Record<string, PolicyJson>>,
): readonly [string, PolicyJson][] {
	return Object.entries(residuals).toSorted(([left], [right]) =>
		left < right ? -1 : left > right ? 1 : 0,
	);
}

/**
 * Compiles a partial-evaluation response into the three-state plan.
 *
 * @throws {@link ErroredPolicyError} when Cedar reported errored policies and
 * `onErroredPolicy` is `'error'` (the default).
 * @throws `PermissionsError` with code `UNSUPPORTED_RESIDUAL` when a subterm
 * cannot be pushed down and dropping it would widen the result.
 */
export function compileResiduals(
	response: ResidualResponse,
	options: CompileResidualsOptions,
): CompiledPlan {
	const residualPolicyIds = Object.freeze([...response.nontrivialResiduals]);
	const erroredPolicyIds = Object.freeze([...response.errored]);
	const erroredApproximations = erroredPolicyIds.map((policyId) =>
		erroredPolicyApproximation(
			policyId,
			response.residuals[policyId]?.effect ?? "forbid",
			// Cedar replaced the whole policy body; `false` is the residual it left.
			{ Value: false },
		),
	);

	if (erroredPolicyIds.length > 0) {
		if (options.onErroredPolicy === "error") {
			throw new ErroredPolicyError(erroredMessage(erroredApproximations, options), {
				policyIds: erroredPolicyIds,
				scope: options.scope,
			});
		}
		if (options.onErroredPolicy === "deny-all") {
			return {
				kind: "ALWAYS_DENY",
				condition: PLAN_FALSE,
				approximations: Object.freeze(erroredApproximations),
				postFilter: false,
				residualPolicyIds,
				erroredPolicyIds,
			};
		}
		// `'ignore'`: fall through and compile what is left. Documented as unsafe,
		// and the approximations below are what makes the damage auditable.
	}

	if (response.decision !== null) {
		return {
			kind: response.decision === "allow" ? "ALWAYS_ALLOW" : "ALWAYS_DENY",
			condition: response.decision === "allow" ? PLAN_TRUE : PLAN_FALSE,
			approximations: Object.freeze(erroredApproximations),
			postFilter: false,
			residualPolicyIds,
			erroredPolicyIds,
		};
	}

	const target: PlanTarget = {
		unknownVar: "resource",
		resourceType: options.resourceType,
		namespace: options.namespace,
	};

	const approximations: PlanApproximation[] = [...erroredApproximations];
	let postFilter = false;

	const permits: PlanNode[] = [];
	const forbids: PlanNode[] = [];

	for (const [policyId, residual] of sortedEntries(response.residuals)) {
		// Errored policies are already `{"Value":false}`; compiling them adds a
		// `false` branch that simplification drops. Recording them twice would be
		// noise, so they are skipped here and accounted for above.
		if (erroredPolicyIds.includes(policyId)) {
			continue;
		}

		const body = normalizeExpr(clausesToExpr(residual.conditions));

		const node = translateExpr(body, 1, {
			target,
			onUnsupported: (subterm) => {
				const resolution = resolveUnsupportedResidual({
					policyId,
					effect: residual.effect,
					reason: subterm.reason,
					expr: subterm.expr,
					polarity: subterm.polarity,
					scope: options.scope,
					action: options.action,
					resourceType: options.resourceType,
					policy: options.unsupportedResidual,
				});

				approximations.push(resolution.approximation);
				postFilter ||= resolution.postFilter;
				return resolution.node;
			},
		});

		(residual.effect === "permit" ? permits : forbids).push(node);
	}

	// `or([])` is `false` and `not(or([]))` is `true`, which is exactly right:
	// no permits means nothing is allowed, no forbids means nothing is blocked.
	const assembled = planAnd([planOr(permits), planNot(planOr(forbids))]);
	const condition = simplifyPlanNode(assembled, { resourceType: options.resourceType });

	if (condition.op === "true" && !postFilter) {
		return {
			kind: "ALWAYS_ALLOW",
			condition: PLAN_TRUE,
			approximations: Object.freeze(approximations),
			postFilter: false,
			residualPolicyIds,
			erroredPolicyIds,
		};
	}
	if (condition.op === "false") {
		return {
			kind: "ALWAYS_DENY",
			condition: PLAN_FALSE,
			approximations: Object.freeze(approximations),
			// A plan that selects nothing has nothing to post-filter.
			postFilter: false,
			residualPolicyIds,
			erroredPolicyIds,
		};
	}

	// Note what the `!postFilter` guard above buys: a widened plan whose condition
	// bottomed out at `true` stays **CONDITIONAL**, because `ALWAYS_ALLOW` has no
	// `postFilter` field and downgrading to it would drop the only thing making
	// the plan sound. "Select everything, then re-check" is the honest shape.
	return {
		kind: "CONDITIONAL",
		condition,
		approximations: Object.freeze(approximations),
		postFilter,
		residualPolicyIds,
		erroredPolicyIds,
	};
}

function erroredMessage(
	approximations: readonly PlanApproximation[],
	options: CompileResidualsOptions,
): string {
	const permissive = approximations.filter(
		(approximation) => approximation.direction === "permissive",
	);

	return (
		`Cannot build a query plan for "${options.action}" over ${options.resourceType} in scope ` +
		`"${options.scope}": Cedar reported ${String(approximations.length)} errored ` +
		`${approximations.length === 1 ? "policy" : "policies"} ` +
		`(${approximations.map((approximation) => `"${approximation.policyId}"`).join(", ")}). ` +
		`An errored policy is replaced by \`false\`, so ` +
		(permissive.length > 0
			? `${String(permissive.length)} forbid(s) have silently disappeared and the plan would ` +
				`return rows they were meant to hide. `
			: `the affected permits are absent from the plan. `) +
		`Fix the policies (validateOnLoad catches the usual cause: reading an optional attribute ` +
		`without a \`has\` guard), or set onErroredPolicy to 'deny-all'.`
	);
}
