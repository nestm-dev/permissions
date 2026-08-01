import { describe, expect, it } from "vitest";

import type { Clause, Expr } from "../../src/cedar/binding.ts";
import {
	EXPR_FALSE,
	EXPR_TRUE,
	clauseToExpr,
	clausesToExpr,
	containsUnknown,
	flattenConjuncts,
	flattenDisjuncts,
	isBooleanLiteral,
	normalizeExpr,
	unknownVarOf,
	viewExpr,
} from "../../src/plan/expr-normalize.ts";

/** The verified unknown marker: an *extension call*, not an operator. */
const UNKNOWN: Expr = { unknown: [{ Value: "resource" }] };
const UNKNOWN_PRINCIPAL: Expr = { unknown: [{ Value: "principal" }] };

/** `resource.<name>` as partial evaluation emits it. */
function attr(name: string, base: Expr = UNKNOWN): Expr {
	return { ".": { left: base, attr: name } };
}

const STATUS_IS_DONE: Expr = { "==": { left: attr("status"), right: { Value: "done" } } };

/** `then` is Cedar's own key for the branch; the object is an `Expr`, never awaited. */
function ite(condition: Expr, whenTrue: Expr, whenFalse: Expr): Expr {
	// oxlint-disable-next-line unicorn/no-thenable -- see above
	return { "if-then-else": { if: condition, then: whenTrue, else: whenFalse } };
}

describe("viewExpr", () => {
	it("recognises the unknown marker as an extension call, not an operator", () => {
		expect(viewExpr(UNKNOWN)).toEqual({
			node: "ext",
			fn: "unknown",
			args: [{ Value: "resource" }],
		});
		expect(unknownVarOf(UNKNOWN)).toBe("resource");
		expect(unknownVarOf(UNKNOWN_PRINCIPAL)).toBe("principal");
		expect(unknownVarOf(STATUS_IS_DONE)).toBeUndefined();
	});

	it("narrows every arm of the residual grammar", () => {
		expect(viewExpr({ Value: 1 })).toEqual({ node: "value", value: 1 });
		expect(viewExpr({ Var: "principal" })).toEqual({ node: "var", variable: "principal" });
		expect(viewExpr({ Slot: "?resource" })).toEqual({ node: "slot", slot: "?resource" });
		expect(viewExpr({ "!": { arg: EXPR_TRUE } })).toEqual({
			node: "unary",
			op: "!",
			arg: EXPR_TRUE,
		});
		expect(viewExpr({ isEmpty: { arg: attr("labels") } })).toMatchObject({
			node: "unary",
			op: "isEmpty",
		});
		expect(viewExpr(STATUS_IS_DONE)).toMatchObject({ node: "binary", op: "==" });
		expect(viewExpr(attr("status"))).toEqual({ node: "attr", left: UNKNOWN, attr: "status" });
		expect(viewExpr({ has: { left: UNKNOWN, attr: "startedAt" } })).toEqual({
			node: "has",
			left: UNKNOWN,
			attrs: ["startedAt"],
		});
		expect(viewExpr({ has: { left: UNKNOWN, attr: ["a", "b"] } })).toMatchObject({
			node: "has",
			attrs: ["a", "b"],
		});
		expect(viewExpr({ like: { left: attr("status"), pattern: ["Wildcard"] } })).toMatchObject({
			node: "like",
		});
		expect(viewExpr({ is: { left: UNKNOWN, entity_type: "Station::Run" } })).toEqual({
			node: "is",
			left: UNKNOWN,
			entityType: "Station::Run",
			in: undefined,
		});
		expect(viewExpr(ite(EXPR_TRUE, EXPR_FALSE, EXPR_TRUE))).toMatchObject({ node: "ite" });
		expect(viewExpr({ Set: [{ Value: "a" }] })).toEqual({
			node: "set",
			elements: [{ Value: "a" }],
		});
		expect(viewExpr({ Record: { kind: { Value: "manual" } } })).toMatchObject({ node: "record" });
		expect(viewExpr({ datetime: [{ Value: "2026-01-01" }] })).toMatchObject({
			node: "ext",
			fn: "datetime",
		});
	});

	it("reports anything structurally unexpected as unrecognised rather than guessing", () => {
		expect(viewExpr({} as Expr)).toEqual({ node: "unrecognised" });
		expect(viewExpr({ "==": { left: EXPR_TRUE } } as unknown as Expr)).toEqual({
			node: "unrecognised",
		});
		expect(viewExpr({ a: 1, b: 2 } as unknown as Expr)).toEqual({ node: "unrecognised" });
	});
});

describe("containsUnknown", () => {
	it("finds the marker at any depth", () => {
		expect(containsUnknown(STATUS_IS_DONE)).toBe(true);
		expect(containsUnknown({ Set: [{ Value: "a" }, attr("status")] })).toBe(true);
		expect(containsUnknown({ toDate: [attr("startedAt")] })).toBe(true);
		expect(containsUnknown({ Record: { k: attr("status") } })).toBe(true);
		expect(containsUnknown({ Value: "done" })).toBe(false);
		expect(containsUnknown({ datetime: [{ Value: "2026-01-01" }] })).toBe(false);
	});
});

describe("normalizeExpr — constant folding", () => {
	// Cedar wraps every residual in `{"Value":true} && …`, one level per
	// folded-away scope constraint. Three levels is what the station fixture
	// actually produces.
	it("strips the true-prefix chain a residual arrives wrapped in", () => {
		const residual: Expr = {
			"&&": {
				left: EXPR_TRUE,
				right: {
					"&&": { left: EXPR_TRUE, right: { "&&": { left: EXPR_TRUE, right: STATUS_IS_DONE } } },
				},
			},
		};

		expect(normalizeExpr(residual)).toEqual(STATUS_IS_DONE);
	});

	it.each([
		["true && X", { "&&": { left: EXPR_TRUE, right: STATUS_IS_DONE } }, STATUS_IS_DONE],
		["X && true", { "&&": { left: STATUS_IS_DONE, right: EXPR_TRUE } }, STATUS_IS_DONE],
		["false && X", { "&&": { left: EXPR_FALSE, right: STATUS_IS_DONE } }, EXPR_FALSE],
		["X && false", { "&&": { left: STATUS_IS_DONE, right: EXPR_FALSE } }, EXPR_FALSE],
		["true || X", { "||": { left: EXPR_TRUE, right: STATUS_IS_DONE } }, EXPR_TRUE],
		["X || true", { "||": { left: STATUS_IS_DONE, right: EXPR_TRUE } }, EXPR_TRUE],
		["false || X", { "||": { left: EXPR_FALSE, right: STATUS_IS_DONE } }, STATUS_IS_DONE],
		["X || false", { "||": { left: STATUS_IS_DONE, right: EXPR_FALSE } }, STATUS_IS_DONE],
		["!true", { "!": { arg: EXPR_TRUE } }, EXPR_FALSE],
		["!false", { "!": { arg: EXPR_FALSE } }, EXPR_TRUE],
	])("folds %s", (_label, input, expected) => {
		expect(normalizeExpr(input as Expr)).toEqual(expected);
	});

	it("folds bottom-up, so a nested constant collapses the whole tree", () => {
		const residual: Expr = {
			"&&": {
				left: { "||": { left: EXPR_FALSE, right: EXPR_TRUE } },
				right: { "!": { arg: { "!": { arg: EXPR_FALSE } } } },
			},
		};

		expect(normalizeExpr(residual)).toEqual(EXPR_FALSE);
	});
});

describe("normalizeExpr — negation pushdown", () => {
	// core.md §0 finding 19: `>` is only ever emitted as `!(x <= k)` and `>=` as
	// `!(x < k)`. Without this rewrite no plan would ever contain `gt`/`gte`.
	it.each([
		["!(x <= k) => x > k", "<=", ">"],
		["!(x < k) => x >= k", "<", ">="],
		["!(x > k) => x <= k", ">", "<="],
		["!(x >= k) => x < k", ">=", "<"],
	] as const)("recovers %s", (_label, from, to) => {
		const negated: Expr = {
			"!": { arg: { [from]: { left: attr("attempt"), right: { Value: 5 } } } as Expr },
		};

		expect(normalizeExpr(negated)).toEqual({
			[to]: { left: attr("attempt"), right: { Value: 5 } },
		});
	});

	it("eliminates double negation", () => {
		expect(normalizeExpr({ "!": { arg: { "!": { arg: STATUS_IS_DONE } } } })).toEqual(
			STATUS_IS_DONE,
		);
	});

	it("leaves `!(==)` alone — recovering `!=` there would move the subterm across a `not`", () => {
		// Polarity is what decides whether an approximation is safe, so the
		// normaliser must not change `not`-depth. `simplifyPlanNode` recovers `ne`
		// later, once polarity no longer matters.
		expect(normalizeExpr({ "!": { arg: STATUS_IS_DONE } })).toEqual({
			"!": { arg: STATUS_IS_DONE },
		});
	});

	it("does not apply De Morgan to `&&`/`||`, for the same reason", () => {
		const negatedConjunction: Expr = {
			"!": { arg: { "&&": { left: STATUS_IS_DONE, right: STATUS_IS_DONE } } },
		};

		expect(normalizeExpr(negatedConjunction)).toEqual(negatedConjunction);
	});
});

describe("normalizeExpr — structure", () => {
	it("folds a constant if-then-else to the taken branch", () => {
		expect(normalizeExpr(ite(EXPR_TRUE, STATUS_IS_DONE, EXPR_FALSE))).toEqual(STATUS_IS_DONE);
		expect(normalizeExpr(ite(EXPR_FALSE, EXPR_FALSE, STATUS_IS_DONE))).toEqual(STATUS_IS_DONE);
	});

	it("recurses through sets, records, extension calls and `is ... in`", () => {
		expect(normalizeExpr({ Set: [{ "&&": { left: EXPR_TRUE, right: STATUS_IS_DONE } }] })).toEqual({
			Set: [STATUS_IS_DONE],
		});
		expect(
			normalizeExpr({ Record: { k: { "||": { left: EXPR_FALSE, right: STATUS_IS_DONE } } } }),
		).toEqual({ Record: { k: STATUS_IS_DONE } });
		expect(
			normalizeExpr({ toDate: [{ "&&": { left: EXPR_TRUE, right: attr("startedAt") } }] }),
		).toEqual({ toDate: [attr("startedAt")] });
		expect(
			normalizeExpr({
				is: {
					left: UNKNOWN,
					entity_type: "Station::Run",
					in: { "&&": { left: EXPR_TRUE, right: { Value: { __entity: { type: "P", id: "p" } } } } },
				},
			}),
		).toEqual({
			is: {
				left: UNKNOWN,
				entity_type: "Station::Run",
				in: { Value: { __entity: { type: "P", id: "p" } } },
			},
		});
	});

	it("leaves the unknown marker's argument untouched", () => {
		expect(normalizeExpr(UNKNOWN)).toBe(UNKNOWN);
	});
});

describe("flattening", () => {
	it("flattens a right-nested && chain in source order", () => {
		const chain: Expr = {
			"&&": { left: { Value: 1 }, right: { "&&": { left: { Value: 2 }, right: { Value: 3 } } } },
		};

		expect(flattenConjuncts(chain)).toEqual([{ Value: 1 }, { Value: 2 }, { Value: 3 }]);
	});

	it("flattens a left-nested && chain too", () => {
		const chain: Expr = {
			"&&": { left: { "&&": { left: { Value: 1 }, right: { Value: 2 } } }, right: { Value: 3 } },
		};

		expect(flattenConjuncts(chain)).toEqual([{ Value: 1 }, { Value: 2 }, { Value: 3 }]);
	});

	it("does not flatten across the other operator", () => {
		const mixed: Expr = {
			"&&": { left: { "||": { left: { Value: 1 }, right: { Value: 2 } } }, right: { Value: 3 } },
		};

		expect(flattenConjuncts(mixed)).toEqual([
			{ "||": { left: { Value: 1 }, right: { Value: 2 } } },
			{ Value: 3 },
		]);
		expect(flattenDisjuncts(mixed)).toEqual([mixed]);
	});

	it("returns a single-element list for a leaf", () => {
		expect(flattenConjuncts(STATUS_IS_DONE)).toEqual([STATUS_IS_DONE]);
		expect(flattenDisjuncts(STATUS_IS_DONE)).toEqual([STATUS_IS_DONE]);
	});
});

describe("clauses", () => {
	it("reads `when` as the body and `unless` as its negation", () => {
		const when: Clause = { kind: "when", body: STATUS_IS_DONE };
		const unless: Clause = { kind: "unless", body: STATUS_IS_DONE };

		expect(clauseToExpr(when)).toEqual(STATUS_IS_DONE);
		expect(clauseToExpr(unless)).toEqual({ "!": { arg: STATUS_IS_DONE } });
	});

	it("&&s multiple clauses and treats none as `true`", () => {
		expect(clausesToExpr([])).toEqual(EXPR_TRUE);
		expect(
			clausesToExpr([
				{ kind: "when", body: { Value: 1 } },
				{ kind: "unless", body: { Value: 2 } },
			]),
		).toEqual({
			"&&": { left: { Value: 1 }, right: { "!": { arg: { Value: 2 } } } },
		});
	});
});

describe("isBooleanLiteral", () => {
	it("distinguishes the literal booleans from everything else", () => {
		expect(isBooleanLiteral(EXPR_TRUE, true)).toBe(true);
		expect(isBooleanLiteral(EXPR_TRUE, false)).toBe(false);
		expect(isBooleanLiteral(EXPR_FALSE, false)).toBe(true);
		expect(isBooleanLiteral({ Value: 1 }, true)).toBe(false);
		expect(isBooleanLiteral(STATUS_IS_DONE, true)).toBe(false);
	});
});
