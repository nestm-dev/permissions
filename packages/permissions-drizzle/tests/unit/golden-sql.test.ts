// One readable golden statement per `PlanNode` op, plus all four hierarchy
// strategies.
//
// Written as explicit `{ sql, params }` literals rather than
// `toMatchInlineSnapshot`, because the point is to be **read**. A reviewer
// looking at a diff of this file should be able to answer "did the emitted SQL
// change, and is the new one still sound?" without running anything — and a
// snapshot that is regenerated with `-u` is a snapshot nobody reads.
//
// Three properties are visible in every entry and are the reason the goldens
// exist at all:
//
//   * **every value is a `$n`.** No literal, no identifier from a plan, no
//     pattern is ever concatenated into the statement text.
//   * **the two constants are `true`/`false`,** never an omitted clause.
//   * **`inHierarchy` always leads with the reflexive disjunct** (`col = $p or
//     …`), because Cedar's `in` is descendant-**or-self** and a closure table
//     that stores no self-pairs must still match the seed row.
//
// The last group runs every golden statement against real Postgres. A golden
// that is stable and invalid is worse than no golden: it pins a bug in place.
// (That group is not hypothetical — it is what caught the `jsonPath` binding
// documented in `docs/design/errata.md`.)

import type { PlanNode } from "@nestm/permissions-core/plan";
import { sql } from "drizzle-orm";
import { beforeAll, afterAll, describe, expect, it } from "vitest";

import { planNodeToSql, planToSql } from "../../src/compile/plan-to-sql.ts";
import type { DrizzleResourceMapping } from "../../src/compile/mapping.ts";
import {
	allowPlan,
	attr,
	conditionalPlan,
	denyPlan,
	docMapping,
	renderSql,
	tildeEscapeMapping,
} from "../fixtures/compile.ts";
import { PG_SKIPPED, assertPostgresReachable, openPg } from "../fixtures/pg.ts";

interface Golden {
	/** Group heading — one per `PlanNode` op. */
	readonly op: string;
	readonly name: string;
	readonly node: PlanNode;
	readonly mapping?: DrizzleResourceMapping<"Doc">;
	readonly sql: string;
	readonly params: readonly unknown[];
}

const GOLDENS: readonly Golden[] = [
	// -- constants -----------------------------------------------------------
	{ op: "true", name: "matches every row", node: { op: "true" }, sql: "true", params: [] },
	{ op: "false", name: "matches no row", node: { op: "false" }, sql: "false", params: [] },

	// -- junctions -----------------------------------------------------------
	{
		op: "and",
		name: "parenthesised, one term per child",
		node: {
			op: "and",
			nodes: [
				{ op: "cmp", cmp: "eq", attr: attr("status"), value: { kind: "string", value: "a" } },
				{ op: "cmp", cmp: "eq", attr: attr("archived"), value: { kind: "bool", value: false } },
			],
		},
		sql: '("docs"."status" = $1 and "docs"."archived" = $2)',
		params: ["a", false],
	},
	{
		op: "or",
		name: "parenthesised, one term per child",
		node: {
			op: "or",
			nodes: [
				{ op: "cmp", cmp: "eq", attr: attr("status"), value: { kind: "string", value: "a" } },
				{ op: "cmp", cmp: "eq", attr: attr("status"), value: { kind: "string", value: "b" } },
			],
		},
		sql: '("docs"."status" = $1 or "docs"."status" = $2)',
		params: ["a", "b"],
	},
	{
		op: "not",
		name: "plain NOT — no COALESCE, no IS NOT TRUE, so NULL still drops the row",
		node: { op: "not", node: { op: "like", attr: attr("title"), pattern: [{ literal: "a" }] } },
		sql: '(not "docs"."title" like $1 escape $2)',
		params: ["a", "\\"],
	},

	// -- cmp -----------------------------------------------------------------
	{
		op: "cmp",
		name: "eq against a string column — bound with no cast, so citext/enum/uuid all work",
		node: { op: "cmp", cmp: "eq", attr: attr("status"), value: { kind: "string", value: "draft" } },
		sql: '"docs"."status" = $1',
		params: ["draft"],
	},
	{
		op: "cmp",
		name: "ne against a long — bound as text with ::bigint, exact past 2^53",
		node: {
			op: "cmp",
			cmp: "ne",
			attr: attr("size"),
			value: { kind: "long", value: 9_007_199_254_740_993n },
		},
		sql: '"docs"."size" <> $1::bigint',
		params: ["9007199254740993"],
	},
	{
		op: "cmp",
		name: "lt against a long",
		node: { op: "cmp", cmp: "lt", attr: attr("size"), value: { kind: "long", value: 5n } },
		sql: '"docs"."size" < $1::bigint',
		params: ["5"],
	},
	{
		op: "cmp",
		name: "gte against a datetime — ISO-8601 with ::timestamptz, never a driver-rendered Date",
		node: {
			op: "cmp",
			cmp: "gte",
			attr: attr("publishedAt"),
			value: { kind: "datetime", value: new Date("2026-01-01T00:00:00.000Z") },
		},
		sql: '"docs"."published_at" >= $1::timestamptz',
		params: ["2026-01-01T00:00:00.000Z"],
	},
	{
		op: "cmp",
		name: "lte against a duration — signed milliseconds, same binding as a long",
		node: { op: "cmp", cmp: "lte", attr: attr("ttl"), value: { kind: "duration", value: 60_000 } },
		sql: '"docs"."ttl_ms" <= $1::bigint',
		params: ["60000"],
	},
	{
		op: "cmp",
		name: "eq against a decimal — ::numeric, so 1.5 = 1.50 as Cedar says and text equality does not",
		node: { op: "cmp", cmp: "eq", attr: attr("rate"), value: { kind: "decimal", value: "1.50" } },
		sql: '"docs"."rate" = $1::numeric',
		params: ["1.50"],
	},
	{
		op: "cmp",
		name: "eq against an ipaddr — ::inet compares address AND prefix, Cedar's rule",
		node: {
			op: "cmp",
			cmp: "eq",
			attr: attr("addr"),
			value: { kind: "ipaddr", value: "10.0.0.0/8" },
		},
		sql: '"docs"."addr" = $1::inet',
		params: ["10.0.0.0/8"],
	},
	{
		op: "cmp",
		name: "eq against a bool",
		node: { op: "cmp", cmp: "eq", attr: attr("archived"), value: { kind: "bool", value: true } },
		sql: '"docs"."archived" = $1',
		params: [true],
	},
	{
		op: "cmp",
		name: "eq against an entity — the id is bound, the type is checked at compile time",
		node: {
			op: "cmp",
			cmp: "eq",
			attr: attr("owner"),
			value: { kind: "entity", value: { type: "User", id: "u1" } },
		},
		sql: '"docs"."owner_id" = $1',
		params: ["u1"],
	},
	{
		op: "cmp",
		name: "ne against an entity of a foreign type folds to `true` — exactly, not approximately",
		node: {
			op: "cmp",
			cmp: "ne",
			attr: attr("owner"),
			value: { kind: "entity", value: { type: "Folder", id: "f1" } },
		},
		sql: "true",
		params: [],
	},
	{
		op: "cmp",
		name: "eq against a set — mutual containment, because Cedar sets are unordered and dedup",
		node: {
			op: "cmp",
			cmp: "eq",
			attr: attr("labels"),
			value: {
				kind: "set",
				value: [
					{ kind: "string", value: "a" },
					{ kind: "string", value: "b" },
				],
			},
		},
		sql: '("docs"."labels" @> array[$1, $2]::text[] and "docs"."labels" <@ array[$3, $4]::text[])',
		params: ["a", "b", "a", "b"],
	},
	{
		op: "cmp",
		name: "eq through a jsonPath — the whole path is ONE text[] parameter",
		node: { op: "cmp", cmp: "eq", attr: attr("tier"), value: { kind: "string", value: "gold" } },
		sql: '("docs"."meta" #>> $1) = $2',
		params: [["tier"], "gold"],
	},

	// -- in ------------------------------------------------------------------
	{
		op: "in",
		name: "a bound list, never a NOT IN and never an empty ()",
		node: {
			op: "in",
			attr: attr("status"),
			values: [
				{ kind: "string", value: "a" },
				{ kind: "string", value: "b" },
			],
		},
		sql: '"docs"."status" in ($1, $2)',
		params: ["a", "b"],
	},
	{
		op: "in",
		name: "entity list drops constants of a type the column cannot hold",
		node: {
			op: "in",
			attr: attr("owner"),
			values: [
				{ kind: "entity", value: { type: "User", id: "u1" } },
				{ kind: "entity", value: { type: "Folder", id: "f1" } },
			],
		},
		sql: '"docs"."owner_id" in ($1)',
		params: ["u1"],
	},
	{
		op: "in",
		name: "empty list ⇒ false",
		node: { op: "in", attr: attr("status"), values: [] },
		sql: "false",
		params: [],
	},

	// -- contains ------------------------------------------------------------
	{
		op: "contains",
		name: "array column — @> against a one-element array cast to the column's own type",
		node: { op: "contains", attr: attr("labels"), value: { kind: "string", value: "urgent" } },
		sql: '"docs"."labels" @> array[$1]::text[]',
		params: ["urgent"],
	},
	{
		op: "contains",
		name: "jsonb path — @> against a one-element JSON array",
		node: { op: "contains", attr: attr("tags"), value: { kind: "string", value: "urgent" } },
		sql: '("docs"."meta" #> $1) @> $2::jsonb',
		params: [["tags"], '["urgent"]'],
	},

	// -- like ----------------------------------------------------------------
	{
		op: "like",
		name: "literal % and _ are escaped, the wildcard token becomes %, escape char is bound",
		node: {
			op: "like",
			attr: attr("title"),
			pattern: [{ literal: "50%" }, { wildcard: true }, { literal: "_x\\" }],
		},
		sql: '"docs"."title" like $1 escape $2',
		params: ["50\\%%\\_x\\\\", "\\"],
	},
	{
		op: "like",
		name: "a custom escape character travels into both the pattern and the ESCAPE clause",
		node: { op: "like", attr: attr("title"), pattern: [{ literal: "50%" }, { wildcard: true }] },
		mapping: tildeEscapeMapping,
		sql: '"docs"."title" like $1 escape $2',
		params: ["50~%%", "~"],
	},

	// -- exists --------------------------------------------------------------
	{
		op: "exists",
		name: "IS NOT NULL on a plain column",
		node: { op: "exists", attr: attr("publishedAt") },
		sql: '"docs"."published_at" is not null',
		params: [],
	},
	{
		op: "exists",
		name: "IS NOT NULL through a json path — a JSON null reads as absent, as Cedar does",
		node: { op: "exists", attr: attr("tier") },
		sql: '("docs"."meta" #>> $1) is not null',
		params: [["tier"]],
	},

	// -- isEmpty -------------------------------------------------------------
	{
		op: "isEmpty",
		name: "cardinality(), not coalesce(array_length(…),0): NULL must stay NULL",
		node: { op: "isEmpty", attr: attr("labels") },
		sql: 'cardinality("docs"."labels") = 0',
		params: [],
	},
	{
		op: "isEmpty",
		name: "jsonb_array_length() through a json path",
		node: { op: "isEmpty", attr: attr("tags") },
		sql: 'jsonb_array_length(("docs"."meta" #> $1)) = 0',
		params: [["tags"]],
	},

	// -- isType --------------------------------------------------------------
	{
		op: "isType",
		name: "the mapped type ⇒ true",
		node: { op: "isType", entityType: "Doc" },
		sql: "true",
		params: [],
	},
	{
		op: "isType",
		name: "any other type ⇒ false",
		node: { op: "isType", entityType: "Run" },
		sql: "false",
		params: [],
	},

	// -- inHierarchy: all four strategies ------------------------------------
	{
		op: "inHierarchy",
		name: "{ kind: 'self' } ⇒ id = $p, because Cedar `in` is reflexive",
		node: { op: "inHierarchy", attr: null, parent: { type: "Doc", id: "d1" } },
		sql: '"docs"."id" = $1',
		params: ["d1"],
	},
	{
		op: "inHierarchy",
		name: "{ kind: 'column' } ⇒ the denormalised ancestor column",
		node: { op: "inHierarchy", attr: null, parent: { type: "Folder", id: "f1" } },
		sql: '"docs"."folder_id" = $1',
		params: ["f1"],
	},
	{
		op: "inHierarchy",
		name: "{ kind: 'closure' } ⇒ reflexive disjunct OR EXISTS over the closure table",
		node: { op: "inHierarchy", attr: null, parent: { type: "Org", id: "o1" } },
		sql:
			'("docs"."id" = $1 or exists (select 1 from "doc_closure" ' +
			'where "doc_closure"."descendant" = "docs"."id" and "doc_closure"."ancestor" = $2))',
		params: ["o1", "o1"],
	},
	{
		op: "inHierarchy",
		name: "{ kind: 'recursive' } ⇒ reflexive disjunct OR a UNION (cycle-safe) CTE walked downwards",
		node: { op: "inHierarchy", attr: null, parent: { type: "Tenant", id: "t1" } },
		sql:
			'("docs"."id" = $1 or exists (with recursive nestm_permissions_hierarchy(node) as ' +
			'(select $2::text union select "doc_nodes"."id" from "doc_nodes" ' +
			'join nestm_permissions_hierarchy on "doc_nodes"."parent_id" = nestm_permissions_hierarchy.node) ' +
			'select 1 from nestm_permissions_hierarchy where nestm_permissions_hierarchy.node = "docs"."id"))',
		params: ["t1", "t1"],
	},
	{
		op: "inHierarchy",
		name: "rooted at an attribute, { kind: 'self' } ⇒ the reference column",
		node: { op: "inHierarchy", attr: attr("folder"), parent: { type: "Folder", id: "f1" } },
		sql: '"docs"."folder_id" = $1',
		params: ["f1"],
	},
	{
		op: "inHierarchy",
		name: "rooted at an attribute, the closure is seeded from the reference column",
		node: { op: "inHierarchy", attr: attr("folder"), parent: { type: "Org", id: "o1" } },
		sql:
			'("docs"."folder_id" = $1 or exists (select 1 from "doc_closure" ' +
			'where "doc_closure"."descendant" = "docs"."folder_id" and "doc_closure"."ancestor" = $2))',
		params: ["o1", "o1"],
	},
];

describe("golden SQL", () => {
	for (const golden of GOLDENS) {
		it(`${golden.op}: ${golden.name}`, () => {
			const rendered = renderSql(planNodeToSql(golden.node, golden.mapping ?? docMapping));
			expect(rendered.sql).toBe(golden.sql);
			expect(rendered.params).toEqual([...golden.params]);
		});
	}

	it("covers every PlanNode op", () => {
		const OPS: readonly string[] = [
			"true",
			"false",
			"and",
			"or",
			"not",
			"cmp",
			"in",
			"contains",
			"like",
			"exists",
			"isEmpty",
			"isType",
			"inHierarchy",
		];
		expect([...new Set(GOLDENS.map((golden) => golden.op))].toSorted()).toEqual(
			[...OPS].toSorted(),
		);
	});

	it("covers all four hierarchy strategies", () => {
		const hierarchy = GOLDENS.filter((golden) => golden.op === "inHierarchy");
		expect(hierarchy.map((golden) => golden.name).join(" ")).toMatch(/'self'/);
		expect(hierarchy.map((golden) => golden.name).join(" ")).toMatch(/'column'/);
		expect(hierarchy.map((golden) => golden.name).join(" ")).toMatch(/'closure'/);
		expect(hierarchy.map((golden) => golden.name).join(" ")).toMatch(/'recursive'/);
	});

	it("renders the three plan kinds", () => {
		expect(renderSql(planToSql(allowPlan(), docMapping)).sql).toBe("true");
		expect(renderSql(planToSql(denyPlan(), docMapping)).sql).toBe("false");
		expect(
			renderSql(
				planToSql(
					conditionalPlan({
						op: "cmp",
						cmp: "eq",
						attr: attr("status"),
						value: { kind: "string", value: "draft" },
					}),
					docMapping,
				),
			).sql,
		).toBe('"docs"."status" = $1');
	});

	it("never interpolates a value into the statement text", () => {
		for (const golden of GOLDENS) {
			for (const parameter of golden.params) {
				if (typeof parameter === "string" && parameter.length > 1) {
					expect(golden.sql).not.toContain(parameter);
				}
			}
		}
	});
});

// ---------------------------------------------------------------------------
// Postgres has to accept every one of them
// ---------------------------------------------------------------------------

describe.skipIf(PG_SKIPPED)("golden SQL is valid Postgres", () => {
	let pg: ReturnType<typeof openPg>;

	beforeAll(async () => {
		await assertPostgresReachable();
		pg = openPg();
		// The fixture tables under their real names, in a throwaway schema so two
		// workers cannot collide and nothing lands in `public`.
		await pg.db.execute(sql.raw(`drop schema if exists golden_sql_probe cascade`));
		await pg.db.execute(sql.raw(`create schema golden_sql_probe`));
		await pg.db.execute(
			sql.raw(`create table golden_sql_probe.docs (
				"id" text primary key, "folder_id" text, "tenant_id" text, "owner_id" text,
				"status" text, "title" text, "size" bigint, "archived" boolean,
				"labels" text[], "published_at" timestamptz, "rate" numeric, "addr" inet,
				"ttl_ms" bigint, "meta" jsonb
			)`),
		);
		await pg.db.execute(
			sql.raw(
				`create table golden_sql_probe.doc_closure ("ancestor" text not null, "descendant" text not null)`,
			),
		);
		await pg.db.execute(
			sql.raw(`create table golden_sql_probe.doc_nodes ("id" text primary key, "parent_id" text)`),
		);
	});

	afterAll(async () => {
		if (pg !== undefined) {
			await pg.db.execute(sql.raw(`drop schema if exists golden_sql_probe cascade`));
			await pg.close();
		}
	});

	for (const golden of GOLDENS) {
		it(`${golden.op}: ${golden.name}`, async () => {
			// Every statement runs. A golden that is stable and *invalid* pins a bug in
			// place; this is the assertion that stops that happening.
			const condition = planNodeToSql(golden.node, golden.mapping ?? docMapping);

			// Inside a transaction, because that is the one way to be sure the
			// `search_path` and the query land on the *same* pooled connection — the
			// compiled `EXISTS` names `doc_closure` unqualified, exactly as it would in
			// a consumer's own schema.
			await pg.db.transaction(async (tx) => {
				await tx.execute(sql.raw(`set local search_path to golden_sql_probe`));
				await tx.execute(sql`select "id" from docs where ${condition}`);
			});
		});
	}
});
