import { describe, expect, it } from "vitest";

/**
 * The `@nestm/permissions-core/plan` subpath (delta D5).
 *
 * This file runs in its own vitest module graph — nothing here imports
 * `src/index.ts` — which is what makes the `__cedarLoaded()` probe below
 * meaningful. The ORM drivers import this entry for their compile-time surface,
 * and a WASM edge here would put 4.1 MiB into every consumer's bundle.
 */

/** Everything the subpath publishes at runtime. Type-only exports are invisible here. */
const EXPECTED_PLAN_EXPORTS = [
	"PLAN_ENTRY_NAME",
	"PLAN_FALSE",
	"PLAN_TRUE",
	"assertOrderable",
	"formatAttrPath",
	"formatLikePattern",
	"formatPlanNode",
	"formatPlanValue",
	"likeTokensToPattern",
	"planAnd",
	"planNot",
	"planOr",
	"planValueKindOf",
	"simplifyPlanNode",
	"walkPlanNode",
];

describe("@nestm/permissions-core/plan", () => {
	it("exports exactly the declared surface", async () => {
		const planEntry = await import("../../src/plan.ts");

		expect(Object.keys(planEntry).toSorted()).toEqual(EXPECTED_PLAN_EXPORTS.toSorted());
		expect(planEntry.PLAN_ENTRY_NAME).toBe("@nestm/permissions-core/plan");
	});

	it("does not load the Cedar WASM", async () => {
		await import("../../src/plan.ts");

		// Reaching for the loader *after* the subpath has been imported: if the
		// subpath had pulled in the engine, this would already be `true`.
		const { __cedarLoaded } = await import("../../src/cedar/loader.ts");

		expect(__cedarLoaded()).toBe(false);
	});

	it("is usable end to end without the engine", async () => {
		const { likeTokensToPattern, simplifyPlanNode, walkPlanNode, planAnd, PLAN_TRUE } =
			await import("../../src/plan.ts");

		expect(
			likeTokensToPattern([{ literal: "50%" }, { wildcard: true }], { escapeChar: "\\" }),
		).toBe("50\\%%");
		expect(simplifyPlanNode(planAnd([PLAN_TRUE, PLAN_TRUE]))).toEqual(PLAN_TRUE);

		const ops: string[] = [];
		walkPlanNode(planAnd([PLAN_TRUE]), (node) => {
			ops.push(node.op);
		});
		expect(ops).toEqual(["and", "true"]);
	});
});
