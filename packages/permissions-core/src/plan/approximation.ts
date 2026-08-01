// Direction analysis — the one function in this package where a sign error is a
// CVE (core.md §5.5).
//
// The assembled condition is always `OR(permits) AND NOT(OR(forbids))`, and an
// untranslatable subterm is always replaced by `true`. Follow that substitution
// through the four cases:
//
//   permit, polarity +1   true widens OR(permits)          -> superset  -> PERMISSIVE (unsafe)
//   permit, polarity -1   !true = false narrows the permit -> subset    -> restrictive (safe)
//   forbid, polarity +1   true widens OR(forbids), NOT()   -> subset    -> restrictive (safe)
//   forbid, polarity -1   !true = false drops the forbid   -> superset  -> PERMISSIVE (unsafe)
//
// which is exactly "permissive iff the effect is `permit` and the polarity is
// positive, or the effect is `forbid` and the polarity is negative" — one XOR,
// written once, tested exhaustively.
//
// Replacing an untranslatable forbid subterm by `false` instead of `true` is the
// classic vulnerability this file exists to make impossible: `false` in a forbid
// at positive polarity deletes the forbid, and the plan hands back rows the
// engine would have denied.

import type { Expr } from "../cedar/binding.ts";
import { UnsupportedResidualError } from "../diagnostics/errors.ts";
import { PLAN_TRUE, formatPlanNode } from "./plan-node.ts";
import type {
	PlanApproximation,
	PlanApproximationDirection,
	PlanApproximationReason,
	PlanNode,
	UnsupportedResidualContext,
	UnsupportedResidualPolicy,
} from "./plan.ts";

/**
 * Which way replacing an untranslatable subterm with `true` moves the selected
 * row set.
 *
 * `polarity` is `+1` at even `not`-depth inside the policy's condition and `-1`
 * at odd depth (`unless` counts as one `not`). The result is `'permissive'`
 * exactly when the substitution would return rows `check()` denies.
 *
 * Pure, total, and the single source of truth for the fail-closed contract —
 * nothing else in this package is allowed to decide "this one is probably fine".
 */
export function approximationDirection(
	effect: "permit" | "forbid",
	polarity: 1 | -1,
): PlanApproximationDirection {
	const permitLike = effect === "permit";
	const positive = polarity === 1;
	return permitLike === positive ? "permissive" : "restrictive";
}

/**
 * Direction for a policy Cedar reported in `errored[]`.
 *
 * An errored policy is replaced by `{"Value": false}`, not by `true` — and
 * substituting `false` is substituting `true` at flipped polarity. So an errored
 * *forbid* is `permissive` (it vanishes, and the rows it hid come back) while an
 * errored *permit* is merely `restrictive`.
 */
export function erroredPolicyDirection(effect: "permit" | "forbid"): PlanApproximationDirection {
	return approximationDirection(effect, -1);
}

/** Human-readable one-liner per reason, used in approximations and thrown errors. */
const REASON_TEXT: Readonly<Record<PlanApproximationReason, string>> = {
	"nested-attribute":
		"reads an attribute through another entity, which needs a join the core cannot know about",
	arithmetic: "performs arithmetic on the row",
	"unknown-both-sides": "compares the row against itself",
	"extension-on-unknown": "applies an extension function to the row",
	"unsupported-operator": "uses an operator with no query equivalent",
	"unsupported-value": "compares against a value that cannot be bound as a parameter",
	"non-literal-hierarchy": "uses `in` with something other than one concrete entity",
	"entity-identity": "compares the row itself for equality, which no plan node expresses",
	"wrong-unknown-root": "leaves a different variable unknown than the one being planned over",
	"errored-policy": "errored during evaluation and Cedar replaced it with `false`",
	"unmapped-hierarchy": "needs a hierarchy mapping the driver was not given",
	other: "has no query equivalent",
};

/** What {@link resolveUnsupportedResidual} decided for one subterm. */
export interface UnsupportedResolution {
	/** Node to substitute for the offending subterm. */
	readonly node: PlanNode;
	/** The record to attach to the plan. Never omitted — an approximation is never silent. */
	readonly approximation: PlanApproximation;
	/** Whether the caller must attach `plan.postFilter`. */
	readonly postFilter: boolean;
}

/** Everything {@link resolveUnsupportedResidual} needs about one rejected subterm. */
export interface ResolveUnsupportedInput {
	readonly policyId: string;
	readonly effect: "permit" | "forbid";
	readonly reason: PlanApproximationReason;
	readonly expr: Expr;
	readonly polarity: 1 | -1;
	readonly scope: string;
	readonly action: string;
	readonly resourceType: string;
	/** The configured `unsupportedResidual` policy. */
	readonly policy: UnsupportedResidualPolicy;
}

/**
 * Applies the fail-closed contract to one untranslatable subterm.
 *
 * A `restrictive` approximation is taken unconditionally: over-blocking is safe,
 * so there is nothing for a caller to decide and no reason to make a plan fail
 * because of it. It is still recorded, with a message, because "you are seeing
 * fewer rows than the policy allows" is a support ticket waiting to happen.
 *
 * A `permissive` one consults {@link UnsupportedResidualPolicy}, whose default
 * is to throw.
 *
 * @throws {@link UnsupportedResidualError} when the policy resolves to `'error'`.
 */
export function resolveUnsupportedResidual(input: ResolveUnsupportedInput): UnsupportedResolution {
	const direction = approximationDirection(input.effect, input.polarity);

	if (direction === "restrictive") {
		return {
			node: PLAN_TRUE,
			approximation: approximationOf(input, direction, PLAN_TRUE),
			postFilter: false,
		};
	}

	const decision = decide(input, direction);

	if (decision === "error") {
		throw new UnsupportedResidualError(unsupportedMessage(input), {
			policyId: input.policyId,
			effect: input.effect,
			reason: input.reason,
			expr: input.expr,
			resourceType: input.resourceType,
			action: input.action,
			scope: input.scope,
		});
	}

	if (decision === "post-filter") {
		return {
			node: PLAN_TRUE,
			approximation: approximationOf(input, direction, PLAN_TRUE),
			postFilter: true,
		};
	}

	// A caller-supplied node. It may be `{ op: 'false' }` to drop the offending
	// permit entirely, or any narrowing the caller can justify — which is why it
	// is still recorded as an approximation rather than treated as exact.
	return {
		node: decision,
		approximation: approximationOf(input, direction, decision),
		postFilter: false,
	};
}

function decide(
	input: ResolveUnsupportedInput,
	direction: PlanApproximationDirection,
): PlanNode | "error" | "post-filter" {
	if (typeof input.policy !== "function") {
		return input.policy;
	}

	const context: UnsupportedResidualContext = {
		policyId: input.policyId,
		effect: input.effect,
		direction,
		reason: input.reason,
		expr: input.expr,
		polarity: input.polarity,
		scope: input.scope,
		action: input.action,
		resourceType: input.resourceType,
	};

	return input.policy(context);
}

function approximationOf(
	input: ResolveUnsupportedInput,
	direction: PlanApproximationDirection,
	node: PlanNode,
): PlanApproximation {
	return Object.freeze({
		policyId: input.policyId,
		effect: input.effect,
		direction,
		reason: input.reason,
		expr: input.expr,
		message:
			`${input.effect} "${input.policyId}" ${REASON_TEXT[input.reason]}; that subterm was ` +
			`replaced with \`${formatPlanNode(node)}\`, which makes the plan ` +
			`${direction === "restrictive" ? "return fewer rows than the policy allows" : "return rows the policy does not allow"}.`,
	});
}

/** The record for a policy Cedar reported in `errored[]`. */
export function erroredPolicyApproximation(
	policyId: string,
	effect: "permit" | "forbid",
	expr: Expr,
): PlanApproximation {
	const direction = erroredPolicyDirection(effect);
	return Object.freeze({
		policyId,
		effect,
		direction,
		reason: "errored-policy" as const,
		expr,
		message:
			`${effect} "${policyId}" ${REASON_TEXT["errored-policy"]}. ` +
			(direction === "permissive"
				? "The forbid is therefore absent from the plan and rows it was meant to hide will be returned."
				: "The permit is therefore absent from the plan and rows it would have allowed will be missing."),
	});
}

function unsupportedMessage(input: ResolveUnsupportedInput): string {
	return (
		`Cannot build a sound query plan for "${input.action}" over ${input.resourceType} in scope ` +
		`"${input.scope}": ${input.effect} "${input.policyId}" ${REASON_TEXT[input.reason]}. ` +
		`Dropping that subterm would widen the result, so the plan would return rows check() denies. ` +
		`Offending expression: ${JSON.stringify(input.expr)}. ` +
		`Rewrite the policy into a pushdown-able shape, or set unsupportedResidual to 'post-filter'.`
	);
}
