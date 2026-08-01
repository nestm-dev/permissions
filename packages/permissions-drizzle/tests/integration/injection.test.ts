// The injection corpus: `'`, `--`, `;`, `%`, `\`, `"` — as **data**.
//
// This is a round-trip test, not an escaping test, and the difference is the
// whole design. Nothing in this package concatenates a value into SQL; every
// value is a bind parameter and every identifier comes from a drizzle `Column`
// or from a `tablePrefix` that was validated against a plain-identifier regex at
// schema-construction time. So the assertion is not "the quote was escaped
// correctly" — it is "the quote came back".
//
// Three surfaces, because they have three different exposures:
//
//   * the **store**, where the corpus lands in scope ids, policy ids, link ids,
//     slot values, descriptions and annotation keys/values;
//   * the **compiler**, where it lands in comparison values, `IN` lists, `LIKE`
//     patterns, entity ids and hierarchy seeds;
//   * the **DDL helpers**, where there is no bind parameter available at all —
//     `tablePrefix`, `scopeColumn.name`, the `GRANT` role and the `LISTEN`
//     channel — and the corpus must therefore be *rejected*, loudly.
//
// The last one is the only place a `TypeError` is the right answer, and it is
// asserted as such rather than left to a code review.

import {
	MemoryPolicyStore,
	type PolicyRecord,
	type PolicyStore,
	type TemplateLinkRecord,
} from "@nestm/permissions-core";
import type { PlanNode } from "@nestm/permissions-core/plan";
import { sql } from "drizzle-orm";
import { pgTable, text } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { planNodeToSql } from "../../src/compile/plan-to-sql.ts";
import type { DrizzleResourceMapping } from "../../src/compile/mapping.ts";
import { createPermissionsSchema, permissionsPostgresPolicyStatements } from "../../src/schema.ts";
import { PolicyNotifyListener } from "../../src/store/watcher.ts";
import { DrizzlePolicyStore } from "../../src/store/drizzle-policy-store.ts";
import { provisionPermissionsSchema, type ProvisionedSchema } from "../../src/testing.ts";
import { attr } from "../fixtures/compile.ts";
import {
	PG_SKIPPED,
	PG_URL,
	assertPostgresReachable,
	openPg,
	uniqueSuffix,
} from "../fixtures/pg.ts";

/**
 * Every string the suite pushes through as data.
 *
 * Each entry is here for a reason a code reviewer can name: `'` closes a string
 * literal, `--` and `/* *​/` start comments, `;` ends a statement, `%` and `_`
 * are `LIKE` metacharacters, `\` is the default `ESCAPE`, `"` closes an
 * identifier, `$1` looks like a placeholder, and `\u0000` is the one byte
 * Postgres refuses inside a `text` value at all.
 */
const CORPUS: readonly string[] = [
	"'",
	"''",
	"' or '1'='1",
	"'; drop table permission_policies; --",
	"--",
	"/* comment */",
	";",
	"%",
	"_",
	"%_%",
	"\\",
	"\\%",
	'"',
	'" or 1=1 --',
	'"; drop table "x',
	"$1",
	"${sql}",
	"scope' union select * from pg_user --",
	"back\\slash'and\"quote",
	"日本語 🙂",
];

/** Postgres rejects U+0000 in a `text` value outright — that is the database's job, not ours. */
const NUL = "\u0000";

/**
 * The corpus minus `_`.
 *
 * `_` is a `LIKE` metacharacter and belongs in the *data* corpus, but it is also
 * a perfectly ordinary SQL identifier — `create table _ (…)` is valid — so the
 * identifier guard is right to accept it. Asserting otherwise would pin the
 * guard as stricter than it is, and the next person to adjust it would not know
 * which of the two rules they had broken.
 */
const DDL_HOSTILE: readonly string[] = CORPUS.filter((value) => value !== "_");

const FIXTURE_TIME = new Date("2026-07-30T00:00:00.000Z");

function policy(id: string, scope: string, overrides: Partial<PolicyRecord> = {}): PolicyRecord {
	return {
		id,
		scope,
		kind: "static",
		cedarJson: {
			effect: "permit",
			principal: { op: "All" },
			action: { op: "All" },
			resource: { op: "All" },
			conditions: [],
		} as PolicyRecord["cedarJson"],
		enabled: true,
		updatedAt: FIXTURE_TIME,
		...overrides,
	};
}

function link(
	id: string,
	scope: string,
	overrides: Partial<TemplateLinkRecord> = {},
): TemplateLinkRecord {
	return {
		id,
		scope,
		templateId: "t1",
		values: {},
		updatedAt: FIXTURE_TIME,
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

describe.skipIf(PG_SKIPPED)("injection corpus — store", () => {
	let provisioned: ProvisionedSchema;
	let store: DrizzlePolicyStore;

	beforeAll(async () => {
		await assertPostgresReachable();
		provisioned = await provisionPermissionsSchema(PG_URL);
		store = new DrizzlePolicyStore(provisioned.db, provisioned.schema, { poll: false });
	});

	afterAll(async () => {
		await store?.dispose();
		await provisioned?.drop();
	});

	it("round-trips the corpus through policy ids and scope ids", async () => {
		// Both halves of the primary key at once: a scope id and a policy id from the
		// corpus, written and read back by the same composite key.
		const records = CORPUS.map((value, index) =>
			policy(`policy${value}`, `scope${value}${String(index)}`),
		);
		await store.save(records);

		for (const record of records) {
			const bundle = await store.load(record.scope);
			const found = bundle.policies.find((candidate) => candidate.id === record.id);
			expect(found, `scope ${JSON.stringify(record.scope)}`).toBeDefined();
			expect(found?.id).toBe(record.id);
			expect(found?.scope).toBe(record.scope);
		}
	});

	it("round-trips the corpus through descriptions and annotations", async () => {
		const scope = "annotations";
		const records = CORPUS.map((value, index) =>
			policy(`p${String(index)}`, scope, {
				description: value,
				// The corpus in a jsonb **key** as well as a value: keys travel through a
				// different serialiser than columns do.
				annotations: { [`key${value}`]: value, plain: value },
			}),
		);
		await store.save(records);

		const bundle = await store.load(scope);
		for (const [index, value] of CORPUS.entries()) {
			const found = bundle.policies.find((candidate) => candidate.id === `p${String(index)}`);
			expect(found?.description, JSON.stringify(value)).toBe(value);
			expect(found?.annotations?.[`key${value}`]).toBe(value);
			expect(found?.annotations?.["plain"]).toBe(value);
		}
	});

	it("round-trips the corpus through link ids and slot values", async () => {
		const scope = "links";
		await store.save([policy("t1", scope, { kind: "template" })]);

		for (const [index, value] of CORPUS.entries()) {
			await store.linkTemplate(
				link(`link${value}${String(index)}`, scope, {
					values: {
						"?principal": { type: `Type${value}`, id: `id${value}` },
						"?resource": { type: "Org", id: value },
					},
				}),
			);
		}

		const bundle = await store.load(scope);
		for (const [index, value] of CORPUS.entries()) {
			const found = bundle.links.find(
				(candidate) => candidate.id === `link${value}${String(index)}`,
			);
			expect(found, JSON.stringify(value)).toBeDefined();
			expect(found?.values["?principal"]).toEqual({ type: `Type${value}`, id: `id${value}` });
			expect(found?.values["?resource"]).toEqual({ type: "Org", id: value });
		}
	});

	it("deletes by a corpus id without reaching any other row", async () => {
		const scope = "deletes";
		const hostile = "'; delete from permission_policies; --";
		await store.save([policy(hostile, scope), policy("survivor", scope)]);

		await store.delete(scope, [hostile]);

		const bundle = await store.load(scope);
		expect(bundle.policies.map((record) => record.id)).toEqual(["survivor"]);
	});

	it("unlinks by a corpus id without reaching any other row", async () => {
		const scope = "unlinks";
		const hostile = "' or 1=1 --";
		await store.save([policy("t1", scope, { kind: "template" })]);
		await store.linkTemplate(link(hostile, scope));
		await store.linkTemplate(link("survivor", scope));

		await store.unlinkTemplate(scope, hostile);

		const bundle = await store.load(scope);
		expect(bundle.links.map((record) => record.id)).toEqual(["survivor"]);
	});

	it("keeps a corpus scope isolated from every other scope", async () => {
		// The sharpest store-side question: does a quote in a scope id let one
		// tenant's bundle reach another's?
		const hostile = "tenant' or '1'='1";
		await store.save([policy("secret", hostile)]);
		await store.save([policy("public", "tenant")]);

		const bundle = await store.load("tenant");
		expect(bundle.policies.map((record) => record.id)).toEqual(["public"]);
	});

	it("agrees with MemoryPolicyStore on every corpus record", async () => {
		// The strongest available oracle: the same corpus through the in-memory
		// store, which has no SQL at all, must produce identical records.
		const scope = "oracle";
		const records = CORPUS.map((value, index) =>
			policy(`p${String(index)}${value}`, scope, {
				description: value,
				annotations: { [value]: value },
			}),
		);

		const memory: PolicyStore = new MemoryPolicyStore();
		await memory.save(records);
		await store.save(records);

		const fromMemory = await memory.load(scope);
		const fromDatabase = await store.load(scope);

		expect(fromDatabase.policies).toEqual(fromMemory.policies);
	});

	it("surfaces a NUL byte as a database error rather than truncating the value", async () => {
		// Postgres cannot store U+0000 in `text`. The important half is that the write
		// *fails* — a store that silently truncated would give the policy a different
		// id from the one the caller believes it wrote.
		await expect(store.save([policy(`nul${NUL}id`, "nul-scope")])).rejects.toThrow();
	});
});

// ---------------------------------------------------------------------------
// Compiler
// ---------------------------------------------------------------------------

const TABLE = uniqueSuffix("inject");

const rows = pgTable(TABLE, {
	id: text("id").primaryKey(),
	title: text("title").notNull(),
	ownerId: text("owner_id"),
	folderId: text("folder_id"),
	labels: text("labels").array(),
});

const mapping: DrizzleResourceMapping<"Row"> = {
	resourceType: "Row",
	table: rows,
	id: rows.id,
	attributes: {
		title: { kind: "scalar", column: rows.title, valueKind: "string" },
		owner: { kind: "entity", column: rows.ownerId, entityType: "User" },
		folder: { kind: "entity", column: rows.folderId, entityType: "Folder" },
		labels: { kind: "array", column: rows.labels, elementKind: "string" },
	},
	hierarchy: { Row: { kind: "self" }, Folder: { kind: "column", column: rows.folderId } },
};

describe.skipIf(PG_SKIPPED)("injection corpus — compiler", () => {
	let pg: ReturnType<typeof openPg>;

	beforeAll(async () => {
		await assertPostgresReachable();
		pg = openPg();
		await pg.db.execute(sql.raw(`drop table if exists "${TABLE}" cascade`));
		await pg.db.execute(
			sql.raw(`create table "${TABLE}" (
				"id" text primary key, "title" text not null,
				"owner_id" text, "folder_id" text, "labels" text[]
			)`),
		);

		await pg.db.insert(rows).values(
			CORPUS.map((value, index) => ({
				id: `r${String(index)}`,
				title: value,
				ownerId: value,
				folderId: value,
				labels: [value, "plain"],
			})),
		);
		// One row holding none of the corpus, so "selected everything" is
		// distinguishable from "selected the right thing".
		await pg.db
			.insert(rows)
			.values([
				{ id: "clean", title: "clean", ownerId: "clean", folderId: "clean", labels: ["clean"] },
			]);
	});

	afterAll(async () => {
		if (pg !== undefined) {
			await pg.db.execute(sql.raw(`drop table if exists "${TABLE}" cascade`));
			await pg.close();
		}
	});

	async function select(node: PlanNode): Promise<string[]> {
		const condition = planNodeToSql(node, mapping);
		const result = await pg.db.execute<{ id: string }>(
			sql`select "id" from ${rows} where ${condition} order by "id"`,
		);
		const list = Array.isArray(result)
			? result
			: ((result as { rows: { id: string }[] }).rows ?? []);
		return list.map((row) => row.id);
	}

	it("matches a corpus value through cmp eq, and only that row", async () => {
		for (const [index, value] of CORPUS.entries()) {
			await expect(
				select({ op: "cmp", cmp: "eq", attr: attr("title"), value: { kind: "string", value } }),
				JSON.stringify(value),
			).resolves.toEqual([`r${String(index)}`]);
		}
	});

	it("matches a corpus value through an IN list", async () => {
		const selected = await select({
			op: "in",
			attr: attr("title"),
			values: [
				{ kind: "string", value: CORPUS[0] as string },
				{ kind: "string", value: CORPUS[3] as string },
			],
		});
		expect(selected).toEqual(["r0", "r3"]);
	});

	it("matches a corpus value through an entity id", async () => {
		for (const [index, value] of CORPUS.entries()) {
			await expect(
				select({
					op: "cmp",
					cmp: "eq",
					attr: attr("owner"),
					value: { kind: "entity", value: { type: "User", id: value } },
				}),
				JSON.stringify(value),
			).resolves.toEqual([`r${String(index)}`]);
		}
	});

	it("matches a corpus value through a hierarchy seed", async () => {
		for (const [index, value] of CORPUS.entries()) {
			await expect(
				select({ op: "inHierarchy", attr: null, parent: { type: "Folder", id: value } }),
				JSON.stringify(value),
			).resolves.toEqual([`r${String(index)}`]);
		}
	});

	it("matches a corpus value through array containment", async () => {
		for (const [index, value] of CORPUS.entries()) {
			await expect(
				select({ op: "contains", attr: attr("labels"), value: { kind: "string", value } }),
				JSON.stringify(value),
			).resolves.toEqual([`r${String(index)}`]);
		}
	});

	it("treats a corpus value in a LIKE pattern as literal text", async () => {
		for (const [index, value] of CORPUS.entries()) {
			// The whole value as one literal token: no `%` in it may become a wildcard,
			// and no `\` may escape the character after it.
			await expect(
				select({ op: "like", attr: attr("title"), pattern: [{ literal: value }] }),
				JSON.stringify(value),
			).resolves.toEqual([`r${String(index)}`]);
		}
	});

	it("never lets a corpus value select the clean row", async () => {
		// The failure this suite exists to catch, stated directly: if any corpus value
		// escaped into the statement text as `' or '1'='1`, the clean row would appear.
		for (const value of CORPUS) {
			const selected = await select({
				op: "cmp",
				cmp: "eq",
				attr: attr("title"),
				value: { kind: "string", value },
			});
			expect(selected, JSON.stringify(value)).not.toContain("clean");
		}
	});
});

// ---------------------------------------------------------------------------
// DDL surfaces, where no bind parameter exists
// ---------------------------------------------------------------------------

describe("injection corpus — DDL identifiers are rejected, not escaped", () => {
	it("refuses a hostile tablePrefix", () => {
		for (const value of DDL_HOSTILE) {
			expect(() => createPermissionsSchema({ tablePrefix: value }), JSON.stringify(value)).toThrow(
				TypeError,
			);
		}
	});

	it("refuses a hostile scope column name", () => {
		for (const value of DDL_HOSTILE) {
			expect(
				() =>
					createPermissionsSchema({
						scopeColumn: {
							name: value,
							column: () => text(value).notNull(),
							toScope: (scope: string) => scope,
							fromScope: (scope: string) => scope,
						},
					}),
				JSON.stringify(value),
			).toThrow(TypeError);
		}
	});

	it("refuses a hostile GRANT role, schema name or table prefix", () => {
		for (const value of DDL_HOSTILE) {
			expect(() => permissionsPostgresPolicyStatements({ role: value })).toThrow(TypeError);
			expect(() => permissionsPostgresPolicyStatements({ role: "app", schemaName: value })).toThrow(
				TypeError,
			);
			expect(() =>
				permissionsPostgresPolicyStatements({ role: "app", tablePrefix: value }),
			).toThrow(TypeError);
		}
	});

	it("refuses a hostile LISTEN channel", () => {
		for (const value of DDL_HOSTILE) {
			expect(
				() =>
					new PolicyNotifyListener({
						notify: { channel: value, client: () => Promise.reject(new Error("unused")) },
						onPayload: () => undefined,
					}),
				JSON.stringify(value),
			).toThrow(TypeError);
		}
	});

	it("accepts the identifiers a real deployment uses", () => {
		// The regex has to reject the corpus without rejecting station's own names,
		// or the guard is unusable and someone will remove it.
		expect(() => createPermissionsSchema({ tablePrefix: "permission_" })).not.toThrow();
		expect(() => createPermissionsSchema({ tablePrefix: "" })).not.toThrow();
		expect(() =>
			permissionsPostgresPolicyStatements({ role: "station_app", schemaName: "public" }),
		).not.toThrow();
		expect(
			() =>
				new PolicyNotifyListener({
					notify: {
						channel: "nestm_permissions",
						client: () => Promise.reject(new Error("unused")),
					},
					onPayload: () => undefined,
				}),
		).not.toThrow();
	});

	it("emits only quoted, validated identifiers in the GRANT statements", () => {
		const statements = permissionsPostgresPolicyStatements({
			role: "station_app",
			schemaName: "public",
			tablePrefix: "permission_",
		});
		for (const statement of statements) {
			expect(statement).not.toContain("'");
			expect(statement).not.toContain("--");
			expect(statement).not.toContain(";");
		}
	});
});
