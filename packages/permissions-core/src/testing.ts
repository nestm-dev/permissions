// `@nestm/permissions-core/testing` — the oracles driver authors test against.
//
// Two things live here, and both exist because correctness in this package is
// only checkable *differentially*:
//
//   * `evaluatePlanNode` — the reference plan interpreter (core.md §5.7). A
//     driver runs its generated SQL over a fixture table, runs this over the same
//     rows, and asserts set equality. Without a shipped interpreter, "does this
//     WHERE clause select the rows Cedar authorizes?" has no answer short of
//     re-implementing Cedar.
//   * `runPolicyStoreConformanceSuite` — the `PolicyStore` SPI *is* the suite.
//     `MemoryPolicyStore`, the TypeORM store and the Drizzle store all run it, so
//     "conformant" means one thing rather than three.
//
// **No module-level Cedar import.** This entry is loaded by test files in
// packages that may never construct an engine, and `tests/unit/testing-entry.test.ts`
// asserts with the `__cedarLoaded()` probe that importing it does not instantiate
// the 4.1 MiB WASM. Anything needing the binding must `await import(...)` inside
// the helper that needs it.

/** Entry identity. Exported so the built entry has real runtime output. */
export const TESTING_ENTRY_NAME = "@nestm/permissions-core/testing" as const;

// ---------------------------------------------------------------------------
// The reference interpreter (core.md §5.7)
// ---------------------------------------------------------------------------

export {
	PlanEvaluationError,
	evaluatePlanNode,
	filterRowsByPlan,
	matchLikeTokens,
	type EvaluatePlanOptions,
	type HierarchyQuery,
	type HierarchyResolver,
	type PlanRow,
} from "./plan/evaluate-plan.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

export {
	CONFORMANCE_SCOPES,
	FIXTURE_TIME,
	FORBID_ALL,
	PERMIT_ALL,
	TEMPLATE_BOTH_SLOTS,
	TEMPLATE_PRINCIPAL_ONLY,
	TEMPLATE_RESOURCE_ONLY,
	policyRecordFixture,
	slotValues,
	templateLinkFixture,
	testVocabulary,
	type TestVocabulary,
} from "./testing/fixtures.ts";

// ---------------------------------------------------------------------------
// The shared PolicyStore conformance suite
// ---------------------------------------------------------------------------

export {
	runPolicyStoreConformanceSuite,
	type ConformanceAssertion,
	type ConformanceExpect,
	type ConformanceHooks,
	type ConformanceStore,
	type ConformanceStoreFactory,
} from "./testing/policy-store-conformance.ts";
