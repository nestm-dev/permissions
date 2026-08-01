import { describe, expect, it } from "vitest";

import {
	PlanEvaluationError,
	evaluatePlanNode,
	filterRowsByPlan,
	matchLikeTokens,
	type HierarchyQuery,
	type PlanRow,
} from "../../src/plan/evaluate-plan.ts";
import { PLAN_FALSE, PLAN_TRUE, planAnd, planNot, planOr } from "../../src/plan/plan-node.ts";
import type { AttrPath, PlanNode, PlanValue } from "../../src/plan/plan.ts";

/**
 * The reference interpreter's semantics, pinned.
 *
 * This file is the specification the ORM drivers are held to — every rule here
 * is one a `planToSql` compiler has to reproduce — so the cases are written as
 * statements about behaviour rather than as coverage. The Cedar-side facts
 * (decimal equality is numeric, `ip("1.2.3.4") == ip("1.2.3.4/32")`, sets are
 * unordered) were each executed against cedar-wasm 4.12.0 before being encoded.
 */

const attr = (name: string): AttrPath => ({ root: "resource", path: [name] });

const cmp = (
	name: string,
	op: PlanNode extends never ? never : "eq",
	value: PlanValue,
): PlanNode => ({
	op: "cmp",
	cmp: op,
	attr: attr(name),
	value,
});

const eq = (name: string, value: PlanValue): PlanNode => cmp(name, "eq", value);

// ---------------------------------------------------------------------------
// Three-valued logic
// ---------------------------------------------------------------------------

describe("absence and three-valued logic", () => {
	const missing = eq("status", { kind: "string", value: "draft" });

	it.each([
		["key absent", {}],
		["value undefined", { status: undefined }],
		["value null", { status: null }],
	])("treats %s as absent, so the comparison does not match", (_case, row) => {
		expect(evaluatePlanNode(missing, row as PlanRow)).toBe(false);
	});

	it("does not flip an absent comparison to true under a negation", () => {
		// SQL: `NOT (status = 'draft')` over a NULL column is NULL, and `WHERE NULL`
		// drops the row. Two-valued logic would return `true` here and select rows
		// the driver never would — the single most likely plan/driver divergence.
		expect(evaluatePlanNode(planNot(missing), {})).toBe(false);
	});

	it("still lets a has-guard rescue the whole conjunction", () => {
		// The shape `validateOnLoad` forces authors into, and the reason Cedar, this
		// interpreter and SQL all agree in practice: `false AND UNKNOWN` is `false`
		// in every one of the three.
		const guarded = planAnd([{ op: "exists", attr: attr("status") }, missing]);

		expect(evaluatePlanNode(guarded, {})).toBe(false);
		expect(evaluatePlanNode(planNot(guarded), {})).toBe(true);
		expect(evaluatePlanNode(guarded, { status: "draft" })).toBe(true);
	});

	it("lets a definite false decide an and, and a definite true decide an or", () => {
		expect(evaluatePlanNode(planAnd([PLAN_FALSE, missing]), {})).toBe(false);
		expect(evaluatePlanNode(planOr([PLAN_TRUE, missing]), {})).toBe(true);
	});

	it("propagates unknown through or when nothing else is true", () => {
		expect(evaluatePlanNode(planOr([PLAN_FALSE, missing]), {})).toBe(false);
		expect(evaluatePlanNode(planNot(planOr([PLAN_FALSE, missing])), {})).toBe(false);
	});

	it("answers `exists` definitely, absent or not", () => {
		const exists: PlanNode = { op: "exists", attr: attr("score") };

		expect(evaluatePlanNode(exists, {})).toBe(false);
		expect(evaluatePlanNode(exists, { score: null })).toBe(false);
		expect(evaluatePlanNode(exists, { score: 0 })).toBe(true);
		expect(evaluatePlanNode(planNot(exists), {})).toBe(true);
	});

	it("treats empty junctions as their identities", () => {
		expect(evaluatePlanNode(planAnd([]), {})).toBe(true);
		expect(evaluatePlanNode(planOr([]), {})).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// The coercion table
// ---------------------------------------------------------------------------

describe("value coercion", () => {
	it("compares strings by code unit, case-sensitively", () => {
		const node = eq("status", { kind: "string", value: "Draft" });

		expect(evaluatePlanNode(node, { status: "Draft" })).toBe(true);
		expect(evaluatePlanNode(node, { status: "draft" })).toBe(false);
	});

	it("accepts a number or a bigint for a long, and compares exactly", () => {
		const node = eq("size", { kind: "long", value: 42n });

		expect(evaluatePlanNode(node, { size: 42 })).toBe(true);
		expect(evaluatePlanNode(node, { size: 42n })).toBe(true);
		expect(evaluatePlanNode(node, { size: 43 })).toBe(false);
	});

	it("refuses a non-integer number for a long", () => {
		expect(() =>
			evaluatePlanNode(eq("size", { kind: "long", value: 42n }), { size: 42.5 }),
		).toThrow(PlanEvaluationError);
	});

	it("compares an entity constant against a bare id string or a {type,id}", () => {
		const node = eq("owner", { kind: "entity", value: { type: "User", id: "u1" } });

		// A bare string compares against the id alone: an `owner_id` column carries
		// no type, and the column's type is fixed by the vocabulary anyway.
		expect(evaluatePlanNode(node, { owner: "u1" })).toBe(true);
		expect(evaluatePlanNode(node, { owner: "u2" })).toBe(false);
		expect(evaluatePlanNode(node, { owner: { type: "User", id: "u1" } })).toBe(true);
		expect(evaluatePlanNode(node, { owner: { type: "Group", id: "u1" } })).toBe(false);
	});

	it("compares datetimes by instant, from a Date, an ISO string or epoch millis", () => {
		const at = new Date("2026-01-01T00:00:00.000Z");
		const node = eq("publishedAt", { kind: "datetime", value: at });

		expect(evaluatePlanNode(node, { publishedAt: at })).toBe(true);
		expect(evaluatePlanNode(node, { publishedAt: "2026-01-01T00:00:00.000Z" })).toBe(true);
		expect(evaluatePlanNode(node, { publishedAt: at.getTime() })).toBe(true);
		expect(evaluatePlanNode(node, { publishedAt: "2026-01-02T00:00:00.000Z" })).toBe(false);
	});

	it("compares decimals numerically, not textually", () => {
		// Verified against 4.12.0: `decimal("1.5") == decimal("1.50")` is `allow`.
		const node = eq("rate", { kind: "decimal", value: "1.5" });

		expect(evaluatePlanNode(node, { rate: "1.5000" })).toBe(true);
		expect(evaluatePlanNode(node, { rate: "1.50" })).toBe(true);
		expect(evaluatePlanNode(node, { rate: 1.5 })).toBe(true);
		expect(evaluatePlanNode(node, { rate: "1.5001" })).toBe(false);
	});

	it("orders decimals at Cedar's four-digit precision", () => {
		const node: PlanNode = {
			op: "cmp",
			cmp: "lt",
			attr: attr("rate"),
			value: { kind: "decimal", value: "1.5" },
		};

		expect(evaluatePlanNode(node, { rate: "1.4999" })).toBe(true);
		expect(evaluatePlanNode(node, { rate: "1.5" })).toBe(false);
	});

	it("compares durations as signed milliseconds", () => {
		// Verified: `duration("1h") == duration("60m")`.
		const node = eq("window", { kind: "duration", value: 3_600_000 });

		expect(evaluatePlanNode(node, { window: 3_600_000 })).toBe(true);
		expect(evaluatePlanNode(node, { window: 60 * 60 * 1000 })).toBe(true);
		expect(evaluatePlanNode(node, { window: -3_600_000 })).toBe(false);
	});

	it("compares sets unordered and duplicate-insensitively", () => {
		// Verified: `[1,2,2] == [2,1]` is `allow`.
		const node = eq("labels", {
			kind: "set",
			value: [
				{ kind: "string", value: "a" },
				{ kind: "string", value: "b" },
			],
		});

		expect(evaluatePlanNode(node, { labels: ["b", "a"] })).toBe(true);
		expect(evaluatePlanNode(node, { labels: ["a", "b", "b"] })).toBe(true);
		expect(evaluatePlanNode(node, { labels: ["a"] })).toBe(false);
	});

	it("refuses a row value whose type cannot represent the constant", () => {
		// A "no match" here would hide a fixture/vocabulary mismatch behind a
		// passing differential, which is worse than a loud failure in a test oracle.
		expect(() => evaluatePlanNode(eq("size", { kind: "long", value: 1n }), { size: "1" })).toThrow(
			PlanEvaluationError,
		);
		expect(() =>
			evaluatePlanNode(eq("archived", { kind: "bool", value: true }), { archived: "true" }),
		).toThrow(PlanEvaluationError);
	});
});

// ---------------------------------------------------------------------------
// ipaddr
// ---------------------------------------------------------------------------

describe("ipaddr equality", () => {
	const node = (literal: string): PlanNode => eq("addr", { kind: "ipaddr", value: literal });

	it.each([
		// Each row was executed against cedar-wasm 4.12.0 before being written down.
		["a bare address equals its full-width prefix", "1.2.3.4", "1.2.3.4/32", true],
		["v6 zero-compression is not significant", "::1", "0:0:0:0:0:0:0:1", true],
		["v6 leading zeros are not significant", "::1", "::0001", true],
		["v6 hex digits are case-insensitive", "FE80::1", "fe80::1", true],
		["a v6 address equals its /128", "::1/128", "::1", true],
		["the address is compared, not the network", "1.2.3.0/24", "1.2.3.1/24", false],
		["the prefix length is part of the value", "1.2.3.0/24", "1.2.3.0/25", false],
		["different v4 addresses differ under /0", "1.2.3.4/0", "5.6.7.8/0", false],
		["families do not mix", "1.2.3.4", "::1", false],
	])("%s", (_name, constant, rowValue, expected) => {
		expect(evaluatePlanNode(node(constant), { addr: rowValue })).toBe(expected);
	});

	it("rejects forms Cedar itself rejects", () => {
		// `ip("01.2.3.4")` errors in Cedar ("invalid IP address"), and
		// `ip("::ffff:1.2.3.4")` errors too. Accepting either here would make the
		// oracle bless a value Cedar cannot evaluate.
		expect(() => evaluatePlanNode(node("1.2.3.4"), { addr: "01.2.3.4" })).toThrow(
			PlanEvaluationError,
		);
		expect(() => evaluatePlanNode(node("1.2.3.4"), { addr: "::ffff:1.2.3.4" })).toThrow(
			PlanEvaluationError,
		);
		expect(() => evaluatePlanNode(node("1.2.3.4"), { addr: "1.2.3.4/33" })).toThrow(
			PlanEvaluationError,
		);
	});
});

// ---------------------------------------------------------------------------
// Ordering guard
// ---------------------------------------------------------------------------

describe("ordering", () => {
	it("refuses an ordering comparison Cedar does not define", () => {
		// The same guard the drivers call before emitting `<`. Cedar has no string
		// ordering; SQL orders strings under the column's collation, so a plan node
		// carrying one would return rows Cedar never authorized.
		const node: PlanNode = {
			op: "cmp",
			cmp: "lt",
			attr: attr("status"),
			value: { kind: "string", value: "draft" },
		};

		expect(() => evaluatePlanNode(node, { status: "a" })).toThrow(TypeError);
	});

	it.each([
		["lt", 4, true],
		["lt", 5, false],
		["lte", 5, true],
		["gt", 6, true],
		["gte", 5, true],
	] as const)("evaluates %s against a long", (op, value, expected) => {
		const node: PlanNode = {
			op: "cmp",
			cmp: op,
			attr: attr("size"),
			value: { kind: "long", value: 5n },
		};
		expect(evaluatePlanNode(node, { size: value })).toBe(expected);
	});
});

// ---------------------------------------------------------------------------
// Sets
// ---------------------------------------------------------------------------

describe("set-valued nodes", () => {
	it("evaluates `contains` over a set-valued column", () => {
		const node: PlanNode = {
			op: "contains",
			attr: attr("labels"),
			value: { kind: "string", value: "urgent" },
		};

		expect(evaluatePlanNode(node, { labels: ["nightly", "urgent"] })).toBe(true);
		expect(evaluatePlanNode(node, { labels: ["nightly"] })).toBe(false);
		expect(evaluatePlanNode(node, { labels: [] })).toBe(false);
		expect(evaluatePlanNode(node, {})).toBe(false);
	});

	it("evaluates `in` as membership of a scalar in a constant set", () => {
		const node: PlanNode = {
			op: "in",
			attr: attr("status"),
			values: [
				{ kind: "string", value: "draft" },
				{ kind: "string", value: "review" },
			],
		};

		expect(evaluatePlanNode(node, { status: "review" })).toBe(true);
		expect(evaluatePlanNode(node, { status: "published" })).toBe(false);
	});

	it("evaluates `isEmpty`", () => {
		const node: PlanNode = { op: "isEmpty", attr: attr("labels") };

		expect(evaluatePlanNode(node, { labels: [] })).toBe(true);
		expect(evaluatePlanNode(node, { labels: ["a"] })).toBe(false);
		// Absent, not empty: a NULL array column is UNKNOWN, and `WHERE UNKNOWN`
		// drops the row rather than treating it as the empty set.
		expect(evaluatePlanNode(node, {})).toBe(false);
		expect(evaluatePlanNode(planNot(node), {})).toBe(false);
	});

	it("refuses a non-array where a set is required", () => {
		expect(() =>
			evaluatePlanNode({ op: "isEmpty", attr: attr("labels") }, { labels: "a" }),
		).toThrow(PlanEvaluationError);
	});
});

// ---------------------------------------------------------------------------
// Hierarchy (D7)
// ---------------------------------------------------------------------------

describe("inHierarchy (D7)", () => {
	const rowNode: PlanNode = {
		op: "inHierarchy",
		attr: null,
		parent: { type: "Folder", id: "f1" },
	};
	const attrNode: PlanNode = {
		op: "inHierarchy",
		attr: attr("folder"),
		parent: { type: "Folder", id: "f1" },
	};

	it("throws when the tree needs a resolver and none was supplied", () => {
		expect(() => evaluatePlanNode(rowNode, {})).toThrow(PlanEvaluationError);
		expect(() => evaluatePlanNode(rowNode, {})).toThrow(/no hierarchy resolver/);
	});

	it("throws eagerly, even when the branch would have been short-circuited away", () => {
		// A `&&` whose first conjunct is false never reaches the `inHierarchy`. If the
		// check were lazy, a missing resolver would ship and surface as wrong rows on
		// whichever row first took the other branch.
		expect(() => evaluatePlanNode(planAnd([PLAN_FALSE, rowNode]), {})).toThrow(PlanEvaluationError);
	});

	it("throws when the resolver cannot answer", () => {
		const undecided = (): boolean => undefined as unknown as boolean;

		expect(() => evaluatePlanNode(rowNode, {}, { hierarchy: undecided })).toThrow(
			/must return a boolean/,
		);
	});

	it("passes the row, the attribute and the row id to the resolver", () => {
		const seen: HierarchyQuery[] = [];
		const hierarchy = (query: HierarchyQuery): boolean => {
			seen.push(query);
			return true;
		};

		evaluatePlanNode(attrNode, { folder: "f9" }, { rowId: "d1", hierarchy });

		expect(seen.length).toBe(1);
		expect(seen[0]?.attr).toBe("folder");
		expect(seen[0]?.rowId).toBe("d1");
		expect(seen[0]?.value).toBe("f9");
		expect(seen[0]?.parent).toEqual({ type: "Folder", id: "f1" });
	});

	it("is reflexive — the self case is the one a strict-ancestor walk gets wrong", () => {
		// Cedar's `in` is descendant-or-self, so `Folder::"f1" in Folder::"f1"` is
		// true and a driver's `self` mapping compiles to `folder_id = $1`.
		const selfOnly = (query: HierarchyQuery): boolean =>
			query.value === query.parent.id || query.rowId === query.parent.id;

		expect(evaluatePlanNode(attrNode, { folder: "f1" }, { hierarchy: selfOnly })).toBe(true);
		expect(evaluatePlanNode(attrNode, { folder: "f2" }, { hierarchy: selfOnly })).toBe(false);
	});

	it("does not consult the resolver for an absent reference column", () => {
		let called = false;
		const hierarchy = (): boolean => {
			called = true;
			return true;
		};

		// An absent reference joins to nothing, which is UNKNOWN — the NULL a LEFT
		// JOIN would produce — rather than a question for the resolver.
		expect(evaluatePlanNode(attrNode, { folder: null }, { hierarchy })).toBe(false);
		expect(called).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Shapes the compiler cannot produce
// ---------------------------------------------------------------------------

describe("shapes a compiled plan never contains", () => {
	it("throws on a principal-rooted path", () => {
		const node: PlanNode = {
			op: "cmp",
			cmp: "eq",
			attr: { root: "principal", path: ["org"] },
			value: { kind: "string", value: "o1" },
		};

		expect(() => evaluatePlanNode(node, {})).toThrow(/only carries resource attributes/);
	});

	it("throws on a nested path", () => {
		const node: PlanNode = {
			op: "cmp",
			cmp: "eq",
			attr: { root: "resource", path: ["owner", "org"] },
			value: { kind: "string", value: "o1" },
		};

		expect(() => evaluatePlanNode(node, {})).toThrow(/depth-2 path/);
	});

	it("throws on isType with no resourceType supplied", () => {
		expect(() => evaluatePlanNode({ op: "isType", entityType: "Doc" }, {})).toThrow(
			/no resourceType was supplied/,
		);
	});

	it("folds isType against the supplied resourceType", () => {
		expect(evaluatePlanNode({ op: "isType", entityType: "Doc" }, {}, { resourceType: "Doc" })).toBe(
			true,
		);
		expect(
			evaluatePlanNode({ op: "isType", entityType: "Folder" }, {}, { resourceType: "Doc" }),
		).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// like
// ---------------------------------------------------------------------------

describe("like", () => {
	it("evaluates a like node over the token array", () => {
		const node: PlanNode = {
			op: "like",
			attr: attr("title"),
			pattern: [{ literal: "a" }, { wildcard: true }, { literal: "z" }],
		};

		expect(evaluatePlanNode(node, { title: "abcz" })).toBe(true);
		expect(evaluatePlanNode(node, { title: "az" })).toBe(true);
		expect(evaluatePlanNode(node, { title: "abc" })).toBe(false);
		expect(evaluatePlanNode(node, {})).toBe(false);
	});

	it("refuses a non-string subject", () => {
		const node: PlanNode = { op: "like", attr: attr("title"), pattern: [{ wildcard: true }] };

		expect(() => evaluatePlanNode(node, { title: 5 })).toThrow(PlanEvaluationError);
	});

	it("backtracks across multiple wildcards", () => {
		const tokens = [
			{ wildcard: true } as const,
			{ literal: "ab" } as const,
			{ wildcard: true } as const,
			{ literal: "ab" } as const,
		];

		expect(matchLikeTokens("xxabyyab", tokens)).toBe(true);
		expect(matchLikeTokens("abab", tokens)).toBe(true);
		expect(matchLikeTokens("ab", tokens)).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// filterRowsByPlan
// ---------------------------------------------------------------------------

describe("filterRowsByPlan", () => {
	it("keeps the matching rows and threads rowId per row", () => {
		const rows = [
			{ id: "d1", status: "draft" },
			{ id: "d2", status: "published" },
			{ id: "d3", status: "draft" },
		];

		const kept = filterRowsByPlan(rows, eq("status", { kind: "string", value: "draft" }), {
			rowId: (row) => row.id,
		});

		expect(kept.map((row) => row.id)).toEqual(["d1", "d3"]);
	});
});
