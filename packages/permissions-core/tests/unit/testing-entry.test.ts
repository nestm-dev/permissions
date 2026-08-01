import { describe, expect, it } from "vitest";

/**
 * The `@nestm/permissions-core/testing` subpath.
 *
 * This file runs in its own vitest module graph — nothing here imports
 * `src/index.ts` — which is what makes the `__cedarLoaded()` probe below
 * meaningful. Driver packages import this entry from their own test files, and a
 * WASM edge here would instantiate 4.1 MiB of Cedar in every suite that only
 * wanted the reference interpreter.
 */

/** Everything the subpath publishes at runtime. Type-only exports are invisible here. */
const EXPECTED_TESTING_EXPORTS = [
	"CONFORMANCE_SCOPES",
	"FIXTURE_TIME",
	"FORBID_ALL",
	"PERMIT_ALL",
	"PlanEvaluationError",
	"TEMPLATE_BOTH_SLOTS",
	"TEMPLATE_PRINCIPAL_ONLY",
	"TEMPLATE_RESOURCE_ONLY",
	"TESTING_ENTRY_NAME",
	"evaluatePlanNode",
	"filterRowsByPlan",
	"matchLikeTokens",
	"policyRecordFixture",
	"runPolicyStoreConformanceSuite",
	"slotValues",
	"templateLinkFixture",
	"testVocabulary",
];

describe("@nestm/permissions-core/testing", () => {
	it("exports exactly the declared surface", async () => {
		const testingEntry = await import("../../src/testing.ts");

		expect(Object.keys(testingEntry).toSorted()).toEqual(EXPECTED_TESTING_EXPORTS.toSorted());
		expect(testingEntry.TESTING_ENTRY_NAME).toBe("@nestm/permissions-core/testing");
	});

	it("does not load the Cedar WASM", async () => {
		await import("../../src/testing.ts");

		// Reaching for the loader *after* the subpath has been imported: if the
		// subpath had pulled in the engine, this would already be `true`.
		const { __cedarLoaded } = await import("../../src/cedar/loader.ts");

		expect(__cedarLoaded()).toBe(false);
	});

	it("builds its vocabulary without Cedar (delta D3)", async () => {
		const { testVocabulary } = await import("../../src/testing.ts");
		const { __cedarLoaded } = await import("../../src/cedar/loader.ts");

		expect(testVocabulary.namespace).toBe("Test");
		expect(testVocabulary.actionNames).toEqual(["doc:read", "doc:write"]);
		expect(testVocabulary.entityTypeNames).toContain("Test::Doc");
		expect(__cedarLoaded()).toBe(false);
	});
});
