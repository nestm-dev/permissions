// The neutral query-plan AST and the three-state plan (core.md §5.1–5.2).
//
// Everything in this file is a *type*. It has no runtime imports at all, which
// is what lets the `@nestm/permissions-core/plan` subpath be loaded by an ORM
// driver without dragging in the engine or the 4.1 MiB Cedar WASM.
//
// Two shapes here are load-bearing for security and are worth stating plainly:
//
//   * `like` carries **tokens**, never a rendered string. Cedar hands us
//     `[{Literal:"a"},"Wildcard",{Literal:"%"}]`; re-serialising that to a
//     pattern is how a literal `%` in a policy turns into a wildcard in SQL.
//     Drivers render tokens themselves with `likeTokensToPattern`.
//   * `cmp.value` is a typed `PlanValue`, never `unknown`. A driver must bind it
//     as a parameter; there is no shape here that invites interpolation.

import type { Expr } from "../cedar/binding.ts";
import type { EntityRef } from "../cedar/uid.ts";

// ---------------------------------------------------------------------------
// Attribute paths
// ---------------------------------------------------------------------------

/** Which unknown an {@link AttrPath} is rooted at. */
export type AttrRoot = "resource" | "principal";

/**
 * A path from an unknown to one of its attributes.
 *
 * `path` always has **exactly one** element in anything this package compiles:
 * depth 1 is "a column of the row being filtered". Nested access
 * (`resource.owner.dept`) needs a join the core cannot know about and is
 * rejected at compile time, not represented here.
 */
export interface AttrPath {
	/** The unknown the path starts from. */
	readonly root: AttrRoot;
	/** Attribute names, outermost first. Length 1 for every compiled plan. */
	readonly path: readonly string[];
}

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

/** Discriminant of a {@link PlanValue}. */
export type PlanValueKind =
	"string" | "long" | "bool" | "entity" | "datetime" | "duration" | "decimal" | "ipaddr" | "set";

/**
 * A constant on the non-unknown side of a comparison.
 *
 * Typed rather than `unknown` so a driver has to decide how to *bind* each kind
 * — there is deliberately no `toString()` that would let one interpolate.
 *
 * `long` carries `bigint` because Cedar longs are i64 and JavaScript numbers are
 * not. Note the caveat in `expr-to-plan.ts`: the residual crosses the WASM
 * boundary as JSON, so a magnitude above `Number.MAX_SAFE_INTEGER` has already
 * lost precision before this package sees it.
 *
 * `decimal` and `ipaddr` carry the **Cedar literal text** (`"1.5"`,
 * `"10.0.0.0/8"`). Neither has a lossless JavaScript representation, and a
 * driver binds them to a `NUMERIC`/`INET` column as text anyway.
 */
export type PlanValue =
	| { readonly kind: "string"; readonly value: string }
	| { readonly kind: "long"; readonly value: bigint }
	| { readonly kind: "bool"; readonly value: boolean }
	| { readonly kind: "entity"; readonly value: EntityRef<string> }
	| { readonly kind: "datetime"; readonly value: Date }
	/** Milliseconds. Cedar durations are signed. */
	| { readonly kind: "duration"; readonly value: number }
	/** Cedar `decimal(...)` literal text, e.g. `"1.5"`. */
	| { readonly kind: "decimal"; readonly value: string }
	/** Cedar `ip(...)` literal text, e.g. `"10.0.0.0/8"`. */
	| { readonly kind: "ipaddr"; readonly value: string }
	| { readonly kind: "set"; readonly value: readonly PlanValue[] };

/**
 * One element of a Cedar `like` pattern, exactly as Cedar tokenises it.
 *
 * `{ literal: "*" }` is a *literal asterisk* (the policy wrote `\*`);
 * `{ wildcard: true }` is the wildcard. A `%` or `_` can only ever appear inside
 * `literal`, which is precisely why the tokens must survive into the driver.
 */
export type LikeToken = { readonly literal: string } | { readonly wildcard: true };

// ---------------------------------------------------------------------------
// The AST
// ---------------------------------------------------------------------------

/** Comparison operators a {@link PlanNode} of op `cmp` can carry. */
export type PlanCmp = "eq" | "ne" | "lt" | "lte" | "gt" | "gte";

/**
 * The neutral condition AST a driver compiles into a `WHERE` clause.
 *
 * Thirteen ops, all structurally cloneable, all `readonly`. A driver that cannot
 * map one **must throw**: there is no configuration in which an uncompilable
 * node becomes `TRUE`.
 */
export type PlanNode =
	/** Matches every row. */
	| { readonly op: "true" }
	/** Matches no row. */
	| { readonly op: "false" }
	| { readonly op: "and"; readonly nodes: readonly PlanNode[] }
	| { readonly op: "or"; readonly nodes: readonly PlanNode[] }
	| { readonly op: "not"; readonly node: PlanNode }
	/** `attr <cmp> value`. */
	| {
			readonly op: "cmp";
			readonly cmp: PlanCmp;
			readonly attr: AttrPath;
			readonly value: PlanValue;
	  }
	/** `attr IN (…values)` — Cedar `[…].contains(attr)`. */
	| { readonly op: "in"; readonly attr: AttrPath; readonly values: readonly PlanValue[] }
	/** The set-valued `attr` contains `value` — Cedar `attr.contains(v)`. */
	| { readonly op: "contains"; readonly attr: AttrPath; readonly value: PlanValue }
	/** `attr LIKE pattern`, pattern carried as tokens. */
	| { readonly op: "like"; readonly attr: AttrPath; readonly pattern: readonly LikeToken[] }
	/** The optional `attr` is present — Cedar `resource has attr`. */
	| { readonly op: "exists"; readonly attr: AttrPath }
	/** The set-valued `attr` is empty. */
	| { readonly op: "isEmpty"; readonly attr: AttrPath }
	/** The row's entity type is `entityType` (vocabulary-local, unqualified). */
	| { readonly op: "isType"; readonly entityType: string }
	/**
	 * Cedar `in`: `attr` (or the row itself, when `attr` is `null`) is a
	 * descendant-or-self of `parent`.
	 *
	 * **Reflexive.** `Project::"p" in Project::"p"` is true, so a driver's `self`
	 * mapping compiles to `id = $p`, not to a strict ancestor lookup. Getting that
	 * wrong is a silent over-block. A driver with no hierarchy mapping for this
	 * node must fail closed — never `TRUE`.
	 */
	| {
			readonly op: "inHierarchy";
			readonly attr: AttrPath | null;
			readonly parent: EntityRef<string>;
	  };

// ---------------------------------------------------------------------------
// Approximations
// ---------------------------------------------------------------------------

/**
 * Which way an approximation moves the selected row set.
 *
 * `restrictive` = subset of the authorized rows (over-blocks; safe).
 * `permissive` = superset (over-shares; **unsafe**, never silent).
 */
export type PlanApproximationDirection = "permissive" | "restrictive";

/**
 * Why a residual sub-expression could not be pushed down.
 *
 * core.md §5.5 names seven; the four extra members below are refinements this
 * implementation can distinguish and that make the thrown error actionable.
 * `unmapped-hierarchy` is not produced here — it is reserved for the ORM
 * drivers, which raise it when an `inHierarchy` node has no mapping.
 */
export type PlanApproximationReason =
	/** `resource.owner.dept` — needs a join the core cannot know about. */
	| "nested-attribute"
	/** `+`, `-`, `*`, unary negation. */
	| "arithmetic"
	/** Both operands of a binary op reach into the unknown. */
	| "unknown-both-sides"
	/** An extension function applied to the unknown, e.g. `ip(resource.addr).isInRange(…)`. */
	| "extension-on-unknown"
	/** `containsAll`, `containsAny`, `getTag`, `hasTag`, or a bare `Var`/`Slot`. */
	| "unsupported-operator"
	/** A `Record` literal, or an extension literal whose text does not parse. */
	| "unsupported-value"
	/** An `in` whose right side is not a concrete entity literal. */
	| "non-literal-hierarchy"
	/** `resource == SomeType::"id"` — row identity, which no `PlanNode` expresses. */
	| "entity-identity"
	/** `unknown("principal")` met while planning over resources, or vice versa. */
	| "wrong-unknown-root"
	/** The policy errored during evaluation and Cedar replaced it with `false`. */
	| "errored-policy"
	/** Reserved for the ORM drivers: an `inHierarchy` node with no mapping. */
	| "unmapped-hierarchy"
	| "other";

/** One recorded departure from an exact plan. Never silent. */
export interface PlanApproximation {
	/** Id of the policy (or template link) the subterm came from. */
	readonly policyId: string;
	/** Effect of that policy. */
	readonly effect: "permit" | "forbid";
	/** Which way the row set moved. */
	readonly direction: PlanApproximationDirection;
	/** Why the subterm could not be translated. */
	readonly reason: PlanApproximationReason;
	/** The offending Cedar sub-expression, verbatim, for the audit log. */
	readonly expr: Expr;
	/** Human-readable one-liner, suitable for a log or a warning banner. */
	readonly message: string;
}

// ---------------------------------------------------------------------------
// The fail-closed policy
// ---------------------------------------------------------------------------

/** Everything the `unsupportedResidual` callback is told about a permissive approximation. */
export interface UnsupportedResidualContext {
	/** Id of the policy (or template link) the subterm came from. */
	readonly policyId: string;
	/** Effect of that policy. */
	readonly effect: "permit" | "forbid";
	/** Always `'permissive'` — the callback is only consulted for unsafe widenings. */
	readonly direction: PlanApproximationDirection;
	/** Why the subterm could not be translated. */
	readonly reason: PlanApproximationReason;
	/** The offending Cedar sub-expression. */
	readonly expr: Expr;
	/** `1` at even `not`-depth, `-1` at odd. */
	readonly polarity: 1 | -1;
	/** Scope being planned in. */
	readonly scope: string;
	/** Action being planned for. */
	readonly action: string;
	/** Resource type being planned over. */
	readonly resourceType: string;
}

/**
 * What to do when a subterm cannot be pushed down and dropping it would
 * **widen** the selected row set.
 *
 * The default is `'error'`, and that is the whole point: an unsound plan is a
 * data leak, so the library refuses to return one unless the caller has
 * explicitly chosen a slower-but-correct alternative.
 *
 * - `'error'` — throw `UnsupportedResidualError`.
 * - `'post-filter'` — widen the permit to `true` and attach `plan.postFilter`,
 *   which re-checks each returned row through `checkMany`. Correct, `O(n)`, and
 *   it breaks database-side pagination. A migration aid, not a steady state.
 * - a function — decide per subterm. Returning a `PlanNode` substitutes it
 *   verbatim (return `{ op: 'false' }` to drop the offending permit entirely);
 *   returning `'error'`/`'post-filter'` behaves as above.
 */
export type UnsupportedResidualPolicy =
	| "error"
	| "post-filter"
	| ((context: UnsupportedResidualContext) => PlanNode | "error" | "post-filter");

/**
 * What to do when Cedar reports policies that **errored** during partial
 * evaluation.
 *
 * An errored policy gets a `{"Value": false}` residual (verified against
 * cedar-wasm 4.12.0), so an errored `forbid` silently *disappears* from the
 * compiled condition. That is the sharpest security edge in the whole feature.
 *
 * - `'error'` — **default.** Throw `ErroredPolicyError`.
 * - `'deny-all'` — return `ALWAYS_DENY`. Fail-closed and available.
 * - `'ignore'` — compile anyway. **Unsafe**: an errored `forbid` will not appear
 *   in the plan and rows it was meant to hide will be returned.
 */
export type OnErroredPolicy = "error" | "deny-all" | "ignore";

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

/** Post-filter mapping for one call. */
export interface PostFilterOptions<Row> {
	/** Maps a row to the entity reference `check()` should be asked about. */
	readonly rowToResource: (row: Row, index: number) => EntityRef<string>;
	/** Overrides the engine's `maxPostFilterRows` for this call. */
	readonly maxRows?: number;
}

/**
 * Re-checks rows the widened plan may have over-selected and drops the ones
 * that are not allowed.
 *
 * @throws `PermissionsError` with code `POST_FILTER_OVERFLOW` when `rows` is
 * longer than the configured cap — melting the database is not a fallback.
 */
export type PostFilter = <Row>(
	rows: readonly Row[],
	options: PostFilterOptions<Row>,
) => Promise<Row[]>;

/** Diagnostics attached to every {@link QueryPlan}. */
export interface PlanDiagnostics {
	/** Policies Cedar left a non-trivial residual for. */
	readonly residualPolicyIds: readonly string[];
	/** Policies that errored during partial evaluation. */
	readonly erroredPolicyIds: readonly string[];
	/** Version of the policy bundle the plan was compiled from. */
	readonly policySetVersion: string;
	/** Whether the plan came from the plan cache. */
	readonly cache: "hit" | "miss";
	/** Wall time spent, measured with the engine's configured `clock`. */
	readonly durationMs: number;
	/** Multi-line human-readable rendering: request, kind, condition, approximations. */
	explain(): string;
}

/** Fields every arm of {@link QueryPlan} carries. */
export interface QueryPlanBase<R extends string> {
	/** Resource type the plan filters. Present on every arm so a driver can assert its mapping. */
	readonly resourceType: R;
	/** Recorded departures from an exact plan. Empty for an exact plan. */
	readonly approximations: readonly PlanApproximation[];
	/** Provenance and timing. */
	readonly diagnostics: PlanDiagnostics;
}

/**
 * The three-state plan.
 *
 * Cedar hands the three states over directly — `decision: 'allow' | 'deny' |
 * null` — so nothing here is inferred. A `CONDITIONAL` plan's `condition` is
 * **sound**: the row set it selects equals the set of rows for which `check()`
 * would return `allow`, unless `approximations` is non-empty, in which case
 * every entry is a recorded, directional departure.
 */
export type QueryPlan<R extends string = string> =
	| (QueryPlanBase<R> & { readonly kind: "ALWAYS_ALLOW" })
	| (QueryPlanBase<R> & { readonly kind: "ALWAYS_DENY" })
	| (QueryPlanBase<R> & {
			readonly kind: "CONDITIONAL";
			/** The filter to push into the query. */
			readonly condition: PlanNode;
			/**
			 * Present only when `unsupportedResidual` resolved to `'post-filter'`.
			 * The rows the widened `condition` returns **must** be passed through it.
			 */
			readonly postFilter?: PostFilter;
	  });
