import { describe, expect, it, vi } from "vitest";

import type { Expr } from "../../src/cedar/binding.ts";
import {
	parseCedarDateTime,
	parseCedarDuration,
	translateExpr,
	tryPlanValue,
	tryTranslate,
	type PlanTarget,
	type UnsupportedSubterm,
} from "../../src/plan/expr-to-plan.ts";
import { PLAN_FALSE, PLAN_TRUE } from "../../src/plan/plan-node.ts";
import type { PlanNode } from "../../src/plan/plan.ts";

const TARGET: PlanTarget = { unknownVar: "resource", resourceType: "Run", namespace: "Station" };

const UNKNOWN: Expr = { unknown: [{ Value: "resource" }] };
const UNKNOWN_PRINCIPAL: Expr = { unknown: [{ Value: "principal" }] };

function attr(name: string, base: Expr = UNKNOWN): Expr {
	return { ".": { left: base, attr: name } };
}

function entityValue(type: string, id: string): Expr {
	return { Value: { __entity: { type, id } } };
}

/** `then` is Cedar's own key for the branch; the object is an `Expr`, never awaited. */
function ite(condition: Expr, whenTrue: Expr, whenFalse: Expr): Expr {
	// oxlint-disable-next-line unicorn/no-thenable -- see above
	return { "if-then-else": { if: condition, then: whenTrue, else: whenFalse } };
}

function path(name: string): { root: "resource"; path: readonly string[] } {
	return { root: "resource", path: [name] };
}

function node(expr: Expr): PlanNode {
	const outcome = tryTranslate(expr, TARGET);
	if (!outcome.ok) {
		throw new Error(`expected a translation, got ${outcome.reason}`);
	}
	return outcome.node;
}

// ---------------------------------------------------------------------------
// Supported: every row of core.md §5.4
// ---------------------------------------------------------------------------

describe("pushdown table — supported forms", () => {
	it("Value true/false", () => {
		expect(node({ Value: true })).toEqual(PLAN_TRUE);
		expect(node({ Value: false })).toEqual(PLAN_FALSE);
	});

	it("&& / || / !", () => {
		expect(node({ "&&": { left: { Value: true }, right: { Value: false } } })).toEqual({
			op: "and",
			nodes: [PLAN_TRUE, PLAN_FALSE],
		});
		expect(node({ "||": { left: { Value: true }, right: { Value: false } } })).toEqual({
			op: "or",
			nodes: [PLAN_TRUE, PLAN_FALSE],
		});
		expect(node({ "!": { arg: { Value: true } } })).toEqual({ op: "not", node: PLAN_TRUE });
	});

	it("== and != against a constant, on either side", () => {
		expect(node({ "==": { left: attr("status"), right: { Value: "done" } } })).toEqual({
			op: "cmp",
			cmp: "eq",
			attr: path("status"),
			value: { kind: "string", value: "done" },
		});
		expect(node({ "!=": { left: { Value: "done" }, right: attr("status") } })).toEqual({
			op: "cmp",
			cmp: "ne",
			attr: path("status"),
			value: { kind: "string", value: "done" },
		});
	});

	it.each([
		["<", "lt", "gt"],
		["<=", "lte", "gte"],
		[">", "gt", "lt"],
		[">=", "gte", "lte"],
	] as const)(
		"%s maps to %s, and mirrors to %s when the attribute is on the right",
		(op, direct, mirrored) => {
			expect(node({ [op]: { left: attr("attempt"), right: { Value: 5 } } } as Expr)).toEqual({
				op: "cmp",
				cmp: direct,
				attr: path("attempt"),
				value: { kind: "long", value: 5n },
			});
			// `5 < resource.attempt` is `resource.attempt > 5`.
			expect(node({ [op]: { left: { Value: 5 }, right: attr("attempt") } } as Expr)).toEqual({
				op: "cmp",
				cmp: mirrored,
				attr: path("attempt"),
				value: { kind: "long", value: 5n },
			});
		},
	);

	it("is, with the entity type unqualified", () => {
		expect(node({ is: { left: UNKNOWN, entity_type: "Station::Run" } })).toEqual({
			op: "isType",
			entityType: "Run",
		});
		expect(node({ is: { left: UNKNOWN, entity_type: "Station::Project" } })).toEqual({
			op: "isType",
			entityType: "Project",
		});
	});

	it("is ... in, which Cedar also emits as a plain conjunction", () => {
		expect(
			node({
				is: {
					left: UNKNOWN,
					entity_type: "Station::Run",
					in: entityValue("Station::Project", "p1"),
				},
			}),
		).toEqual({
			op: "and",
			nodes: [
				{ op: "isType", entityType: "Run" },
				{ op: "inHierarchy", attr: null, parent: { type: "Project", id: "p1" } },
			],
		});
	});

	it("in over the unknown itself becomes inHierarchy with a null attr", () => {
		expect(node({ in: { left: UNKNOWN, right: entityValue("Station::Project", "p1") } })).toEqual({
			op: "inHierarchy",
			attr: null,
			parent: { type: "Project", id: "p1" },
		});
	});

	it("in over an attribute carries the attribute", () => {
		expect(
			node({ in: { left: attr("project"), right: entityValue("Station::Project", "p1") } }),
		).toEqual({
			op: "inHierarchy",
			attr: path("project"),
			parent: { type: "Project", id: "p1" },
		});
	});

	it("a set literal containing the attribute becomes `in`", () => {
		expect(
			node({
				contains: { left: { Set: [{ Value: "a" }, { Value: "b" }] }, right: attr("status") },
			}),
		).toEqual({
			op: "in",
			attr: path("status"),
			values: [
				{ kind: "string", value: "a" },
				{ kind: "string", value: "b" },
			],
		});
	});

	it("the attribute containing a constant becomes `contains`", () => {
		expect(node({ contains: { left: attr("labels"), right: { Value: "x" } } })).toEqual({
			op: "contains",
			attr: path("labels"),
			value: { kind: "string", value: "x" },
		});
	});

	it("like carries tokens, never a re-serialised string", () => {
		expect(
			node({
				like: {
					left: attr("status"),
					pattern: [{ Literal: "a" }, { Literal: "*" }, "Wildcard", { Literal: "%" }],
				},
			}),
		).toEqual({
			op: "like",
			attr: path("status"),
			pattern: [{ literal: "a" }, { literal: "*" }, { wildcard: true }, { literal: "%" }],
		});
	});

	it("has becomes exists", () => {
		expect(node({ has: { left: UNKNOWN, attr: "startedAt" } })).toEqual({
			op: "exists",
			attr: path("startedAt"),
		});
	});

	it("isEmpty", () => {
		expect(node({ isEmpty: { arg: attr("labels") } })).toEqual({
			op: "isEmpty",
			attr: path("labels"),
		});
	});

	it("a bare boolean attribute is an equality against true", () => {
		expect(node(attr("archived"))).toEqual({
			op: "cmp",
			cmp: "eq",
			attr: path("archived"),
			value: { kind: "bool", value: true },
		});
	});

	it("if-then-else expands to or(and(if, then), and(!if, else))", () => {
		const condition: Expr = { "==": { left: attr("attempt"), right: { Value: 1 } } };
		const whenTrue: Expr = { "==": { left: attr("status"), right: { Value: "a" } } };
		const whenFalse: Expr = { "==": { left: attr("status"), right: { Value: "b" } } };

		expect(node(ite(condition, whenTrue, whenFalse))).toEqual({
			op: "or",
			nodes: [
				{ op: "and", nodes: [node(condition), node(whenTrue)] },
				{ op: "and", nodes: [{ op: "not", node: node(condition) }, node(whenFalse)] },
			],
		});
	});
});

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe("constant translation", () => {
	it.each([
		[{ Value: "s" }, { kind: "string", value: "s" }],
		[{ Value: true }, { kind: "bool", value: true }],
		[{ Value: 7 }, { kind: "long", value: 7n }],
		[{ Value: -7 }, { kind: "long", value: -7n }],
		[entityValue("Station::Run", "r1"), { kind: "entity", value: { type: "Run", id: "r1" } }],
		[{ decimal: [{ Value: "1.5" }] }, { kind: "decimal", value: "1.5" }],
		[{ ip: [{ Value: "10.0.0.0/8" }] }, { kind: "ipaddr", value: "10.0.0.0/8" }],
		[{ duration: [{ Value: "1h30m" }] }, { kind: "duration", value: 5_400_000 }],
	])("binds %j", (expr, expected) => {
		expect(tryPlanValue(expr as Expr, TARGET)).toEqual(expected);
	});

	it("binds datetime as a Date", () => {
		expect(tryPlanValue({ datetime: [{ Value: "2026-01-01T10:20:30.123Z" }] }, TARGET)).toEqual({
			kind: "datetime",
			value: new Date("2026-01-01T10:20:30.123Z"),
		});
	});

	it("binds a set literal element-wise", () => {
		expect(tryPlanValue({ Set: [{ Value: "a" }, { Value: 1 }] }, TARGET)).toEqual({
			kind: "set",
			value: [
				{ kind: "string", value: "a" },
				{ kind: "long", value: 1n },
			],
		});
	});

	it("binds the `__extn` encoding an entity builder produces", () => {
		expect(
			tryPlanValue({ Value: { __extn: { fn: "datetime", arg: "2026-01-01" } } }, TARGET),
		).toEqual({ kind: "datetime", value: new Date("2026-01-01T00:00:00.000Z") });
	});

	it("refuses a record literal, a null and a non-integer number", () => {
		expect(tryPlanValue({ Record: { k: { Value: 1 } } }, TARGET)).toBeUndefined();
		expect(tryPlanValue({ Value: null }, TARGET)).toBeUndefined();
		expect(tryPlanValue({ Value: 1.5 }, TARGET)).toBeUndefined();
	});

	it("refuses an unparseable extension literal rather than guessing", () => {
		expect(tryPlanValue({ datetime: [{ Value: "not-a-date" }] }, TARGET)).toBeUndefined();
		expect(tryPlanValue({ duration: [{ Value: "" }] }, TARGET)).toBeUndefined();
		expect(tryPlanValue({ decimal: [{ Value: "1" }] }, TARGET)).toBeUndefined();
	});
});

describe("parseCedarDateTime", () => {
	it.each([
		["2026-01-01", "2026-01-01T00:00:00.000Z"],
		["2026-01-01T10:20:30Z", "2026-01-01T10:20:30.000Z"],
		["2026-01-01T10:20:30.123Z", "2026-01-01T10:20:30.123Z"],
		// `+0130` means the reading is 1h30 ahead of UTC, so UTC is 1h30 earlier.
		["2026-01-01T10:20:30+0130", "2026-01-01T08:50:30.000Z"],
		["2026-01-01T10:20:30.123-0500", "2026-01-01T15:20:30.123Z"],
	])("parses %s", (literal, iso) => {
		expect(parseCedarDateTime(literal)?.toISOString()).toBe(iso);
	});

	it.each([
		["2026-01-01T10:20:30", "no offset — Cedar requires one once a time is given"],
		["2026-01-01T10:20:30+01:30", "colon in the offset"],
		["2026-02-30", "a day that does not exist"],
		["2026-13-01", "month out of range"],
		["2026-01-01T24:00:00Z", "hour out of range"],
		["", "empty"],
	])("refuses %s (%s)", (literal) => {
		expect(parseCedarDateTime(literal)).toBeUndefined();
	});
});

describe("parseCedarDuration", () => {
	it.each([
		["1h", 3_600_000],
		["1d2h3m4s5ms", 93_784_005],
		["-1d", -86_400_000],
		["5ms", 5],
		["1m", 60_000],
		["0d", 0],
	])("parses %s", (literal, ms) => {
		expect(parseCedarDuration(literal)).toBe(ms);
	});

	it.each(["", "-", "1", "1x", "1m2d"])("refuses %s", (literal) => {
		expect(parseCedarDuration(literal)).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// Rejections: every non-pushdown-able form in core.md §5.4
// ---------------------------------------------------------------------------

describe("pushdown table — rejections", () => {
	it.each([
		[
			"nested attribute access on the unknown",
			{ "==": { left: attr("kind", attr("trigger")), right: { Value: "manual" } } },
			"nested-attribute",
		],
		[
			"nested attribute on the constant side",
			{ contains: { left: { Set: [{ Value: "a" }] }, right: attr("kind", attr("trigger")) } },
			"nested-attribute",
		],
		[
			"has over a dotted chain",
			{ has: { left: UNKNOWN, attr: ["trigger", "actor"] } },
			"nested-attribute",
		],
		[
			"unknown on both sides",
			{ "==": { left: attr("status"), right: attr("other") } },
			"unknown-both-sides",
		],
		[
			"arithmetic",
			{
				"==": {
					left: { "+": { left: attr("attempt"), right: { Value: 1 } } },
					right: { Value: 5 },
				},
			},
			"arithmetic",
		],
		["unary negation", { neg: { arg: attr("attempt") } }, "arithmetic"],
		[
			"getTag",
			{
				"==": { left: { getTag: { left: UNKNOWN, right: { Value: "t" } } }, right: { Value: "v" } },
			},
			"unsupported-operator",
		],
		["hasTag", { hasTag: { left: UNKNOWN, right: { Value: "t" } } }, "unsupported-operator"],
		[
			"containsAll over an unknown attribute",
			{ containsAll: { left: attr("labels"), right: { Set: [{ Value: "a" }] } } },
			"unsupported-operator",
		],
		[
			"containsAny over an unknown attribute",
			{ containsAny: { left: attr("labels"), right: { Set: [{ Value: "a" }] } } },
			"unsupported-operator",
		],
		[
			"an extension call applied to the unknown",
			{
				"==": {
					left: { toDate: [attr("startedAt")] },
					right: { datetime: [{ Value: "2026-01-01" }] },
				},
			},
			"extension-on-unknown",
		],
		[
			"isInRange over the unknown",
			{ isInRange: [attr("addr"), { ip: [{ Value: "10.0.0.0/8" }] }] },
			"extension-on-unknown",
		],
		[
			"a record literal",
			{ "==": { left: attr("trigger"), right: { Record: { kind: { Value: "manual" } } } } },
			"unsupported-value",
		],
		[
			"in with a non-literal right side",
			{ in: { left: UNKNOWN, right: attr("project") } },
			"non-literal-hierarchy",
		],
		[
			"in with a set right side",
			{
				in: {
					left: UNKNOWN,
					right: { Set: [entityValue("Station::Project", "p1")] },
				},
			},
			"non-literal-hierarchy",
		],
		[
			"row identity equality",
			{ "==": { left: UNKNOWN, right: entityValue("Station::Run", "r1") } },
			"entity-identity",
		],
		[
			"an unknown rooted at the wrong variable",
			{
				"==": {
					left: { ".": { left: UNKNOWN_PRINCIPAL, attr: "identitySubject" } },
					right: { Value: "s" },
				},
			},
			"wrong-unknown-root",
		],
		[
			"a bare unknown of the wrong root",
			{ in: { left: UNKNOWN_PRINCIPAL, right: entityValue("Station::Organization", "o") } },
			"wrong-unknown-root",
		],
		["a bare Var", { Var: "principal" }, "unsupported-operator"],
		["an unlinked template slot", { Slot: "?resource" }, "unsupported-operator"],
		["a non-boolean Value at boolean position", { Value: 3 }, "unsupported-value"],
		[
			"`is` over an attribute rather than the row",
			{ is: { left: attr("project"), entity_type: "Station::Project" } },
			"unsupported-operator",
		],
		[
			"`like` over a nested attribute",
			{ like: { left: attr("kind", attr("trigger")), pattern: [] } },
			"nested-attribute",
		],
		["a structurally unrecognised node", {} as Expr, "other"],
	])("rejects %s as %s", (_label, expr, reason) => {
		const outcome = tryTranslate(expr as Expr, TARGET);

		expect(outcome.ok).toBe(false);
		expect(outcome.ok === false && outcome.reason).toBe(reason);
	});

	it("propagates the innermost offending expression, not the whole clause", () => {
		const offending: Expr = { "+": { left: attr("attempt"), right: { Value: 1 } } };
		const outcome = tryTranslate(
			{
				"&&": { left: { Value: true }, right: { "==": { left: offending, right: { Value: 5 } } } },
			},
			TARGET,
		);

		expect(outcome.ok).toBe(false);
		expect(outcome.ok === false && outcome.expr).toEqual(offending);
	});

	it("fails an if-then-else when any single branch fails", () => {
		const good: Expr = { "==": { left: attr("status"), right: { Value: "a" } } };
		const bad: Expr = { "==": { left: attr("kind", attr("trigger")), right: { Value: "m" } } };

		for (const branches of [
			[bad, good, good],
			[good, bad, good],
			[good, good, bad],
		] as const) {
			const outcome = tryTranslate(ite(branches[0], branches[1], branches[2]), TARGET);
			expect(outcome.ok).toBe(false);
			expect(outcome.ok === false && outcome.reason).toBe("nested-attribute");
		}
	});

	it("fails a conjunction all-or-nothing under tryTranslate", () => {
		const outcome = tryTranslate(
			{
				"&&": {
					left: { "==": { left: attr("status"), right: { Value: "a" } } },
					right: { neg: { arg: attr("attempt") } },
				},
			},
			TARGET,
		);

		expect(outcome.ok).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Polarity tracking
// ---------------------------------------------------------------------------

describe("translateExpr — polarity", () => {
	function collect(expr: Expr): {
		node: PlanNode;
		subterms: UnsupportedSubterm[];
	} {
		const subterms: UnsupportedSubterm[] = [];
		const node = translateExpr(expr, 1, {
			target: TARGET,
			onUnsupported: (subterm) => {
				subterms.push(subterm);
				return PLAN_TRUE;
			},
		});
		return { node, subterms };
	}

	const bad: Expr = { neg: { arg: attr("attempt") } };
	const good: Expr = { "==": { left: attr("status"), right: { Value: "a" } } };

	it("starts at +1", () => {
		expect(collect(bad).subterms[0]?.polarity).toBe(1);
	});

	it.each([
		[0, 1],
		[1, -1],
		[2, 1],
		[3, -1],
	])("reports depth %i at polarity %i", (depth, polarity) => {
		let expr: Expr = bad;
		for (let level = 0; level < depth; level += 1) {
			expr = { "!": { arg: expr } };
		}

		expect(collect(expr).subterms[0]?.polarity).toBe(polarity);
	});

	it("preserves polarity through && and ||", () => {
		expect(collect({ "&&": { left: good, right: bad } }).subterms[0]?.polarity).toBe(1);
		expect(
			collect({ "!": { arg: { "||": { left: good, right: bad } } } }).subterms[0]?.polarity,
		).toBe(-1);
	});

	it("localises the failure so siblings still translate", () => {
		const { node, subterms } = collect({ "&&": { left: good, right: bad } });

		expect(subterms).toHaveLength(1);
		// The good conjunct survived; only the offending one was substituted.
		expect(node).toEqual({ op: "and", nodes: [node0(good), PLAN_TRUE] });
	});

	it("flattens n-ary conjunctions and disjunctions", () => {
		const chain: Expr = { "&&": { left: good, right: { "&&": { left: good, right: good } } } };

		expect(collect(chain).node).toEqual({
			op: "and",
			nodes: [node0(good), node0(good), node0(good)],
		});
	});

	it("passes the substituted node straight through", () => {
		const onUnsupported = vi.fn(() => PLAN_FALSE);

		expect(translateExpr(bad, 1, { target: TARGET, onUnsupported })).toEqual(PLAN_FALSE);
		expect(onUnsupported).toHaveBeenCalledTimes(1);
	});

	function node0(expr: Expr): PlanNode {
		return node(expr);
	}
});
