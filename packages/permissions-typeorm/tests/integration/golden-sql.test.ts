// Golden SQL, one case per `PlanNode` shape.
//
// Two assertions per case, and they answer different questions:
//
//   1. `getQueryAndParameters()` matches an **inline** snapshot. Inline, not a
//      `.snap` file, because the whole value of a golden test is that a reviewer
//      sees the SQL change in the diff next to the code change that caused it.
//   2. The query **runs** against real Postgres. A snapshot proves the compiler is
//      stable; only the server proves the SQL is valid, and `#>>` casts,
//      `cardinality`, `@>` and a recursive CTE inside `EXISTS` are four places
//      where "looks right" and "parses" are different claims.
//
// The node coverage here is the grammar, not the semantics — whether the rows are
// the *right* rows is the differential suite's job.

import type { PlanNode } from "@nestm/permissions-core/plan";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DataSource } from "typeorm";

import { planNodeToBrackets } from "../../src/compile/plan-to-brackets.ts";
import type { TypeOrmResourceMapping } from "../../src/compile/mapping.ts";
import {
	createDocEntities,
	docMappingColumnAndRecursive,
	docMappingJsonPath,
	docTableDdl,
	docTableDropDdl,
	seedDocs,
	seedHierarchy,
	type DocEntities,
} from "../fixtures/doc-population.ts";
import { PG_SKIPPED, PG_URL, assertPostgresReachable, uniqueSuffix } from "../fixtures/pg.ts";

const SCHEMA = uniqueSuffix("nestm_golden");
const PREFIX = "g_";

let dataSource: DataSource;
let entities: DocEntities;
let mapping: TypeOrmResourceMapping<"Doc">;
let jsonMapping: TypeOrmResourceMapping<"Doc">;

/**
 * `SELECT "doc"."id" … WHERE (<compiled>)`, as text + parameters.
 *
 * The per-worker schema name is replaced with `<schema>`: it is random by design
 * (so this file cannot collide with another worker, or with the Drizzle driver's
 * suites on the same server) and a snapshot carrying it would be rewritten on
 * every run, which is the opposite of what a golden test is for.
 */
function compile(node: PlanNode, target = mapping): [string, unknown[]] {
	const [text, parameters] = dataSource
		.createQueryBuilder(entities.docs, "doc")
		.select("doc.id")
		.andWhere(planNodeToBrackets(node, target))
		.getQueryAndParameters();
	return [text.replaceAll(SCHEMA, "<schema>"), parameters];
}

/** Runs the compiled condition, proving Postgres accepts it. */
async function run(node: PlanNode, target = mapping): Promise<string[]> {
	const rows = await dataSource
		.createQueryBuilder(entities.docs, "doc")
		.select("doc.id", "id")
		.andWhere(planNodeToBrackets(node, target))
		.orderBy("doc.id")
		.getRawMany<{ id: string }>();
	return rows.map((row) => row.id);
}

const attr = (name: string) => ({ root: "resource", path: [name] }) as const;

describe.skipIf(PG_SKIPPED)("golden SQL", () => {
	beforeAll(async () => {
		await assertPostgresReachable();

		entities = createDocEntities(SCHEMA, PREFIX);
		dataSource = new DataSource({
			type: "postgres",
			url: PG_URL,
			entities: [entities.docs, entities.closure, entities.nodes],
			extra: { max: 4 },
		});
		await dataSource.initialize();

		for (const statement of docTableDdl(SCHEMA, PREFIX)) {
			await dataSource.query(statement);
		}

		mapping = docMappingColumnAndRecursive(dataSource, entities);
		jsonMapping = docMappingJsonPath(dataSource, entities);

		const rows = [
			{
				id: "d1",
				folder: "f1",
				owner: "u1",
				status: "draft",
				title: "alpha",
				size: 3,
				archived: false,
				labels: ["nightly"],
				publishedAt: new Date("2026-01-01T00:00:00.000Z"),
				reviewer: "u2",
				score: 7,
				rate: "1.50",
				addr: "10.0.0.1",
				ttl: 1000,
			},
			{
				id: "d2",
				folder: "f2",
				owner: "u2",
				status: "published",
				title: "50% off",
				size: 9,
				archived: true,
				labels: [],
			},
		];
		await seedDocs(dataSource, entities, rows);
		await seedHierarchy(dataSource, entities, rows);
	});

	afterAll(async () => {
		if (dataSource?.isInitialized) {
			await dataSource.query(docTableDropDdl(SCHEMA, PREFIX));
			await dataSource.query(`drop schema if exists "${SCHEMA}" cascade`);
			await dataSource.destroy();
		}
	});

	it("true / false are total, never an omitted clause", async () => {
		expect(compile({ op: "true" })[0]).toMatchInlineSnapshot(
			`"SELECT "doc"."id" AS "doc_id" FROM "<schema>"."g_docs" "doc" WHERE (1 = 1)"`,
		);
		expect(compile({ op: "false" })[0]).toMatchInlineSnapshot(
			`"SELECT "doc"."id" AS "doc_id" FROM "<schema>"."g_docs" "doc" WHERE (1 = 0)"`,
		);
		expect(await run({ op: "true" })).toEqual(["d1", "d2"]);
		expect(await run({ op: "false" })).toEqual([]);
	});

	it("empty and ⇒ 1 = 1, empty or ⇒ 1 = 0", async () => {
		expect(compile({ op: "and", nodes: [] })[0]).toMatchInlineSnapshot(
			`"SELECT "doc"."id" AS "doc_id" FROM "<schema>"."g_docs" "doc" WHERE (1 = 1)"`,
		);
		expect(compile({ op: "or", nodes: [] })[0]).toMatchInlineSnapshot(
			`"SELECT "doc"."id" AS "doc_id" FROM "<schema>"."g_docs" "doc" WHERE (1 = 0)"`,
		);
		expect(await run({ op: "and", nodes: [] })).toEqual(["d1", "d2"]);
		expect(await run({ op: "or", nodes: [] })).toEqual([]);
	});

	it("cmp on a string column", async () => {
		const node: PlanNode = {
			op: "cmp",
			cmp: "eq",
			attr: attr("status"),
			value: { kind: "string", value: "draft" },
		};
		expect(compile(node)).toMatchInlineSnapshot(`
			[
			  "SELECT "doc"."id" AS "doc_id" FROM "<schema>"."g_docs" "doc" WHERE ("doc"."status" = $1)",
			  [
			    "draft",
			  ],
			]
		`);
		expect(await run(node)).toEqual(["d1"]);
	});

	it("cmp on a long column binds text with an explicit ::bigint", async () => {
		const node: PlanNode = {
			op: "cmp",
			cmp: "gte",
			attr: attr("size"),
			value: { kind: "long", value: 5n },
		};
		expect(compile(node)).toMatchInlineSnapshot(`
			[
			  "SELECT "doc"."id" AS "doc_id" FROM "<schema>"."g_docs" "doc" WHERE ("doc"."size" >= $1::bigint)",
			  [
			    "5",
			  ],
			]
		`);
		expect(await run(node)).toEqual(["d2"]);
	});

	it("cmp on datetime / decimal / ipaddr / duration", async () => {
		expect(
			compile({
				op: "cmp",
				cmp: "lt",
				attr: attr("publishedAt"),
				value: { kind: "datetime", value: new Date("2026-06-01T00:00:00.000Z") },
			}),
		).toMatchInlineSnapshot(`
			[
			  "SELECT "doc"."id" AS "doc_id" FROM "<schema>"."g_docs" "doc" WHERE ("doc"."published_at" < $1::timestamptz)",
			  [
			    "2026-06-01T00:00:00.000Z",
			  ],
			]
		`);
		expect(
			compile({
				op: "cmp",
				cmp: "eq",
				attr: attr("rate"),
				value: { kind: "decimal", value: "1.5" },
			}),
		).toMatchInlineSnapshot(`
			[
			  "SELECT "doc"."id" AS "doc_id" FROM "<schema>"."g_docs" "doc" WHERE ("doc"."rate" = $1::numeric)",
			  [
			    "1.5",
			  ],
			]
		`);
		expect(
			compile({
				op: "cmp",
				cmp: "eq",
				attr: attr("addr"),
				value: { kind: "ipaddr", value: "10.0.0.1" },
			}),
		).toMatchInlineSnapshot(`
			[
			  "SELECT "doc"."id" AS "doc_id" FROM "<schema>"."g_docs" "doc" WHERE ("doc"."addr" = $1::inet)",
			  [
			    "10.0.0.1",
			  ],
			]
		`);
		expect(
			compile({
				op: "cmp",
				cmp: "lte",
				attr: attr("ttl"),
				value: { kind: "duration", value: 5000 },
			}),
		).toMatchInlineSnapshot(`
			[
			  "SELECT "doc"."id" AS "doc_id" FROM "<schema>"."g_docs" "doc" WHERE ("doc"."ttl_ms" <= $1::bigint)",
			  [
			    "5000",
			  ],
			]
		`);

		// `decimal("1.5") == decimal("1.50")` is true in Cedar; `numeric` agrees and
		// text equality would not.
		expect(
			await run({
				op: "cmp",
				cmp: "eq",
				attr: attr("rate"),
				value: { kind: "decimal", value: "1.5" },
			}),
		).toEqual(["d1"]);
		expect(
			await run({
				op: "cmp",
				cmp: "eq",
				attr: attr("addr"),
				value: { kind: "ipaddr", value: "10.0.0.1/32" },
			}),
		).toEqual(["d1"]);
	});

	it("entity comparison uses the id column and folds a foreign type", async () => {
		const same: PlanNode = {
			op: "cmp",
			cmp: "eq",
			attr: attr("owner"),
			value: { kind: "entity", value: { type: "User", id: "u1" } },
		};
		const foreign: PlanNode = {
			op: "cmp",
			cmp: "eq",
			attr: attr("owner"),
			value: { kind: "entity", value: { type: "Group", id: "u1" } },
		};
		expect(compile(same)).toMatchInlineSnapshot(`
			[
			  "SELECT "doc"."id" AS "doc_id" FROM "<schema>"."g_docs" "doc" WHERE ("doc"."owner_id" = $1)",
			  [
			    "u1",
			  ],
			]
		`);
		expect(compile(foreign)[0]).toMatchInlineSnapshot(
			`"SELECT "doc"."id" AS "doc_id" FROM "<schema>"."g_docs" "doc" WHERE (1 = 0)"`,
		);
		expect(await run(same)).toEqual(["d1"]);
		expect(await run(foreign)).toEqual([]);
	});

	it("in over a scalar column, and empty ⇒ 1 = 0", async () => {
		const node: PlanNode = {
			op: "in",
			attr: attr("status"),
			values: [
				{ kind: "string", value: "draft" },
				{ kind: "string", value: "published" },
			],
		};
		expect(compile(node)).toMatchInlineSnapshot(`
			[
			  "SELECT "doc"."id" AS "doc_id" FROM "<schema>"."g_docs" "doc" WHERE ("doc"."status" in ($1, $2))",
			  [
			    "draft",
			    "published",
			  ],
			]
		`);
		expect(compile({ op: "in", attr: attr("status"), values: [] })[0]).toMatchInlineSnapshot(
			`"SELECT "doc"."id" AS "doc_id" FROM "<schema>"."g_docs" "doc" WHERE (1 = 0)"`,
		);
		expect(await run(node)).toEqual(["d1", "d2"]);
		expect(await run({ op: "in", attr: attr("status"), values: [] })).toEqual([]);
	});

	it("contains and isEmpty over an array column", async () => {
		const contains: PlanNode = {
			op: "contains",
			attr: attr("labels"),
			value: { kind: "string", value: "nightly" },
		};
		expect(compile(contains)).toMatchInlineSnapshot(`
			[
			  "SELECT "doc"."id" AS "doc_id" FROM "<schema>"."g_docs" "doc" WHERE ("doc"."labels" @> array[$1]::text[])",
			  [
			    "nightly",
			  ],
			]
		`);
		expect(compile({ op: "isEmpty", attr: attr("labels") })[0]).toMatchInlineSnapshot(
			`"SELECT "doc"."id" AS "doc_id" FROM "<schema>"."g_docs" "doc" WHERE (cardinality("doc"."labels") = 0)"`,
		);
		expect(await run(contains)).toEqual(["d1"]);
		expect(await run({ op: "isEmpty", attr: attr("labels") })).toEqual(["d2"]);
	});

	it("set equality is mutual containment, not element-wise =", async () => {
		const node: PlanNode = {
			op: "cmp",
			cmp: "eq",
			attr: attr("labels"),
			value: { kind: "set", value: [{ kind: "string", value: "nightly" }] },
		};
		expect(compile(node)).toMatchInlineSnapshot(`
			[
			  "SELECT "doc"."id" AS "doc_id" FROM "<schema>"."g_docs" "doc" WHERE (("doc"."labels" @> array[$1]::text[] and "doc"."labels" <@ array[$1]::text[]))",
			  [
			    "nightly",
			  ],
			]
		`);
		expect(await run(node)).toEqual(["d1"]);
	});

	it("like binds both the pattern and the escape character", async () => {
		const node: PlanNode = {
			op: "like",
			attr: attr("title"),
			pattern: [{ literal: "50%" }, { wildcard: true }],
		};
		expect(compile(node)).toMatchInlineSnapshot(`
			[
			  "SELECT "doc"."id" AS "doc_id" FROM "<schema>"."g_docs" "doc" WHERE ("doc"."title" like $1 escape $2)",
			  [
			    "50\\%%",
			    "\\",
			  ],
			]
		`);
		expect(await run(node)).toEqual(["d2"]);
	});

	it("exists is IS NOT NULL", async () => {
		expect(compile({ op: "exists", attr: attr("score") })[0]).toMatchInlineSnapshot(
			`"SELECT "doc"."id" AS "doc_id" FROM "<schema>"."g_docs" "doc" WHERE ("doc"."score" is not null)"`,
		);
		expect(await run({ op: "exists", attr: attr("score") })).toEqual(["d1"]);
	});

	it("not is parenthesised and stays three-valued", async () => {
		// `not(cmp eq)` is folded to `cmp ne` by core's `simplifyPlanNode`, so this
		// uses a node it does not fold — otherwise the case would assert nothing
		// about `negate()` at all.
		const node: PlanNode = {
			op: "not",
			node: { op: "in", attr: attr("score"), values: [{ kind: "long", value: 7n }] },
		};
		expect(compile(node)[0]).toMatchInlineSnapshot(
			`"SELECT "doc"."id" AS "doc_id" FROM "<schema>"."g_docs" "doc" WHERE ((not "doc"."score" in ($1::bigint)))"`,
		);
		// Both rows are dropped: d1's score *is* 7, and d2's is NULL, which makes
		// `NOT (NULL in (7))` NULL. No `COALESCE`, no `IS NOT TRUE` — a forbid that
		// could not be evaluated must not stop being a forbid.
		expect(await run(node)).toEqual([]);
		// The un-negated form keeps d1, so the emptiness above is the negation and
		// not an accident of the fixture.
		expect(
			await run({ op: "in", attr: attr("score"), values: [{ kind: "long", value: 7n }] }),
		).toEqual(["d1"]);
	});

	it("inHierarchy self compiles to the id column, not a parent lookup", async () => {
		const node: PlanNode = { op: "inHierarchy", attr: null, parent: { type: "Doc", id: "d1" } };
		expect(compile(node)).toMatchInlineSnapshot(`
			[
			  "SELECT "doc"."id" AS "doc_id" FROM "<schema>"."g_docs" "doc" WHERE ("doc"."id" = $1)",
			  [
			    "d1",
			  ],
			]
		`);
		expect(await run(node)).toEqual(["d1"]);
	});

	it("inHierarchy column compiles to the denormalised column", async () => {
		const node: PlanNode = { op: "inHierarchy", attr: null, parent: { type: "Folder", id: "f1" } };
		expect(compile(node)).toMatchInlineSnapshot(`
			[
			  "SELECT "doc"."id" AS "doc_id" FROM "<schema>"."g_docs" "doc" WHERE ("doc"."folder_id" = $1)",
			  [
			    "f1",
			  ],
			]
		`);
		expect(await run(node)).toEqual(["d1"]);
	});

	it("inHierarchy recursive walks down from the constant parent", async () => {
		const node: PlanNode = { op: "inHierarchy", attr: null, parent: { type: "Org", id: "o1" } };
		expect(compile(node)[0]).toMatchInlineSnapshot(
			`"SELECT "doc"."id" AS "doc_id" FROM "<schema>"."g_docs" "doc" WHERE (("doc"."id" = $1 or exists (with recursive "nestmp_h0"("node") as (select $1::text union select "nestmp_h1"."id" from "<schema>"."g_nodes" "nestmp_h1" join "nestmp_h0" on "nestmp_h1"."parent_id" = "nestmp_h0"."node") select 1 from "nestmp_h0" where "nestmp_h0"."node" = "doc"."id")))"`,
		);
		expect(await run(node)).toEqual(["d1", "d2"]);
	});

	it("inHierarchy closure, rooted at an attribute", async () => {
		const node: PlanNode = {
			op: "inHierarchy",
			attr: attr("folder"),
			parent: { type: "Org", id: "o1" },
		};
		expect(compile(node)[0]).toMatchInlineSnapshot(
			`"SELECT "doc"."id" AS "doc_id" FROM "<schema>"."g_docs" "doc" WHERE (("doc"."folder_id" = $1 or exists (select 1 from "<schema>"."g_closure" "nestmp_h0" where "nestmp_h0"."descendant" = "doc"."folder_id" and "nestmp_h0"."ancestor" = $1)))"`,
		);
		expect(await run(node)).toEqual(["d1", "d2"]);
	});

	it("jsonPath reads through #>> with a bound path and a cast", async () => {
		const node: PlanNode = {
			op: "cmp",
			cmp: "gte",
			attr: attr("size"),
			value: { kind: "long", value: 5n },
		};
		expect(compile(node, jsonMapping)).toMatchInlineSnapshot(`
			[
			  "SELECT "doc"."id" AS "doc_id" FROM "<schema>"."g_docs" "doc" WHERE (("doc"."meta" #>> $1::text[])::bigint >= $2::bigint)",
			  [
			    [
			      "size",
			    ],
			    "5",
			  ],
			]
		`);
		expect(await run(node, jsonMapping)).toEqual(["d2"]);
	});

	it("jsonPath contains and isEmpty use jsonb containment and length", async () => {
		const contains: PlanNode = {
			op: "contains",
			attr: attr("labels"),
			value: { kind: "string", value: "nightly" },
		};
		expect(compile(contains, jsonMapping)).toMatchInlineSnapshot(`
			[
			  "SELECT "doc"."id" AS "doc_id" FROM "<schema>"."g_docs" "doc" WHERE (("doc"."meta" #> $1::text[]) @> $2::jsonb)",
			  [
			    [
			      "labels",
			    ],
			    "["nightly"]",
			  ],
			]
		`);
		expect(compile({ op: "isEmpty", attr: attr("labels") }, jsonMapping)[0]).toMatchInlineSnapshot(
			`"SELECT "doc"."id" AS "doc_id" FROM "<schema>"."g_docs" "doc" WHERE (jsonb_array_length(("doc"."meta" #> $1::text[])) = 0)"`,
		);
		expect(await run(contains, jsonMapping)).toEqual(["d1"]);
		expect(await run({ op: "isEmpty", attr: attr("labels") }, jsonMapping)).toEqual(["d2"]);
	});
});
