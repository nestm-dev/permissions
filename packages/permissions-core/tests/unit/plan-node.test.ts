import { describe, expect, it } from "vitest";

import {
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
} from "../../src/plan/plan-node.ts";
import type { AttrPath, LikeToken, PlanNode, PlanValue } from "../../src/plan/plan.ts";

const STATUS: AttrPath = { root: "resource", path: ["status"] };
const ATTEMPT: AttrPath = { root: "resource", path: ["attempt"] };

function eq(value: string): PlanNode {
	return { op: "cmp", cmp: "eq", attr: STATUS, value: { kind: "string", value } };
}

// ---------------------------------------------------------------------------
// walkPlanNode
// ---------------------------------------------------------------------------

describe("walkPlanNode", () => {
	const tree: PlanNode = planAnd([
		planOr([eq("a"), eq("b")]),
		planNot({ op: "exists", attr: ATTEMPT }),
	]);

	it("visits parents before children", () => {
		const ops: string[] = [];
		walkPlanNode(tree, (node) => {
			ops.push(node.op);
		});

		expect(ops).toEqual(["and", "or", "cmp", "cmp", "not", "exists"]);
	});

	it("reports each node's parent", () => {
		const pairs: [string, string | undefined][] = [];
		walkPlanNode(tree, (node, parent) => {
			pairs.push([node.op, parent?.op]);
		});

		expect(pairs).toEqual([
			["and", undefined],
			["or", "and"],
			["cmp", "or"],
			["cmp", "or"],
			["not", "and"],
			["exists", "not"],
		]);
	});

	it("prunes a subtree when the visitor returns false", () => {
		const ops: string[] = [];
		walkPlanNode(tree, (node) => {
			ops.push(node.op);
			return node.op !== "or";
		});

		expect(ops).toEqual(["and", "or", "not", "exists"]);
	});

	it("visits a leaf exactly once", () => {
		const ops: string[] = [];
		walkPlanNode(PLAN_TRUE, (node) => {
			ops.push(node.op);
		});

		expect(ops).toEqual(["true"]);
	});
});

// ---------------------------------------------------------------------------
// planValueKindOf / assertOrderable
// ---------------------------------------------------------------------------

describe("planValueKindOf", () => {
	it.each([
		["string", { kind: "string", value: "s" }],
		["long", { kind: "long", value: 1n }],
		["bool", { kind: "bool", value: true }],
		["entity", { kind: "entity", value: { type: "Run", id: "r" } }],
		["datetime", { kind: "datetime", value: new Date(0) }],
		["duration", { kind: "duration", value: 1 }],
		["decimal", { kind: "decimal", value: "1.5" }],
		["ipaddr", { kind: "ipaddr", value: "::1" }],
		["set", { kind: "set", value: [] }],
	])("reports a %s value", (kind, value) => {
		expect(planValueKindOf(value as PlanValue)).toBe(kind);
	});

	it("throws on something that is not a PlanValue", () => {
		expect(() => planValueKindOf("nope" as unknown as PlanValue)).toThrow(TypeError);
		expect(() => planValueKindOf(null as unknown as PlanValue)).toThrow(TypeError);
	});
});

describe("assertOrderable", () => {
	it.each([
		["long", { kind: "long", value: 1n }],
		["datetime", { kind: "datetime", value: new Date(0) }],
		["duration", { kind: "duration", value: 1 }],
		["decimal", { kind: "decimal", value: "1.5" }],
	])("accepts %s", (_kind, value) => {
		expect(() => assertOrderable(value as PlanValue)).not.toThrow();
	});

	it.each([
		["string", { kind: "string", value: "s" }],
		["bool", { kind: "bool", value: true }],
		["entity", { kind: "entity", value: { type: "Run", id: "r" } }],
		["ipaddr", { kind: "ipaddr", value: "::1" }],
		["set", { kind: "set", value: [] }],
	])("refuses %s", (_kind, value) => {
		// Cedar has no string ordering; SQL does, under the column's collation. A
		// driver that emitted `<` for one would return rows Cedar never authorized.
		expect(() => assertOrderable(value as PlanValue)).toThrow(TypeError);
	});

	it("names the kind and the orderable set in the message", () => {
		expect(() => assertOrderable({ kind: "string", value: "s" })).toThrow(
			/does not order values of kind "string".*long, datetime, duration, decimal/s,
		);
	});
});

// ---------------------------------------------------------------------------
// likeTokensToPattern — the %/_/*/\ escaping matrix
// ---------------------------------------------------------------------------

describe("likeTokensToPattern", () => {
	const sql = { escapeChar: "\\" } as const;

	it.each([
		["plain text", [{ literal: "abc" }], "abc"],
		["a wildcard", [{ wildcard: true }], "%"],
		["a literal asterisk (the policy wrote \\*)", [{ literal: "*" }], "*"],
		["a literal percent", [{ literal: "%" }], "\\%"],
		["a literal underscore", [{ literal: "_" }], "\\_"],
		["a literal backslash", [{ literal: "\\" }], "\\\\"],
		[
			"the whole `a\\*b*_%c` pattern Cedar tokenises",
			[
				{ literal: "a" },
				{ literal: "*" },
				{ literal: "b" },
				{ wildcard: true },
				{ literal: "_" },
				{ literal: "%" },
				{ literal: "c" },
			],
			"a*b%\\_\\%c",
		],
		["metacharacters inside one literal token", [{ literal: "50%_off\\" }], "50\\%\\_off\\\\"],
		["an empty pattern", [], ""],
		["an empty literal", [{ literal: "" }], ""],
		["adjacent wildcards", [{ wildcard: true }, { wildcard: true }], "%%"],
	])("renders %s", (_label, tokens, expected) => {
		expect(likeTokensToPattern(tokens as LikeToken[], sql)).toBe(expected);
	});

	it("escapes for a dialect with different metacharacters", () => {
		const tokens: LikeToken[] = [{ literal: "a%b_c*" }, { wildcard: true }];

		expect(
			likeTokensToPattern(tokens, { wildcardChar: "*", singleChar: "?", escapeChar: "!" }),
		).toBe(
			// `%` and `_` are ordinary here; `*` is the wildcard so the literal one escapes.
			"a%b_c!**",
		);
	});

	it("escapes the escape character itself", () => {
		// Without this a literal backslash would escape whatever followed it.
		expect(likeTokensToPattern([{ literal: "\\%" }], sql)).toBe("\\\\\\%");
	});

	it.each([
		["a multi-character escapeChar", { escapeChar: "\\\\" }],
		["an empty escapeChar", { escapeChar: "" }],
		["a multi-character wildcardChar", { escapeChar: "\\", wildcardChar: "%%" }],
		["a multi-character singleChar", { escapeChar: "\\", singleChar: "__" }],
		["wildcardChar equal to singleChar", { escapeChar: "\\", wildcardChar: "%", singleChar: "%" }],
		["escapeChar equal to wildcardChar", { escapeChar: "%" }],
		["escapeChar equal to singleChar", { escapeChar: "_" }],
	])("refuses %s", (_label, options) => {
		expect(() =>
			likeTokensToPattern([{ literal: "a" }], options as { escapeChar: string }),
		).toThrow(TypeError);
	});

	it("handles astral literals as single characters", () => {
		expect(likeTokensToPattern([{ literal: "🚀%" }], sql)).toBe("🚀\\%");
	});
});

// ---------------------------------------------------------------------------
// simplifyPlanNode
// ---------------------------------------------------------------------------

describe("simplifyPlanNode", () => {
	it("absorbs true out of an and and false out of an or", () => {
		expect(simplifyPlanNode(planAnd([PLAN_TRUE, eq("a"), PLAN_TRUE]))).toEqual(eq("a"));
		expect(simplifyPlanNode(planOr([PLAN_FALSE, eq("a"), PLAN_FALSE]))).toEqual(eq("a"));
	});

	it("annihilates on false in an and and true in an or", () => {
		expect(simplifyPlanNode(planAnd([eq("a"), PLAN_FALSE]))).toEqual(PLAN_FALSE);
		expect(simplifyPlanNode(planOr([eq("a"), PLAN_TRUE]))).toEqual(PLAN_TRUE);
	});

	it("treats an empty and as true and an empty or as false", () => {
		// This is exactly why the assembly `and(or(permits), not(or(forbids)))`
		// works with no policies at all: no permits allows nothing, no forbids
		// blocks nothing.
		expect(simplifyPlanNode(planAnd([]))).toEqual(PLAN_TRUE);
		expect(simplifyPlanNode(planOr([]))).toEqual(PLAN_FALSE);
	});

	it("collapses a single-child junction", () => {
		expect(simplifyPlanNode(planAnd([eq("a")]))).toEqual(eq("a"));
		expect(simplifyPlanNode(planOr([eq("a")]))).toEqual(eq("a"));
	});

	it("flattens nested junctions of the same operator", () => {
		expect(simplifyPlanNode(planAnd([eq("a"), planAnd([eq("b"), eq("c")])]))).toEqual(
			planAnd([eq("a"), eq("b"), eq("c")]),
		);
	});

	it("does not flatten across operators", () => {
		const mixed = planAnd([eq("a"), planOr([eq("b"), eq("c")])]);
		expect(simplifyPlanNode(mixed)).toEqual(mixed);
	});

	it("eliminates double negation and folds constants under not", () => {
		expect(simplifyPlanNode(planNot(PLAN_TRUE))).toEqual(PLAN_FALSE);
		expect(simplifyPlanNode(planNot(PLAN_FALSE))).toEqual(PLAN_TRUE);
		expect(simplifyPlanNode(planNot(planNot(eq("a"))))).toEqual(eq("a"));
	});

	it.each([
		["eq", "ne"],
		["ne", "eq"],
		["lt", "gte"],
		["gte", "lt"],
		["lte", "gt"],
		["gt", "lte"],
	] as const)("pushes not through cmp %s to %s", (from, to) => {
		const value: PlanValue = { kind: "long", value: 1n };

		expect(simplifyPlanNode(planNot({ op: "cmp", cmp: from, attr: ATTEMPT, value }))).toEqual({
			op: "cmp",
			cmp: to,
			attr: ATTEMPT,
			value,
		});
	});

	it("leaves not over a non-cmp node alone", () => {
		const exists: PlanNode = { op: "exists", attr: STATUS };
		expect(simplifyPlanNode(planNot(exists))).toEqual(planNot(exists));
	});

	it("folds isType against the planned resource type", () => {
		const isRun: PlanNode = { op: "isType", entityType: "Run" };

		expect(simplifyPlanNode(isRun, { resourceType: "Run" })).toEqual(PLAN_TRUE);
		expect(simplifyPlanNode(isRun, { resourceType: "Project" })).toEqual(PLAN_FALSE);
		// Without a planned type there is nothing to fold against.
		expect(simplifyPlanNode(isRun)).toEqual(isRun);
	});

	it("simplifies bottom-up, so an inner fold collapses the whole tree", () => {
		const tree = planAnd([planOr([{ op: "isType", entityType: "Project" }, PLAN_FALSE]), eq("a")]);

		expect(simplifyPlanNode(tree, { resourceType: "Run" })).toEqual(PLAN_FALSE);
	});
});

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

describe("formatting", () => {
	it("renders every value kind", () => {
		expect(formatPlanValue({ kind: "string", value: 'a"b' })).toBe('"a\\"b"');
		expect(formatPlanValue({ kind: "long", value: 9n })).toBe("9n");
		expect(formatPlanValue({ kind: "bool", value: false })).toBe("false");
		expect(formatPlanValue({ kind: "entity", value: { type: "Run", id: "r1" } })).toBe('Run::"r1"');
		expect(formatPlanValue({ kind: "datetime", value: new Date(0) })).toBe(
			"datetime(1970-01-01T00:00:00.000Z)",
		);
		expect(formatPlanValue({ kind: "duration", value: 5 })).toBe("duration(5ms)");
		expect(formatPlanValue({ kind: "decimal", value: "1.5" })).toBe("decimal(1.5)");
		expect(formatPlanValue({ kind: "ipaddr", value: "::1" })).toBe("ip(::1)");
		expect(formatPlanValue({ kind: "set", value: [{ kind: "long", value: 1n }] })).toBe("[1n]");
	});

	it("renders a like pattern with wildcards as `*` and literal asterisks escaped", () => {
		expect(formatLikePattern([{ literal: "a" }, { wildcard: true }, { literal: "*" }])).toBe(
			"a*\\*",
		);
	});

	it("renders attribute paths, including the row itself", () => {
		expect(formatAttrPath(STATUS)).toBe("resource.status");
		expect(formatAttrPath({ root: "resource", path: [] })).toBe("resource");
	});

	it("renders every node op", () => {
		expect(formatPlanNode(PLAN_TRUE)).toBe("true");
		expect(formatPlanNode(PLAN_FALSE)).toBe("false");
		expect(formatPlanNode(planAnd([eq("a"), eq("b")]))).toBe(
			'(resource.status == "a" && resource.status == "b")',
		);
		expect(formatPlanNode(planOr([eq("a")]))).toBe('(resource.status == "a")');
		expect(formatPlanNode(planNot(eq("a")))).toBe('!resource.status == "a"');
		expect(
			formatPlanNode({ op: "in", attr: STATUS, values: [{ kind: "string", value: "a" }] }),
		).toBe('resource.status in ["a"]');
		expect(
			formatPlanNode({ op: "contains", attr: STATUS, value: { kind: "string", value: "a" } }),
		).toBe('resource.status.contains("a")');
		expect(formatPlanNode({ op: "like", attr: STATUS, pattern: [{ wildcard: true }] })).toBe(
			'resource.status like "*"',
		);
		expect(formatPlanNode({ op: "exists", attr: STATUS })).toBe("resource has status");
		expect(formatPlanNode({ op: "isEmpty", attr: STATUS })).toBe("resource.status.isEmpty()");
		expect(formatPlanNode({ op: "isType", entityType: "Run" })).toBe("resource is Run");
		expect(
			formatPlanNode({ op: "inHierarchy", attr: null, parent: { type: "Project", id: "p1" } }),
		).toBe('resource in Project::"p1"');
		expect(
			formatPlanNode({
				op: "inHierarchy",
				attr: { root: "resource", path: ["project"] },
				parent: { type: "Project", id: "p1" },
			}),
		).toBe('resource.project in Project::"p1"');
	});
});
