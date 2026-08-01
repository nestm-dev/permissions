// Value binding — the four kinds where "obvious" is wrong.
//
// Each case here is an erratum or a design note that says, in effect, "Postgres
// and Cedar agree about this *if* you bind it the right way, and disagree if you
// bind it the way you would guess".
//
//   * **`long` as text with `::bigint`.** `PlanValue.long` is a `bigint`; neither
//     `JSON.stringify` nor node-postgres will serialise one, and `Number(value)`
//     rounds silently past 2^53.
//   * **`decimal` as text with `::numeric`.** Cedar's `decimal("1.5") ==
//     decimal("1.50")` is `true`; `numeric` agrees, text equality does not, and a
//     float would introduce error Cedar's fixed-point type does not have.
//   * **`ipaddr` as text with `::inet`** (errata 21). Cedar's `==` compares the
//     address *and* the prefix length: `ip("1.2.3.4") == ip("1.2.3.4/32")` is
//     true, `ip("1.2.3.0/24") == ip("1.2.3.0/25")` is false, and zero-compression
//     and hex case are not significant. `inet` has exactly those semantics; text
//     equality gets five of those cases wrong and network containment gets others.
//   * **`datetime` as ISO-8601 with `::timestamptz`.** A `Date` handed to a driver
//     renders in whatever timezone it feels like.

import type { PlanNode, PlanValue } from "@nestm/permissions-core/plan";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DataSource } from "typeorm";

import { planNodeToBrackets } from "../../src/compile/plan-to-brackets.ts";
import type { TypeOrmResourceMapping } from "../../src/compile/mapping.ts";
import {
	createDocEntities,
	docMappingColumnAndRecursive,
	docTableDdl,
	docTableDropDdl,
	seedDocs,
	seedHierarchy,
	type DocEntities,
	type DocRow,
} from "../fixtures/doc-population.ts";
import { PG_SKIPPED, PG_URL, assertPostgresReachable, uniqueSuffix } from "../fixtures/pg.ts";

const SCHEMA = uniqueSuffix("nestm_values");
const PREFIX = "v_";

let dataSource: DataSource;
let entities: DocEntities;
let mapping: TypeOrmResourceMapping<"Doc">;

const base = {
	folder: "f1",
	owner: "u1",
	status: "draft",
	title: "t",
	size: 0,
	archived: false,
	labels: [] as string[],
} satisfies Omit<DocRow, "id">;

async function select(node: PlanNode): Promise<string[]> {
	const rows = await dataSource
		.createQueryBuilder(entities.docs, "doc")
		.select("doc.id", "id")
		.andWhere(planNodeToBrackets(node, mapping))
		.orderBy("doc.id")
		.getRawMany<{ id: string }>();
	return rows.map((row) => row.id);
}

const eq = (name: string, value: PlanValue): PlanNode => ({
	op: "cmp",
	cmp: "eq",
	attr: { root: "resource", path: [name] },
	value,
});

describe.skipIf(PG_SKIPPED)("value binding", () => {
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
	});

	afterAll(async () => {
		if (dataSource?.isInitialized) {
			await dataSource.query(docTableDropDdl(SCHEMA, PREFIX));
			await dataSource.query(`drop schema if exists "${SCHEMA}" cascade`);
			await dataSource.destroy();
		}
	});

	it("compares longs beyond 2^53 exactly", async () => {
		const big = 9_007_199_254_740_993n; // 2^53 + 1: not representable as a double
		await seedDocs(dataSource, entities, [
			{ ...base, id: "d1", score: Number(big) },
			{ ...base, id: "d2" },
		]);
		await seedHierarchy(dataSource, entities, []);

		// Written directly, because the fixture's `score` is a JS number and the point
		// is the *binding*, not the fixture.
		await dataSource.query(
			`update "${SCHEMA}"."${PREFIX}docs" set "score" = $1 where "id" = 'd1'`,
			[big.toString()],
		);

		expect(await select(eq("score", { kind: "long", value: big }))).toEqual(["d1"]);
		// The neighbouring integer must not match. `Number(big)` and `Number(big - 1n)`
		// are the *same double*, so a driver that bound a number would match both.
		expect(await select(eq("score", { kind: "long", value: big - 1n }))).toEqual([]);
	});

	it("compares decimals by value, not by text", async () => {
		await seedDocs(dataSource, entities, [
			{ ...base, id: "d1", rate: "1.50" },
			{ ...base, id: "d2", rate: "-3.125" },
		]);

		// `decimal("1.5") == decimal("1.50")` is true in Cedar; `numeric` agrees.
		expect(await select(eq("rate", { kind: "decimal", value: "1.5" }))).toEqual(["d1"]);
		expect(await select(eq("rate", { kind: "decimal", value: "1.5000" }))).toEqual(["d1"]);
		expect(await select(eq("rate", { kind: "decimal", value: "-3.125" }))).toEqual(["d2"]);
		expect(await select(eq("rate", { kind: "decimal", value: "1.51" }))).toEqual([]);
	});

	it("compares ipaddrs by address and prefix, per errata 21", async () => {
		await seedDocs(dataSource, entities, [
			{ ...base, id: "d1", addr: "1.2.3.4" },
			{ ...base, id: "d2", addr: "1.2.3.0/24" },
			{ ...base, id: "d3", addr: "fe80::1" },
		]);

		// A bare address is a full-width prefix.
		expect(await select(eq("addr", { kind: "ipaddr", value: "1.2.3.4" }))).toEqual(["d1"]);
		expect(await select(eq("addr", { kind: "ipaddr", value: "1.2.3.4/32" }))).toEqual(["d1"]);

		// Same network, different address ⇒ NOT equal. Network containment would say
		// yes here, which is the wrong answer.
		expect(await select(eq("addr", { kind: "ipaddr", value: "1.2.3.1/24" }))).toEqual([]);
		// Same address, different prefix ⇒ NOT equal.
		expect(await select(eq("addr", { kind: "ipaddr", value: "1.2.3.0/25" }))).toEqual([]);
		expect(await select(eq("addr", { kind: "ipaddr", value: "1.2.3.0/24" }))).toEqual(["d2"]);

		// Zero-compression and hex case are not significant; text equality would get
		// both of these wrong.
		expect(await select(eq("addr", { kind: "ipaddr", value: "0:0:0:0:0:0:0:1" }))).toEqual([]);
		expect(await select(eq("addr", { kind: "ipaddr", value: "FE80::1" }))).toEqual(["d3"]);
		expect(await select(eq("addr", { kind: "ipaddr", value: "fe80:0:0:0:0:0:0:1" }))).toEqual([
			"d3",
		]);
	});

	it("compares datetimes without a timezone guess", async () => {
		const at = new Date("2026-01-01T00:00:00.000Z");
		await seedDocs(dataSource, entities, [
			{ ...base, id: "d1", publishedAt: at },
			{ ...base, id: "d2", publishedAt: new Date("2026-01-01T12:00:00.000Z") },
		]);

		expect(await select(eq("publishedAt", { kind: "datetime", value: at }))).toEqual(["d1"]);
		expect(
			await select({
				op: "cmp",
				cmp: "lt",
				attr: { root: "resource", path: ["publishedAt"] },
				value: { kind: "datetime", value: new Date("2026-01-01T06:00:00.000Z") },
			}),
		).toEqual(["d1"]);
	});

	it("compares durations as signed millisecond integers", async () => {
		await seedDocs(dataSource, entities, [
			{ ...base, id: "d1", ttl: 1000 },
			{ ...base, id: "d2", ttl: 3_600_000 },
		]);

		expect(await select(eq("ttl", { kind: "duration", value: 1000 }))).toEqual(["d1"]);
		expect(
			await select({
				op: "cmp",
				cmp: "gt",
				attr: { root: "resource", path: ["ttl"] },
				value: { kind: "duration", value: 60_000 },
			}),
		).toEqual(["d2"]);
	});

	it("treats a NULL column as absent, in both directions", async () => {
		await seedDocs(dataSource, entities, [
			{ ...base, id: "d1", score: 5 },
			{ ...base, id: "d2" },
		]);

		expect(await select(eq("score", { kind: "long", value: 5n }))).toEqual(["d1"]);
		// `NOT (NULL = 5)` is NULL, which drops the row — matching Cedar, where
		// reading an absent attribute errors the policy into `false`, and matching
		// core's three-valued interpreter. No `COALESCE`, ever.
		expect(await select({ op: "not", node: eq("score", { kind: "long", value: 5n }) })).toEqual([]);
		expect(await select({ op: "exists", attr: { root: "resource", path: ["score"] } })).toEqual([
			"d1",
		]);
	});

	it("compares sets by mutual containment, not element-wise", async () => {
		await seedDocs(dataSource, entities, [
			{ ...base, id: "d1", labels: ["a", "b"] },
			{ ...base, id: "d2", labels: ["b", "a"] },
			{ ...base, id: "d3", labels: ["a"] },
		]);

		// Cedar sets are unordered and duplicate-insensitive (errata 23): `[1,2,2] ==
		// [2,1]`. Plain `=` on Postgres arrays is ordered and element-wise, so it is
		// the one spelling that must not appear.
		const node = eq("labels", {
			kind: "set",
			value: [
				{ kind: "string", value: "b" },
				{ kind: "string", value: "a" },
				{ kind: "string", value: "a" },
			],
		});
		expect(await select(node)).toEqual(["d1", "d2"]);
	});
});
