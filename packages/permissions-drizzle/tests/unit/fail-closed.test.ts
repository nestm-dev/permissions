// The fail-closed contract, case by case.
//
// > `planToSql` compiles **exactly** the `PlanNode` grammar. Anything a mapping
// > does not cover raises a `PlanCompilationError` before any SQL is produced.
// > There is no configuration in which an uncompilable node becomes `TRUE`.
//
// Two halves, and the second is the one that would survive a rewrite:
//
//   1. a **table** of every documented throw, asserted as a *typed* refusal —
//      `reason`, not a message substring, because a caller branching on the
//      message is a caller that breaks when the message improves;
//   2. a **property**: over thousands of generated `PlanNode`s and several
//      mappings, `planToSql` either throws a `PlanCompilationError` or returns
//      an `SQL` that renders to a non-empty statement. It never returns
//      `undefined`, never renders to `""`, and never throws anything else.
//
// (2) is the assertion that matters. `undefined` reaching drizzle's `.where()`
// is not a type error and not a runtime error — it is a `WHERE` clause that was
// never emitted, which is every row in the table.

import type { PlanNode, PlanValue } from "@nestm/permissions-core/plan";
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { planNodeToSql, planToSql } from "../../src/compile/plan-to-sql.ts";
import { applyPlan } from "../../src/compile/apply-plan.ts";
import {
	PlanCompilationError,
	UnmappedAttributeError,
	UnmappedHierarchyError,
	isPlanCompilationError,
	type PlanCompilationReason,
} from "../../src/errors.ts";
import type { DrizzleResourceMapping } from "../../src/compile/mapping.ts";
import {
	allowPlan,
	approximation,
	attr,
	caseInsensitiveMapping,
	conditionalPlan,
	denyPlan,
	docMapping,
	docs,
	emptyMapping,
	noopPostFilter,
	principalAttr,
	renderSql,
} from "../fixtures/compile.ts";

const str = (value: string): PlanValue => ({ kind: "string", value });
const long = (value: number): PlanValue => ({ kind: "long", value: BigInt(value) });
const bool = (value: boolean): PlanValue => ({ kind: "bool", value });
const ref = (type: string, id: string): PlanValue => ({ kind: "entity", value: { type, id } });

/** Compiles `node` and returns whatever was thrown, asserting something was. */
function refusalOf(
	node: PlanNode,
	mapping: DrizzleResourceMapping<"Doc"> = docMapping,
): PlanCompilationError {
	let thrown: unknown;
	try {
		planNodeToSql(node, mapping);
	} catch (error) {
		thrown = error;
	}

	if (!isPlanCompilationError(thrown)) {
		throw new Error(
			`Expected a PlanCompilationError, got ${describeThrown(thrown)}. ` +
				`A node the mapping cannot express must be refused, never compiled.`,
		);
	}
	return thrown;
}

// ---------------------------------------------------------------------------
// The table
// ---------------------------------------------------------------------------

interface RefusalCase {
	readonly name: string;
	readonly node: PlanNode;
	readonly reason: PlanCompilationReason;
	readonly mapping?: DrizzleResourceMapping<"Doc">;
	/** Constructor the error must be an instance of, where the taxonomy names one. */
	readonly type?: new (...args: never[]) => Error;
}

const REFUSALS: readonly RefusalCase[] = [
	// --- unmapped attribute -------------------------------------------------
	{
		name: "an attribute the mapping does not declare",
		node: { op: "cmp", cmp: "eq", attr: attr("clearance"), value: str("secret") },
		reason: "unmapped-attribute",
		type: UnmappedAttributeError,
	},
	{
		name: "an attribute on a mapping that declares none at all",
		node: { op: "cmp", cmp: "eq", attr: attr("status"), value: str("draft") },
		reason: "unmapped-attribute",
		mapping: emptyMapping,
		type: UnmappedAttributeError,
	},
	{
		name: "a principal-rooted path (rows carry resource attributes only)",
		node: { op: "cmp", cmp: "eq", attr: principalAttr("status"), value: str("draft") },
		reason: "unmapped-attribute",
		type: UnmappedAttributeError,
	},
	{
		name: "a depth-2 path, which would need a join the planner cannot know about",
		node: {
			op: "cmp",
			cmp: "eq",
			attr: { root: "resource", path: ["owner", "dept"] },
			value: str("eng"),
		},
		reason: "unmapped-attribute",
		type: UnmappedAttributeError,
	},
	{
		name: "an unmapped attribute reached through exists()",
		node: { op: "exists", attr: attr("clearance") },
		reason: "unmapped-attribute",
		type: UnmappedAttributeError,
	},

	// --- unmapped hierarchy -------------------------------------------------
	{
		name: "a row-level parent type the mapping has no strategy for",
		node: { op: "inHierarchy", attr: null, parent: { type: "Galaxy", id: "g1" } },
		reason: "unmapped-hierarchy",
		type: UnmappedHierarchyError,
	},
	{
		name: "an attribute-level parent type the attribute has no strategy for",
		node: { op: "inHierarchy", attr: attr("folder"), parent: { type: "Galaxy", id: "g1" } },
		reason: "unmapped-hierarchy",
		type: UnmappedHierarchyError,
	},
	{
		name: "a row's denormalised ancestor column borrowed for an attribute question",
		// `hierarchy.Folder` is `{ kind: 'column' }` and describes the *row*. Rooting
		// it at `resource.folder` would answer about a different entity.
		node: { op: "inHierarchy", attr: attr("folder"), parent: { type: "Doc", id: "d1" } },
		reason: "unmapped-hierarchy",
		type: UnmappedHierarchyError,
	},

	// --- ordering over an unordered kind ------------------------------------
	{
		name: "`<` against a string (Cedar has no string ordering; SQL invents one)",
		node: { op: "cmp", cmp: "lt", attr: attr("status"), value: str("draft") },
		reason: "unorderable-comparison",
	},
	{
		name: "`>=` against a string",
		node: { op: "cmp", cmp: "gte", attr: attr("title"), value: str("a") },
		reason: "unorderable-comparison",
	},
	{
		name: "`<` against a bool",
		node: { op: "cmp", cmp: "lt", attr: attr("archived"), value: bool(true) },
		reason: "unorderable-comparison",
	},
	{
		name: "`<` against an entity reference",
		node: { op: "cmp", cmp: "lt", attr: attr("owner"), value: ref("User", "u1") },
		reason: "unorderable-comparison",
	},
	{
		name: "`<` against an ipaddr",
		node: {
			op: "cmp",
			cmp: "lt",
			attr: attr("addr"),
			value: { kind: "ipaddr", value: "10.0.0.1" },
		},
		reason: "unorderable-comparison",
	},
	{
		name: "`<` against a set",
		node: {
			op: "cmp",
			cmp: "lt",
			attr: attr("labels"),
			value: { kind: "set", value: [str("a")] },
		},
		reason: "unorderable-comparison",
	},

	// --- contains / isEmpty on a scalar -------------------------------------
	{
		name: "contains() on a scalar column",
		node: { op: "contains", attr: attr("status"), value: str("draft") },
		reason: "contains-on-scalar",
	},
	{
		name: "contains() on an entity column",
		node: { op: "contains", attr: attr("owner"), value: ref("User", "u1") },
		reason: "contains-on-scalar",
	},
	{
		name: "isEmpty() on a scalar column",
		node: { op: "isEmpty", attr: attr("status") },
		reason: "contains-on-scalar",
	},
	{
		name: "a set constant compared against a scalar column",
		node: {
			op: "cmp",
			cmp: "eq",
			attr: attr("status"),
			value: { kind: "set", value: [str("a"), str("b")] },
		},
		reason: "contains-on-scalar",
	},

	// --- entity vs non-entity column ----------------------------------------
	{
		name: "an entity constant against a scalar column",
		node: { op: "cmp", cmp: "eq", attr: attr("status"), value: ref("User", "u1") },
		reason: "entity-column-mismatch",
	},
	{
		name: "an entity constant against an array column",
		node: { op: "cmp", cmp: "eq", attr: attr("labels"), value: ref("User", "u1") },
		reason: "entity-column-mismatch",
	},
	{
		name: "a scalar constant against an entity column",
		node: { op: "cmp", cmp: "eq", attr: attr("owner"), value: str("u1") },
		reason: "entity-column-mismatch",
	},
	{
		name: "an IN list of scalars against an entity column",
		node: { op: "in", attr: attr("owner"), values: [str("u1"), str("u2")] },
		reason: "entity-column-mismatch",
	},
	{
		name: "`resource.<attr> in Parent::…` where the attribute is not an entity column",
		node: { op: "inHierarchy", attr: attr("status"), parent: { type: "Folder", id: "f1" } },
		reason: "entity-column-mismatch",
	},

	// --- case-insensitive collation under like ------------------------------
	{
		name: "like against a table declared case-insensitive",
		node: { op: "like", attr: attr("title"), pattern: [{ literal: "a" }, { wildcard: true }] },
		reason: "case-insensitive-like",
		mapping: caseInsensitiveMapping,
	},

	// --- value-kind mismatches ----------------------------------------------
	{
		name: "like against a column the mapping does not declare as a string",
		node: { op: "like", attr: attr("size"), pattern: [{ literal: "1" }] },
		reason: "value-kind-mismatch",
	},
	{
		name: "a long constant against a string column",
		node: { op: "cmp", cmp: "eq", attr: attr("status"), value: long(3) },
		reason: "value-kind-mismatch",
	},
	{
		name: "a string constant against a long column",
		node: { op: "cmp", cmp: "eq", attr: attr("size"), value: str("3") },
		reason: "value-kind-mismatch",
	},
	{
		name: "an IN list of entities against a scalar column",
		node: { op: "in", attr: attr("status"), values: [ref("User", "u1")] },
		reason: "value-kind-mismatch",
	},
	{
		name: "an array whose element kind disagrees with the constant",
		node: { op: "contains", attr: attr("labels"), value: long(1) },
		reason: "value-kind-mismatch",
	},
	{
		name: "a set constant against a jsonPath mapping (no JSON scalar form)",
		node: {
			op: "contains",
			attr: attr("tags"),
			value: { kind: "set", value: [str("a")] },
		},
		reason: "value-kind-mismatch",
	},

	// --- structurally unusable mapping --------------------------------------
	{
		name: "{ kind: 'self' } declared for a parent type that is not the target's own",
		node: { op: "inHierarchy", attr: attr("folder"), parent: { type: "Org", id: "o1" } },
		reason: "invalid-mapping",
		mapping: {
			...docMapping,
			attributes: {
				...docMapping.attributes,
				// `folder` holds Folder ids, so `self` for `Org` is a contradiction.
				folder: {
					kind: "entity",
					column: docs.folderId,
					entityType: "Folder",
					hierarchy: { Org: { kind: "self" } },
				},
			},
		},
	},
];

describe("fail-closed refusals", () => {
	it.each(REFUSALS.map((entry) => [entry.name, entry] as const))("refuses %s", (_name, entry) => {
		const error = refusalOf(entry.node, entry.mapping);

		expect(error.reason).toBe(entry.reason);
		expect(error.code).toBe("PLAN_COMPILATION");
		if (entry.type !== undefined) {
			expect(error).toBeInstanceOf(entry.type);
		}
		// Every refusal names the resource type, so a log line identifies the mapping
		// without the reader having to parse the message.
		expect(error.resourceType).toBe("Doc");
	});

	it("covers every reason in the taxonomy that a node can trigger", () => {
		const covered = new Set(REFUSALS.map((entry) => entry.reason));
		expect([...covered].toSorted()).toEqual([
			"case-insensitive-like",
			"contains-on-scalar",
			"entity-column-mismatch",
			"invalid-mapping",
			"unmapped-attribute",
			"unmapped-hierarchy",
			"unorderable-comparison",
			"value-kind-mismatch",
		]);
	});
});

// ---------------------------------------------------------------------------
// Plan-level refusals
// ---------------------------------------------------------------------------

describe("resource-type mismatch", () => {
	it("refuses a plan compiled for a different resource type", () => {
		const plan = conditionalPlan({ op: "true" }, { resourceType: "Run" });
		expect(() => planToSql(plan, docMapping as DrizzleResourceMapping<string>)).toThrow(
			PlanCompilationError,
		);

		try {
			planToSql(plan, docMapping as DrizzleResourceMapping<string>);
		} catch (error) {
			expect((error as PlanCompilationError).reason).toBe("resource-type-mismatch");
		}
	});

	it("checks the type on all three arms, not only CONDITIONAL", () => {
		for (const plan of [
			allowPlan({ resourceType: "Run" }),
			denyPlan({ resourceType: "Run" }),
			conditionalPlan({ op: "true" }, { resourceType: "Run" }),
		]) {
			expect(() => planToSql(plan, docMapping as DrizzleResourceMapping<string>)).toThrow(
				PlanCompilationError,
			);
		}
	});
});

describe("permissive approximations", () => {
	const permissive = [approximation("permissive")];

	it("refuses a widened plan by default", () => {
		const plan = conditionalPlan({ op: "true" }, { approximations: permissive });
		const error = catchError(() => planToSql(plan, docMapping));
		expect(error.reason).toBe("permissive-approximation");
	});

	it("still refuses with the flag set but no postFilter to narrow the result", () => {
		const plan = conditionalPlan({ op: "true" }, { approximations: permissive });
		const error = catchError(() =>
			planToSql(plan, docMapping, { allowPermissiveApproximations: true }),
		);
		expect(error.reason).toBe("permissive-approximation");
		expect(error.message).toContain("the plan carries no postFilter");
	});

	it("refuses an ALWAYS_ALLOW carrying a permissive approximation", () => {
		// `ALWAYS_ALLOW` has no `postFilter` field at all, so a widened one can never
		// be narrowed — there is no opt-in that makes this compilable.
		const error = catchError(() =>
			planToSql(allowPlan({ approximations: permissive }), docMapping),
		);
		expect(error.reason).toBe("permissive-approximation");
	});

	it("compiles with both halves of the opt-in", () => {
		const plan = conditionalPlan(
			{ op: "cmp", cmp: "eq", attr: attr("status"), value: str("draft") },
			{ approximations: permissive, postFilter: noopPostFilter },
		);
		const rendered = renderSql(
			planToSql(plan, docMapping, { allowPermissiveApproximations: true }),
		);
		expect(rendered.sql).toContain("status");
	});

	it("compiles a restrictive approximation without any opt-in", () => {
		// Restrictive over-blocks. That is a correctness problem for the application
		// and a safety property for the compiler, so it is not gated.
		const plan = conditionalPlan(
			{ op: "true" },
			{ approximations: [approximation("restrictive")] },
		);
		expect(renderSql(planToSql(plan, docMapping)).sql).toBe("true");
	});

	it("exempts ALWAYS_DENY, which selects nothing whatever it carries", () => {
		const plan = denyPlan({ approximations: permissive });
		expect(renderSql(planToSql(plan, docMapping)).sql).toBe("false");
	});
});

// ---------------------------------------------------------------------------
// Totality
// ---------------------------------------------------------------------------

/** Attribute names: the mapped ones, plus names no mapping declares. */
const ATTR_NAMES: readonly string[] = [
	"status",
	"title",
	"size",
	"archived",
	"publishedAt",
	"rate",
	"addr",
	"ttl",
	"owner",
	"folder",
	"labels",
	"tier",
	"tags",
	"clearance",
	"nope",
];

const valueArb: fc.Arbitrary<PlanValue> = fc.oneof(
	fc.string({ maxLength: 8 }).map((value) => ({ kind: "string", value }) as PlanValue),
	fc.bigInt({ min: -1000n, max: 1000n }).map((value) => ({ kind: "long", value }) as PlanValue),
	fc.boolean().map((value) => ({ kind: "bool", value }) as PlanValue),
	fc.date({ noInvalidDate: true }).map((value) => ({ kind: "datetime", value }) as PlanValue),
	fc.integer({ min: -1000, max: 1000 }).map((value) => ({ kind: "duration", value }) as PlanValue),
	fc.constantFrom("1.5", "0.0", "-3.125").map((value) => ({ kind: "decimal", value }) as PlanValue),
	fc.constantFrom("10.0.0.1", "fe80::1").map((value) => ({ kind: "ipaddr", value }) as PlanValue),
	fc
		.tuple(fc.constantFrom("User", "Folder", "Org", "Doc", "Galaxy"), fc.string({ maxLength: 6 }))
		.map(([type, id]) => ({ kind: "entity", value: { type, id } }) as PlanValue),
);

const setValueArb: fc.Arbitrary<PlanValue> = fc
	.array(valueArb, { maxLength: 3 })
	.map((value) => ({ kind: "set", value }) as PlanValue);

const attrArb: fc.Arbitrary<{ root: "resource" | "principal"; path: readonly string[] }> = fc.oneof(
	{ arbitrary: fc.constantFrom(...ATTR_NAMES).map((name) => attr(name)), weight: 9 },
	{ arbitrary: fc.constantFrom(...ATTR_NAMES).map((name) => principalAttr(name)), weight: 1 },
	{
		arbitrary: fc
			.tuple(fc.constantFrom(...ATTR_NAMES), fc.constantFrom(...ATTR_NAMES))
			.map(([a, b]) => ({ root: "resource" as const, path: [a, b] })),
		weight: 1,
	},
);

const likeTokenArb = fc.oneof(
	fc.string({ maxLength: 4 }).map((literal) => ({ literal })),
	fc.constant({ wildcard: true } as const),
);

const parentArb = fc
	.tuple(fc.constantFrom("Doc", "Folder", "Org", "Tenant", "Galaxy"), fc.string({ maxLength: 6 }))
	.map(([type, id]) => ({ type, id }));

const leafNodeArb: fc.Arbitrary<PlanNode> = fc.oneof(
	fc.constant({ op: "true" } as PlanNode),
	fc.constant({ op: "false" } as PlanNode),
	fc
		.tuple(
			fc.constantFrom("eq", "ne", "lt", "lte", "gt", "gte"),
			attrArb,
			fc.oneof(valueArb, setValueArb),
		)
		.map(([cmp, path, value]) => ({ op: "cmp", cmp, attr: path, value }) as PlanNode),
	fc
		.tuple(attrArb, fc.array(valueArb, { maxLength: 3 }))
		.map(([path, values]) => ({ op: "in", attr: path, values }) as PlanNode),
	fc
		.tuple(attrArb, valueArb)
		.map(([path, value]) => ({ op: "contains", attr: path, value }) as PlanNode),
	fc
		.tuple(attrArb, fc.array(likeTokenArb, { maxLength: 4 }))
		.map(([path, pattern]) => ({ op: "like", attr: path, pattern }) as PlanNode),
	attrArb.map((path) => ({ op: "exists", attr: path }) as PlanNode),
	attrArb.map((path) => ({ op: "isEmpty", attr: path }) as PlanNode),
	fc
		.constantFrom("Doc", "Run", "Folder")
		.map((entityType) => ({ op: "isType", entityType }) as PlanNode),
	fc
		.tuple(fc.option(attrArb, { nil: null }), parentArb)
		.map(([path, parent]) => ({ op: "inHierarchy", attr: path, parent }) as PlanNode),
);

const nodeArb: fc.Arbitrary<PlanNode> = fc.letrec<{ node: PlanNode }>((tie) => ({
	node: fc.oneof(
		{ maxDepth: 3, withCrossShrink: true },
		leafNodeArb,
		fc.array(tie("node"), { maxLength: 3 }).map((list) => ({ op: "and", nodes: list }) as PlanNode),
		fc.array(tie("node"), { maxLength: 3 }).map((list) => ({ op: "or", nodes: list }) as PlanNode),
		tie("node").map((child) => ({ op: "not", node: child }) as PlanNode),
	),
})).node;

const MAPPINGS: readonly (readonly [string, DrizzleResourceMapping<"Doc">])[] = [
	["full", docMapping],
	["empty", emptyMapping],
	["case-insensitive", caseInsensitiveMapping],
];

describe("totality", () => {
	it.each(MAPPINGS)(
		"never produces an absent or empty WHERE clause (%s mapping)",
		(label, mapping) => {
			const outcome = { compiled: 0, refused: 0 };

			fc.assert(
				fc.property(nodeArb, (node) => {
					let compiled: unknown;
					try {
						compiled = planNodeToSql(node, mapping);
					} catch (error) {
						// The only permitted failure mode. Anything else — a TypeError from a
						// missing branch, a RangeError from a bad cast — is a bug, because a
						// caller cannot distinguish it from a genuine refusal.
						if (!isPlanCompilationError(error)) {
							throw error;
						}
						outcome.refused += 1;
						return;
					}

					outcome.compiled += 1;
					expect(compiled).toBeDefined();
					const rendered = renderSql(compiled as never);
					expect(rendered.sql.trim().length).toBeGreaterThan(0);
				}),
				{ numRuns: 600 },
			);

			// A property whose every case threw would pass the assertion above without
			// having compiled a single node, so both outcomes are required to occur.
			// The `empty` mapping declares no attributes, so only the constant and
			// junction nodes survive there — hence the low floor.
			expect(outcome.refused, `${label}: nothing was refused`).toBeGreaterThan(0);
			expect(outcome.compiled, `${label}: nothing compiled`).toBeGreaterThan(
				label === "empty" ? 5 : 50,
			);
		},
	);

	it("returns a non-empty clause for each of the three plan kinds", () => {
		expect(renderSql(planToSql(allowPlan(), docMapping)).sql).toBe("true");
		expect(renderSql(planToSql(denyPlan(), docMapping)).sql).toBe("false");
		expect(renderSql(planToSql(conditionalPlan({ op: "true" }), docMapping)).sql).toBe("true");
	});

	it("compiles an empty conjunction to `true` and an empty disjunction to `false`", () => {
		// The identities of the operations, and the two answers that make an empty
		// permit set deny and an empty forbid set permit.
		expect(renderSql(planNodeToSql({ op: "and", nodes: [] }, docMapping)).sql).toBe("true");
		expect(renderSql(planNodeToSql({ op: "or", nodes: [] }, docMapping)).sql).toBe("false");
	});

	it("compiles an empty IN list to `false`, never to an omitted clause", () => {
		// `col IN ()` is a Postgres syntax error, and dropping the term would select
		// every row. `false` is the only sound answer.
		expect(
			renderSql(planNodeToSql({ op: "in", attr: attr("status"), values: [] }, docMapping)).sql,
		).toBe("false");
	});

	it("compiles an entity IN list of wholly foreign types to `false`", () => {
		const node: PlanNode = {
			op: "in",
			attr: attr("owner"),
			values: [ref("Folder", "f1"), ref("Org", "o1")],
		};
		expect(renderSql(planNodeToSql(node, docMapping)).sql).toBe("false");
	});

	it("never emits COALESCE, and never emits NOT IN", () => {
		// Both are named in the design as the two spellings that convert "we could
		// not evaluate this" into "everyone may see this row".
		fc.assert(
			fc.property(nodeArb, (node) => {
				let compiled: unknown;
				try {
					compiled = planNodeToSql(node, docMapping);
				} catch (error) {
					if (!isPlanCompilationError(error)) {
						throw error;
					}
					return;
				}
				const text = renderSql(compiled as never).sql.toLowerCase();
				expect(text).not.toContain("coalesce");
				expect(text).not.toContain("not in");
			}),
			{ numRuns: 400 },
		);
	});

	it("binds every value as a parameter — no literal reaches the statement text", () => {
		const node: PlanNode = {
			op: "and",
			nodes: [
				{ op: "cmp", cmp: "eq", attr: attr("status"), value: str("'; drop table docs; --") },
				{ op: "like", attr: attr("title"), pattern: [{ literal: "100%" }, { wildcard: true }] },
				{ op: "in", attr: attr("owner"), values: [ref("User", "u'1")] },
			],
		};
		const rendered = renderSql(planNodeToSql(node, docMapping));

		expect(rendered.sql).not.toContain("drop table");
		expect(rendered.params).toContain("'; drop table docs; --");
	});
});

// ---------------------------------------------------------------------------
// applyPlan inherits every guarantee
// ---------------------------------------------------------------------------

describe("applyPlan", () => {
	it("passes the compiled condition through and returns the builder", () => {
		const calls: unknown[] = [];
		const builder = {
			where(condition: unknown) {
				calls.push(condition);
				return "chained";
			},
		};

		const result = applyPlan(builder, allowPlan(), docMapping);
		expect(result).toBe("chained");
		expect(calls).toHaveLength(1);
		expect(renderSql(calls[0] as never).sql).toBe("true");
	});

	it("throws before touching the builder when the plan is uncompilable", () => {
		let touched = false;
		const builder = {
			where() {
				touched = true;
				return builder;
			},
		};

		expect(() =>
			applyPlan(
				builder,
				conditionalPlan({ op: "cmp", cmp: "eq", attr: attr("nope"), value: str("x") }),
				docMapping,
			),
		).toThrow(UnmappedAttributeError);
		expect(touched).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// The mapping's own structural guards
// ---------------------------------------------------------------------------

describe("structural mapping guards", () => {
	it("refuses a column whose reported SQL type is not a plain type name", () => {
		// `customType` may return an arbitrary string, and the compiler interpolates
		// it into an explicit cast. "The schema is trusted" is exactly the assumption
		// worth not making.
		// `Object.create`, not a spread: a spread would drop the prototype and with it
		// `instanceof Column`, which is what drizzle dispatches on — the fake would
		// then fail for the wrong reason.
		const hostile: typeof docs.labels = Object.assign(Object.create(docs.labels) as object, {
			getSQLType: () => "text[]; drop table docs; --",
		}) as typeof docs.labels;

		const mapping: DrizzleResourceMapping<"Doc"> = {
			...docMapping,
			attributes: {
				...docMapping.attributes,
				labels: { kind: "array", column: hostile, elementKind: "string" },
			},
		};

		const error = refusalOf({ op: "contains", attr: attr("labels"), value: str("a") }, mapping);
		expect(error.reason).toBe("invalid-mapping");
	});

	it("keeps the closure and recursive strategies parameterised", () => {
		const viaClosure = renderSql(
			planNodeToSql(
				{ op: "inHierarchy", attr: null, parent: { type: "Org", id: "o'1" } },
				docMapping,
			),
		);
		expect(viaClosure.sql).toContain('"doc_closure"');
		// Twice: once for the reflexive disjunct, once inside the EXISTS. A quote in
		// the id never reaches the statement text.
		expect(viaClosure.params).toEqual(["o'1", "o'1"]);
		expect(viaClosure.sql).not.toContain("o'1");

		const viaRecursive = renderSql(
			planNodeToSql(
				{ op: "inHierarchy", attr: null, parent: { type: "Tenant", id: "t1" } },
				docMapping,
			),
		);
		expect(viaRecursive.sql).toContain('"doc_nodes"');
		expect(viaRecursive.sql).toContain("with recursive");
		expect(viaRecursive.params).toEqual(["t1", "t1"]);
	});
});

/** A readable rendering of whatever was thrown, without relying on `toString()`. */
function describeThrown(thrown: unknown): string {
	if (thrown === undefined) {
		return "no throw at all";
	}
	if (thrown instanceof Error) {
		return `${thrown.name}: ${thrown.message}`;
	}
	return JSON.stringify(thrown);
}

/** Runs `run`, asserting it threw one of this package's compilation errors. */
function catchError(run: () => unknown): PlanCompilationError {
	try {
		run();
	} catch (error) {
		if (isPlanCompilationError(error)) {
			return error;
		}
		throw error;
	}
	throw new Error("Expected a PlanCompilationError, but nothing was thrown.");
}
