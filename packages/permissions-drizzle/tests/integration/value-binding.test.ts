// Does the *binding* of each `PlanValue` kind reproduce Cedar's semantics in
// Postgres?
//
// The differential suite answers this end-to-end, but only for the values its
// generators happen to produce, and only as part of a set-equality that says
// nothing about *which* value kind was wrong when it fails. This suite asks each
// question directly, one kind at a time, against the two rows that distinguish
// the right binding from the plausible ones:
//
//   * `decimal` — `1.5` and `1.50` are the same number to Cedar and to
//     `numeric`, and different strings to `text`.
//   * `ipaddr` — Cedar compares address **and prefix**. `::text` disagrees
//     wherever the same address is spelled two ways; `<<=` (network
//     containment) disagrees wherever a host sits inside a network.
//   * `long` — exact past 2^53, which `Number()` is not.
//   * `datetime` — an explicit `Z` and an explicit cast, not whatever timezone
//     the driver felt like.
//   * `set` — unordered and duplicate-insensitive, which is mutual containment
//     and not `=`.
//
// The `ipaddr` group is the standing form of the verification recorded in
// `docs/design/errata.md`.

import type { PlanNode } from "@nestm/permissions-core/plan";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { planNodeToSql } from "../../src/compile/plan-to-sql.ts";
import type { DrizzleResourceMapping } from "../../src/compile/mapping.ts";
import { attr } from "../fixtures/compile.ts";
import { PG_SKIPPED, assertPostgresReachable, openPg, uniqueSuffix } from "../fixtures/pg.ts";
import { bigint, inet, numeric, pgTable, text, timestamp } from "drizzle-orm/pg-core";

const TABLE = uniqueSuffix("values");

const values = pgTable(TABLE, {
	id: text("id").primaryKey(),
	rate: numeric("rate"),
	addr: inet("addr"),
	size: bigint("size", { mode: "number" }),
	at: timestamp("at", { withTimezone: true, mode: "date" }),
	ttlMs: bigint("ttl_ms", { mode: "number" }),
	labels: text("labels").array(),
});

const mapping: DrizzleResourceMapping<"Value"> = {
	resourceType: "Value",
	table: values,
	id: values.id,
	attributes: {
		rate: { kind: "scalar", column: values.rate, valueKind: "decimal" },
		addr: { kind: "scalar", column: values.addr, valueKind: "ipaddr" },
		size: { kind: "scalar", column: values.size, valueKind: "long" },
		at: { kind: "scalar", column: values.at, valueKind: "datetime" },
		ttl: { kind: "scalar", column: values.ttlMs, valueKind: "duration" },
		labels: { kind: "array", column: values.labels, elementKind: "string" },
	},
};

let pg: ReturnType<typeof openPg>;

/** Ids the compiled condition selects. */
async function select(node: PlanNode): Promise<string[]> {
	const condition = planNodeToSql(node, mapping);
	const result = await pg.db.execute<{ id: string }>(
		sql`select "id" from ${values} where ${condition} order by "id"`,
	);
	const rows = Array.isArray(result) ? result : ((result as { rows: { id: string }[] }).rows ?? []);
	return rows.map((row) => row.id);
}

describe.skipIf(PG_SKIPPED)("PlanValue binding vs Postgres", () => {
	beforeAll(async () => {
		await assertPostgresReachable();
		pg = openPg();
		await pg.db.execute(sql.raw(`drop table if exists "${TABLE}" cascade`));
		await pg.db.execute(
			sql.raw(`create table "${TABLE}" (
				"id" text primary key, "rate" numeric, "addr" inet, "size" bigint,
				"at" timestamptz, "ttl_ms" bigint, "labels" text[]
			)`),
		);
	});

	afterAll(async () => {
		if (pg !== undefined) {
			await pg.db.execute(sql.raw(`drop table if exists "${TABLE}" cascade`));
			await pg.close();
		}
	});

	describe("decimal", () => {
		beforeAll(async () => {
			await pg.db.delete(values);
			await pg.db.insert(values).values([
				{ id: "a", rate: "1.5" },
				{ id: "b", rate: "1.50" },
				{ id: "c", rate: "2.25" },
				{ id: "d", rate: "-3.125" },
			]);
		});

		it("compares numerically, so 1.5 and 1.50 are the same value", () => {
			// Cedar: `decimal("1.5") == decimal("1.50")` is true. Text equality would
			// select only one of the two rows.
			return expect(
				select({
					op: "cmp",
					cmp: "eq",
					attr: attr("rate"),
					value: { kind: "decimal", value: "1.50" },
				}),
			).resolves.toEqual(["a", "b"]);
		});

		it("handles a negative decimal", async () => {
			await expect(
				select({
					op: "cmp",
					cmp: "eq",
					attr: attr("rate"),
					value: { kind: "decimal", value: "-3.125" },
				}),
			).resolves.toEqual(["d"]);
		});

		it("excludes NULL from a negated comparison, as SQL three-valued logic requires", async () => {
			await pg.db.insert(values).values([{ id: "z", rate: null }]);
			// `NOT(NULL = 1.5)` is NULL, which drops the row — matching the reference
			// interpreter, where an absent attribute is UNKNOWN and never `true`.
			const selected = await select({
				op: "not",
				node: {
					op: "cmp",
					cmp: "eq",
					attr: attr("rate"),
					value: { kind: "decimal", value: "1.5" },
				},
			});
			expect(selected).not.toContain("z");
			await pg.db.delete(values).where(sql`"id" = 'z'`);
		});
	});

	describe("ipaddr", () => {
		// The seven pairs from `docs/design/errata.md` core erratum 21, as rows.
		beforeAll(async () => {
			await pg.db.delete(values);
			await pg.db.insert(values).values([
				{ id: "host", addr: "1.2.3.4" },
				{ id: "v6short", addr: "::1" },
				{ id: "v6upper", addr: "FE80::1" },
				{ id: "net24", addr: "1.2.3.0/24" },
				{ id: "net24host", addr: "1.2.3.1/24" },
				{ id: "net25", addr: "1.2.3.0/25" },
				{ id: "other", addr: "10.0.0.2" },
			]);
		});

		const ip = (value: string): PlanNode => ({
			op: "cmp",
			cmp: "eq",
			attr: attr("addr"),
			value: { kind: "ipaddr", value },
		});

		it("treats a bare address as a full-width prefix", async () => {
			await expect(select(ip("1.2.3.4/32"))).resolves.toEqual(["host"]);
		});

		it("ignores IPv6 zero-compression and hex case", async () => {
			await expect(select(ip("0:0:0:0:0:0:0:1"))).resolves.toEqual(["v6short"]);
			await expect(select(ip("::0001"))).resolves.toEqual(["v6short"]);
			await expect(select(ip("fe80::1"))).resolves.toEqual(["v6upper"]);
		});

		it("compares the address AND the prefix, not the network", async () => {
			// The two rows that separate `inet =` from `<<=`: a host inside the network
			// is *contained* by it and is not *equal* to it. Cedar says not equal.
			await expect(select(ip("1.2.3.0/24"))).resolves.toEqual(["net24"]);
			await expect(select(ip("1.2.3.1/24"))).resolves.toEqual(["net24host"]);
			await expect(select(ip("1.2.3.0/25"))).resolves.toEqual(["net25"]);
		});

		it("would have been wrong under text equality and under network containment", async () => {
			// Stated as an executable claim rather than a comment: `::text` splits the
			// four equal-but-differently-spelled pairs, and `<<=` merges two Cedar
			// keeps apart.
			const result = await pg.db.execute<{ texteq: boolean; contained: boolean }>(
				sql`select ('1.2.3.4'::text = '1.2.3.4/32'::text) as texteq,
				           ('1.2.3.1/24'::inet <<= '1.2.3.0/24'::inet) as contained`,
			);
			const rows = Array.isArray(result)
				? result
				: (result as { rows: { texteq: boolean; contained: boolean }[] }).rows;
			expect(rows[0]).toMatchObject({ texteq: false, contained: true });
		});
	});

	describe("long and duration", () => {
		beforeAll(async () => {
			await pg.db.delete(values);
			await pg.db.execute(
				sql`insert into ${values} ("id", "size", "ttl_ms") values
					('big', 9007199254740993, 60000),
					('small', 5, 1000)`,
			);
		});

		it("is exact past 2^53, where Number() is not", async () => {
			// `Number(9007199254740993n)` is 9007199254740992. Binding the decimal text
			// with an explicit `::bigint` is what keeps the two rows distinguishable.
			await expect(
				select({
					op: "cmp",
					cmp: "eq",
					attr: attr("size"),
					value: { kind: "long", value: 9_007_199_254_740_993n },
				}),
			).resolves.toEqual(["big"]);

			await expect(
				select({
					op: "cmp",
					cmp: "eq",
					attr: attr("size"),
					value: { kind: "long", value: 9_007_199_254_740_992n },
				}),
			).resolves.toEqual([]);
		});

		it("orders durations as signed millisecond counts", async () => {
			await expect(
				select({
					op: "cmp",
					cmp: "lt",
					attr: attr("ttl"),
					value: { kind: "duration", value: 60_000 },
				}),
			).resolves.toEqual(["small"]);
		});
	});

	describe("datetime", () => {
		beforeAll(async () => {
			await pg.db.delete(values);
			await pg.db.insert(values).values([
				{ id: "before", at: new Date("2025-12-31T23:59:59.000Z") },
				{ id: "after", at: new Date("2026-01-01T00:00:01.000Z") },
			]);
		});

		it("binds an instant, not a local rendering", async () => {
			await expect(
				select({
					op: "cmp",
					cmp: "gte",
					attr: attr("at"),
					value: { kind: "datetime", value: new Date("2026-01-01T00:00:00.000Z") },
				}),
			).resolves.toEqual(["after"]);
		});

		it("agrees regardless of the session TimeZone", async () => {
			// A binding that leaned on the server's rendering would move the boundary
			// when the session timezone moved. This is the assertion that says it does
			// not.
			const condition = planNodeToSql(
				{
					op: "cmp",
					cmp: "gte",
					attr: attr("at"),
					value: { kind: "datetime", value: new Date("2026-01-01T00:00:00.000Z") },
				},
				mapping,
			);

			for (const zone of ["UTC", "Pacific/Kiritimati", "Pacific/Niue"]) {
				const rows = await pg.db.transaction(async (tx) => {
					await tx.execute(sql.raw(`set local timezone to '${zone}'`));
					const result = await tx.execute<{ id: string }>(
						sql`select "id" from ${values} where ${condition} order by "id"`,
					);
					return Array.isArray(result) ? result : (result as { rows: { id: string }[] }).rows;
				});
				expect(
					rows.map((row) => row.id),
					zone,
				).toEqual(["after"]);
			}
		});
	});

	describe("set", () => {
		beforeAll(async () => {
			await pg.db.delete(values);
			await pg.db.insert(values).values([
				{ id: "ab", labels: ["a", "b"] },
				{ id: "ba", labels: ["b", "a"] },
				{ id: "abb", labels: ["a", "b", "b"] },
				{ id: "a", labels: ["a"] },
				{ id: "none", labels: [] },
			]);
		});

		it("is unordered and duplicate-insensitive, so [1,2,2] == [2,1]", async () => {
			// Cedar: verified `[1,2,2] == [2,1]` is allow. Plain array `=` is ordered
			// and element-wise, and would select only `ab`.
			await expect(
				select({
					op: "cmp",
					cmp: "eq",
					attr: attr("labels"),
					value: {
						kind: "set",
						value: [
							{ kind: "string", value: "b" },
							{ kind: "string", value: "a" },
						],
					},
				}),
			).resolves.toEqual(["ab", "abb", "ba"]);
		});

		it("finds the empty set by cardinality, so a NULL column stays NULL", async () => {
			await expect(select({ op: "isEmpty", attr: attr("labels") })).resolves.toEqual(["none"]);
		});

		it("answers contains() by containment", async () => {
			await expect(
				select({ op: "contains", attr: attr("labels"), value: { kind: "string", value: "b" } }),
			).resolves.toEqual(["ab", "abb", "ba"]);
		});
	});
});
