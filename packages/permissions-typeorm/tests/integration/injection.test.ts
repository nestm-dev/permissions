// The injection corpus.
//
// This suite is deliberately a **round-trip** test rather than an escaping test,
// because that is what the design is: no value in a compiled filter, and no value
// in a stored policy, is ever concatenated into SQL text. A `'` in a policy is a
// `'` in the database because it never touches the statement. Asserting that a
// value survives unchanged proves the property that matters; asserting that some
// escaping function produced the right backslashes would only prove that a
// function nobody should need exists.
//
// The other half is the DDL surface, where there *is* no bind parameter: table
// prefixes, scope-column names, roles, schema names and `LISTEN` channels are
// concatenated, so they are **validated** instead — a `TypeError` at call time,
// not a quoting puzzle at run time.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DataSource } from "typeorm";

import { planNodeToBrackets } from "../../src/compile/plan-to-brackets.ts";
import type { TypeOrmResourceMapping } from "../../src/compile/mapping.ts";
import { createPermissionsEntities } from "../../src/entities/create-entities.ts";
import {
	buildPermissionsMigration,
	permissionsPostgresIndexStatements,
	permissionsPostgresPolicyStatements,
} from "../../src/entities/migration.ts";
import { PolicyNotifyListener } from "../../src/store/watcher.ts";
import { TypeOrmPolicyStore } from "../../src/store/typeorm-policy-store.ts";
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
import { provisionPermissionsSchema, type ProvisionedSchema } from "../../src/testing.ts";

const SCHEMA = uniqueSuffix("nestm_inject");
const PREFIX = "i_";

/**
 * Strings chosen to break a driver that builds SQL by concatenation: statement
 * terminators, comment introducers, quote characters of both kinds, SQL wildcards,
 * a backslash, a null-ish sequence, and a fake bind placeholder (TypeORM
 * substitutes `:name` patterns over the *whole* query text, so a value that looks
 * like one is a real hazard for a driver that inlines values).
 */
const CORPUS: readonly string[] = [
	"'; drop table docs; --",
	'"; drop table docs; --',
	"' or 1=1 --",
	"100%",
	"a_b",
	"back\\slash",
	"$1",
	":nestmp_0",
	":...ids",
	"--",
	"/* comment */",
	"line1\nline2",
	"emoji 🙈 and ünïcödé",
	"'".repeat(16),
];

/**
 * The subset that is not *also* a legal SQL identifier.
 *
 * `a_b` belongs in the value corpus (its `_` is a SQL `LIKE` wildcard) and not in
 * the identifier corpus: it is a perfectly ordinary column name, and asserting
 * that the factory rejects it would be asserting the wrong thing.
 */
const IDENTIFIER_CORPUS: readonly string[] = CORPUS.filter(
	(value) => !/^[A-Za-z_][A-Za-z0-9_$]*$/.test(value),
);

let dataSource: DataSource;
let entities: DocEntities;
let mapping: TypeOrmResourceMapping<"Doc">;

function rowFor(index: number, title: string): DocRow {
	return {
		id: `d${String(index)}`,
		folder: "f1",
		owner: "u1",
		status: title,
		title,
		size: index,
		archived: false,
		labels: [title],
	};
}

describe.skipIf(PG_SKIPPED)("injection corpus", () => {
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

		await dataSource.query(docTableDropDdl(SCHEMA, PREFIX));
		for (const statement of docTableDdl(SCHEMA, PREFIX)) {
			await dataSource.query(statement);
		}

		mapping = docMappingColumnAndRecursive(dataSource, entities);

		const rows = CORPUS.map((title, index) => rowFor(index, title));
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

	// -----------------------------------------------------------------------
	// Compiled filters
	// -----------------------------------------------------------------------

	it.each(CORPUS)("round-trips %j through an equality filter", async (value) => {
		const rows = await dataSource
			.createQueryBuilder(entities.docs, "doc")
			.select("doc.id", "id")
			.andWhere(
				planNodeToBrackets(
					{
						op: "cmp",
						cmp: "eq",
						attr: { root: "resource", path: ["title"] },
						value: { kind: "string", value },
					},
					mapping,
				),
			)
			.getRawMany<{ id: string }>();

		// Exactly the one row whose title *is* that string — not zero (escaped into
		// something else) and not several (a wildcard or an injected `or 1=1`).
		expect(rows.map((row) => row.id)).toEqual([`d${String(CORPUS.indexOf(value))}`]);
	});

	it.each(CORPUS)("treats %j as a literal in a like pattern", async (value) => {
		const rows = await dataSource
			.createQueryBuilder(entities.docs, "doc")
			.select("doc.id", "id")
			.andWhere(
				planNodeToBrackets(
					{
						op: "like",
						attr: { root: "resource", path: ["title"] },
						pattern: [{ literal: value }],
					},
					mapping,
				),
			)
			.getRawMany<{ id: string }>();

		expect(rows.map((row) => row.id)).toEqual([`d${String(CORPUS.indexOf(value))}`]);
	});

	it("round-trips the corpus through an IN list and an array containment", async () => {
		const inRows = await dataSource
			.createQueryBuilder(entities.docs, "doc")
			.select("doc.id", "id")
			.andWhere(
				planNodeToBrackets(
					{
						op: "in",
						attr: { root: "resource", path: ["title"] },
						values: CORPUS.map((value) => ({ kind: "string" as const, value })),
					},
					mapping,
				),
			)
			.getRawMany<{ id: string }>();
		expect(inRows).toHaveLength(CORPUS.length);

		for (const [index, value] of CORPUS.entries()) {
			const rows = await dataSource
				.createQueryBuilder(entities.docs, "doc")
				.select("doc.id", "id")
				.andWhere(
					planNodeToBrackets(
						{
							op: "contains",
							attr: { root: "resource", path: ["labels"] },
							value: { kind: "string", value },
						},
						mapping,
					),
				)
				.getRawMany<{ id: string }>();
			expect(rows.map((row) => row.id)).toEqual([`d${String(index)}`]);
		}
	});

	it("keeps a value that looks like a bind placeholder as data", async () => {
		// TypeORM rewrites `:name` over the whole query string. A driver that inlined
		// values would hand it a value containing `:nestmp_0` and watch it become the
		// *other* parameter's value.
		const [sql, parameters] = dataSource
			.createQueryBuilder(entities.docs, "doc")
			.select("doc.id")
			.andWhere(
				planNodeToBrackets(
					{
						op: "and",
						nodes: [
							{
								op: "cmp",
								cmp: "eq",
								attr: { root: "resource", path: ["title"] },
								value: { kind: "string", value: ":nestmp_1" },
							},
							{
								op: "cmp",
								cmp: "eq",
								attr: { root: "resource", path: ["status"] },
								value: { kind: "string", value: ":nestmp_1" },
							},
						],
					},
					mapping,
				),
			)
			.getQueryAndParameters();

		expect(parameters).toEqual([":nestmp_1", ":nestmp_1"]);
		// The placeholder text appears only as `$1`/`$2`, never as the literal value.
		expect(sql).not.toContain("nestmp");
	});

	// -----------------------------------------------------------------------
	// Stored policies
	// -----------------------------------------------------------------------

	it("round-trips hostile strings through the policy store", async () => {
		const provisioned: ProvisionedSchema = await provisionPermissionsSchema(PG_URL);
		try {
			const store = new TypeOrmPolicyStore(provisioned.dataSource, {
				entities: provisioned.entities,
				poll: false,
			});

			const updatedAt = new Date("2026-07-30T00:00:00.000Z");
			await store.save(
				CORPUS.map((value, index) => ({
					id: `policy-${String(index)}`,
					scope: "tenant",
					kind: "static" as const,
					cedarJson: { effect: "permit", note: value } as never,
					description: value,
					annotations: { [`ann${String(index)}`]: value },
					enabled: true,
					updatedAt,
				})),
			);
			await store.linkTemplate({
				id: CORPUS[0] as string,
				scope: "tenant",
				templateId: CORPUS[1] as string,
				values: { "?principal": { type: "User", id: CORPUS[2] as string } },
				updatedAt,
			});

			const bundle = await store.load("tenant");

			expect(bundle.policies).toHaveLength(CORPUS.length);
			for (const [index, value] of CORPUS.entries()) {
				const record = bundle.policies.find((entry) => entry.id === `policy-${String(index)}`);
				expect(record?.description).toBe(value);
				expect(record?.annotations).toEqual({ [`ann${String(index)}`]: value });
				expect((record?.cedarJson as { note?: string } | undefined)?.note).toBe(value);
			}

			const link = bundle.links[0];
			expect(link?.id).toBe(CORPUS[0]);
			expect(link?.templateId).toBe(CORPUS[1]);
			expect(link?.values["?principal"]?.id).toBe(CORPUS[2]);

			// A scope id is a value too, and it reaches `WHERE scope IN (...)`.
			await store.save([
				{
					id: "p",
					scope: "'; drop table x; --",
					kind: "static",
					cedarJson: {} as never,
					enabled: true,
					updatedAt,
				},
			]);
			const hostileScope = await store.load("'; drop table x; --");
			expect(hostileScope.policies.map((entry) => entry.id)).toEqual(["p"]);

			await store.dispose();
		} finally {
			await provisioned.drop();
		}
	});

	// -----------------------------------------------------------------------
	// DDL identifiers, where no bind parameter exists
	// -----------------------------------------------------------------------

	it.each(IDENTIFIER_CORPUS)("refuses %j as a table prefix", (value) => {
		expect(() => createPermissionsEntities({ tablePrefix: value })).toThrowError(TypeError);
		expect(() =>
			buildPermissionsMigration({ dialect: "postgres", tablePrefix: value }),
		).toThrowError(TypeError);
		expect(() => permissionsPostgresIndexStatements({ tablePrefix: value })).toThrowError(
			TypeError,
		);
	});

	it.each(IDENTIFIER_CORPUS)("refuses %j as a scope column name, schema, or role", (value) => {
		expect(() =>
			createPermissionsEntities({
				scopeColumn: {
					name: value,
					toScope: (scope) => scope,
					fromScope: (scope) => scope,
				},
			}),
		).toThrowError(TypeError);
		expect(() => createPermissionsEntities({ schemaName: value })).toThrowError(TypeError);
		expect(() => permissionsPostgresPolicyStatements({ role: value })).toThrowError(TypeError);
		expect(() =>
			permissionsPostgresPolicyStatements({ role: "app", schemaName: value }),
		).toThrowError(TypeError);
	});

	it.each(IDENTIFIER_CORPUS)("refuses %j as a scope column SQL type", (value) => {
		expect(() =>
			buildPermissionsMigration({
				dialect: "postgres",
				scopeColumn: {
					name: "scope",
					type: value as never,
					toScope: (scope) => scope,
					fromScope: (scope) => scope,
				},
			}),
		).toThrowError(TypeError);
	});

	it.each(IDENTIFIER_CORPUS)("refuses %j as a LISTEN channel", (value) => {
		expect(
			() =>
				new PolicyNotifyListener({
					notify: { channel: value, client: () => ({}) as never },
					onPayload: () => undefined,
				}),
		).toThrowError(TypeError);
	});

	it("still accepts the identifiers a real deployment uses", () => {
		expect(() => createPermissionsEntities({ tablePrefix: "permission_" })).not.toThrow();
		expect(() => createPermissionsEntities({ tablePrefix: "" })).not.toThrow();
		expect(() => permissionsPostgresPolicyStatements({ role: "station_app" })).not.toThrow();
		expect(() =>
			buildPermissionsMigration({
				dialect: "postgres",
				scopeColumn: {
					name: "organization_id",
					type: "uuid",
					toScope: (scope) => scope,
					fromScope: (scope) => scope,
				},
			}),
		).not.toThrow();
	});
});
