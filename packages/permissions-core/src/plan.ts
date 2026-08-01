// `@nestm/permissions-core/plan` — the ORM drivers' compile-time surface (D5).
//
// Everything reachable from this entry is **pure**: the plan AST types and the
// handful of total functions that operate on them. Importing it must never reach
// the Cedar WASM or the engine — a driver package that only needs to turn a
// `PlanNode` into SQL should not drag 4.1 MiB of WASM into its consumers'
// bundles, and `tests/unit/plan-entry.test.ts` asserts exactly that with the
// `__cedarLoaded()` probe.
//
// `likeTokensToPattern` lives here rather than in each driver for one reason:
// duplicated LIKE escaping across two packages is how exactly one of them ends
// up with a `%`-injection bug.

/** Entry identity. Exported so the built entry has real runtime output. */
export const PLAN_ENTRY_NAME = "@nestm/permissions-core/plan" as const;

// ---------------------------------------------------------------------------
// The AST and the plan
// ---------------------------------------------------------------------------

export type {
	AttrPath,
	AttrRoot,
	LikeToken,
	OnErroredPolicy,
	PlanApproximation,
	PlanApproximationDirection,
	PlanApproximationReason,
	PlanCmp,
	PlanDiagnostics,
	PlanNode,
	PlanValue,
	PlanValueKind,
	PostFilter,
	PostFilterOptions,
	QueryPlan,
	QueryPlanBase,
	UnsupportedResidualContext,
	UnsupportedResidualPolicy,
} from "./plan/plan.ts";

// ---------------------------------------------------------------------------
// Pure utilities
// ---------------------------------------------------------------------------

export {
	PLAN_FALSE,
	PLAN_TRUE,
	assertOrderable,
	formatAttrPath,
	formatLikePattern,
	formatPlanNode,
	formatPlanValue,
	likeTokensToPattern,
	planAnd,
	planNot,
	planOr,
	planValueKindOf,
	simplifyPlanNode,
	walkPlanNode,
	type LikePatternOptions,
	type PlanNodeVisitor,
	type PlanNodeVisitorResult,
	type SimplifyOptions,
} from "./plan/plan-node.ts";
