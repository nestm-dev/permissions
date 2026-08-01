// The three migration tiers, each against real Postgres.
//
//   1. `typeorm migration:generate` — the recommended path. There is no way to
//      test "the CLI produced a file" without a CLI, but the CLI is a thin shell
//      over `dataSource.driver.createSchemaBuilder().log()`, which is what this
//      suite drives. It answers the two questions a consumer actually has: does
//      registering `createPermissionsEntities()` produce the tables, and does a
//      second run produce an *empty* diff (the round-trip).
//   2. `buildPermissionsMigration()` — the raw statements, executed.
//   3. `PermissionsInitialMigration()` — the same statements through TypeORM's own
//      migration runner, up and down.
//
// The round-trip in tier 1 is the load-bearing assertion. A schema that TypeORM
// re-generates a diff for on every run is a schema whose consumers get a spurious
// migration in every pull request, and the usual cause is a factory that declares
// something the schema builder renders differently — which is exactly the class of
// mistake a hand-written `CREATE TABLE` hides.

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { DataSource } from "typeorm";

import {
	createPermissionsEntities,
	type PermissionsEntities,
} from "../../src/entities/create-entities.ts";
import {
	DEFAULT_MIGRATION_NAME,
	PermissionsInitialMigration,
	buildPermissionsMigration,
	permissionsPostgresIndexStatements,
	permissionsPostgresPolicyStatements,
} from "../../src/entities/migration.ts";
import { TypeOrmPolicyStore } from "../../src/store/typeorm-policy-store.ts";
import { PG_SKIPPED, PG_URL, assertPostgresReachable, uniqueSuffix } from "../fixtures/pg.ts";
import { stationScopeColumn } from "../fixtures/station-scope.ts";

const SCHEMA = uniqueSuffix("nestm_mig");

const created: DataSource[] = [];

async function openWith(
	entities: PermissionsEntities,
	migrations: unknown[] = [],
): Promise<DataSource> {
	const dataSource = new DataSource({
		type: "postgres",
		url: PG_URL,
		entities: [entities.policy, entities.link, entities.scopeVersion],
		migrations: migrations as never,
		extra: { max: 2 },
	});
	await dataSource.initialize();
	created.push(dataSource);
	return dataSource;
}

/** What `typeorm migration:generate` would write, as statements. */
async function generate(dataSource: DataSource): Promise<string[]> {
	const log = await dataSource.driver.createSchemaBuilder().log();
	return log.upQueries.map((query) => query.query);
}

describe.skipIf(PG_SKIPPED)("migrations", () => {
	beforeAll(async () => {
		await assertPostgresReachable();
		const bootstrap = await openWith(
			createPermissionsEntities({ tablePrefix: "boot_", schemaName: SCHEMA }),
		);
		await bootstrap.query(`create schema if not exists "${SCHEMA}"`);
	});

	afterEach(async () => {
		while (created.length > 1) {
			const dataSource = created.pop();
			if (dataSource?.isInitialized === true) {
				await dataSource.destroy();
			}
		}
	});

	// -----------------------------------------------------------------------
	// Tier 1 — migration:generate
	// -----------------------------------------------------------------------

	it("generates the three tables from the registered entities", async () => {
		const prefix = "gen1_";
		const entities = createPermissionsEntities({ tablePrefix: prefix, schemaName: SCHEMA });
		const dataSource = await openWith(entities);

		const statements = await generate(dataSource);
		const sql = statements.join("\n");

		for (const table of ["policies", "policy_links", "scope_versions"]) {
			expect(sql).toContain(`"${SCHEMA}"."${prefix}${table}"`);
		}
		// Columns, primary keys, checks and the partial index all have to be in there.
		expect(sql).toContain(`"cedar_json" jsonb NOT NULL`);
		expect(sql).toContain(`CONSTRAINT "${prefix}policies_pk" PRIMARY KEY ("scope", "policy_id")`);
		expect(sql).toContain(`"${prefix}policies_kind_check"`);
		expect(sql).toContain(
			`"${prefix}link"`.slice(0, 0) + `"${prefix}policy_links_principal_slot_check"`,
		);
		expect(sql).toContain(`"${prefix}policies_scope_enabled_index"`);
		expect(sql).toContain(`WHERE "enabled"`);
		expect(sql).toContain(`"${prefix}scope_versions_updated_at_index"`);
	});

	it("re-generates an EMPTY diff once the tables exist — the round-trip", async () => {
		const prefix = "gen2_";
		const entities = createPermissionsEntities({ tablePrefix: prefix, schemaName: SCHEMA });
		const dataSource = await openWith(entities);

		// Apply what it would generate, then ask again.
		for (const statement of await generate(dataSource)) {
			await dataSource.query(statement);
		}

		const second = await generate(dataSource);
		expect(second, `migration:generate is not idempotent:\n${second.join("\n")}`).toEqual([]);

		await dataSource.query(`drop table "${SCHEMA}"."${prefix}policy_links" cascade`);
		await dataSource.query(`drop table "${SCHEMA}"."${prefix}policies" cascade`);
		await dataSource.query(`drop table "${SCHEMA}"."${prefix}scope_versions" cascade`);
	});

	it("round-trips a station-shaped uuid scope column too", async () => {
		const prefix = "gen3_";
		const entities = createPermissionsEntities({
			tablePrefix: prefix,
			schemaName: SCHEMA,
			scopeColumn: stationScopeColumn(),
		});
		const dataSource = await openWith(entities);

		const first = await generate(dataSource);
		expect(first.join("\n")).toContain(`"organization_id" uuid NOT NULL`);
		for (const statement of first) {
			await dataSource.query(statement);
		}

		expect(await generate(dataSource)).toEqual([]);

		await dataSource.query(`drop table "${SCHEMA}"."${prefix}policy_links" cascade`);
		await dataSource.query(`drop table "${SCHEMA}"."${prefix}policies" cascade`);
		await dataSource.query(`drop table "${SCHEMA}"."${prefix}scope_versions" cascade`);
	});

	it("emits a uuid link id and round-trips it through the store — linkIdColumn", async () => {
		// A link id is core's `TemplateLinkRecord['id']`, a `string` on the JavaScript
		// side whatever the SQL type is. The reason the *column* type is an option is
		// the foreign key: a deployment reusing its grant table's `uuid` primary key as
		// the link id needs a composite FK to `(tenant, id)`, and Postgres refuses one
		// between `text` and `uuid`. Mirrors `linkIdColumn` in the drizzle driver, so
		// the two drivers still read each other's tables.
		const prefix = "gen5_";
		const entities = createPermissionsEntities({
			tablePrefix: prefix,
			schemaName: SCHEMA,
			scopeColumn: stationScopeColumn(),
			linkIdColumn: { type: "uuid" },
		});
		const dataSource = await openWith(entities);

		const statements = await generate(dataSource);
		expect(statements.join("\n")).toContain(`"link_id" uuid NOT NULL`);
		expect(statements.join("\n")).toContain(
			`CONSTRAINT "${prefix}policy_links_pk" PRIMARY KEY ("organization_id", "link_id")`,
		);
		for (const statement of statements) {
			await dataSource.query(statement);
		}
		// The factory's output is still a fixed point.
		expect(await generate(dataSource)).toEqual([]);

		// And the composite foreign key the whole option exists for is now
		// expressible: `text` here would fail with "foreign key constraint cannot be
		// implemented … incompatible types".
		await dataSource.query(
			`create table "${SCHEMA}"."${prefix}role_grants" (` +
				`"organization_id" uuid not null, "id" uuid not null, ` +
				`constraint "${prefix}role_grants_pk" primary key ("organization_id", "id"))`,
		);
		await dataSource.query(
			`alter table "${SCHEMA}"."${prefix}policy_links" add constraint "${prefix}links_grant_fk" ` +
				`foreign key ("organization_id", "link_id") ` +
				`references "${SCHEMA}"."${prefix}role_grants" ("organization_id", "id") on delete cascade`,
		);

		const scope = "tenant-a";
		const linkId = "3f1d2c4e-5a6b-4c8d-9e0f-1a2b3c4d5e6f";
		await dataSource.query(
			`insert into "${SCHEMA}"."${prefix}role_grants" ("organization_id", "id") values ($1, $2)`,
			[stationScopeColumn().fromScope(scope), linkId],
		);

		const store = new TypeOrmPolicyStore(dataSource, { entities, poll: false });
		await store.save([
			{
				id: "tpl",
				scope,
				kind: "template",
				cedarJson: {
					effect: "permit",
					principal: { op: "==", slot: "?principal" },
					action: { op: "All" },
					resource: { op: "All" },
					conditions: [],
				} as never,
				enabled: true,
				updatedAt: new Date("2026-07-31T00:00:00.000Z"),
			},
		]);
		await store.linkTemplate({
			id: linkId,
			scope,
			templateId: "tpl",
			values: { "?principal": { type: "Member", id: "m1" } },
			updatedAt: new Date("2026-07-31T00:00:00.000Z"),
		});

		const bundle = await store.load(scope);
		// A uuid column reads back as a string, which is exactly what the SPI says a
		// link id is — no codec, no branding, no loss.
		expect(bundle.links.map((link) => link.id)).toEqual([linkId]);
		expect(bundle.links[0]?.values).toEqual({ "?principal": { type: "Member", id: "m1" } });

		await store.unlinkTemplate(scope, linkId);
		expect((await store.load(scope)).links).toEqual([]);

		await dataSource.query(`drop table "${SCHEMA}"."${prefix}policy_links" cascade`);
		await dataSource.query(`drop table "${SCHEMA}"."${prefix}role_grants" cascade`);
		await dataSource.query(`drop table "${SCHEMA}"."${prefix}policies" cascade`);
		await dataSource.query(`drop table "${SCHEMA}"."${prefix}scope_versions" cascade`);
	});

	it("carries linkIdColumn into the tier-2 statement builder as well", () => {
		// Tiers 1 and 2 have to agree, or a project that generates with one and
		// applies with the other gets two different tables under one name.
		const { up } = buildPermissionsMigration({
			dialect: "postgres",
			tablePrefix: "gen6_",
			scopeColumn: stationScopeColumn(),
			linkIdColumn: { type: "uuid" },
		});
		const sql = up.join("\n");

		expect(sql).toContain(`"link_id" uuid not null`);
		expect(sql).toContain(`primary key ("organization_id", "link_id")`);

		// The default is unchanged.
		expect(
			buildPermissionsMigration({ dialect: "postgres", tablePrefix: "gen6b_" }).up.join("\n"),
		).toContain(`"link_id" text not null`);
	});

	it("rejects a link id type or name that is not plain SQL", () => {
		// Same defence as the scope column: this lands in DDL, where no bind parameter
		// exists.
		expect(() =>
			buildPermissionsMigration({
				dialect: "postgres",
				linkIdColumn: { type: "uuid); drop table users; --" as never },
			}),
		).toThrow(/linkIdColumn\.type must be a plain SQL type name/);

		expect(() => createPermissionsEntities({ linkIdColumn: { name: `link_id" , "x` } })).toThrow(
			/linkIdColumn\.name must be a plain SQL identifier/,
		);
	});

	it("cannot generate the GIN index, and will propose dropping a hand-added one", async () => {
		const prefix = "gen4_";
		const entities = createPermissionsEntities({ tablePrefix: prefix, schemaName: SCHEMA });
		const dataSource = await openWith(entities);

		// `EntitySchemaIndexOptions` has no `using`, so TypeORM cannot express
		// `USING gin`. Rather than ship a btree index over a jsonb column — legal,
		// useless for `@>`, and silently so — the factory omits it and
		// `permissionsPostgresIndexStatements` hands it over.
		const statements = await generate(dataSource);
		// `/using\s+gin/`, not `"gin"`: `bigint` contains the substring, and a golden
		// assertion that passes for the wrong reason is worse than none.
		expect(statements.join("\n")).not.toMatch(/using\s+gin/i);

		for (const statement of statements) {
			await dataSource.query(statement);
		}
		for (const statement of permissionsPostgresIndexStatements({
			tablePrefix: prefix,
			schemaName: SCHEMA,
		})) {
			await dataSource.query(statement);
		}

		const indexes = await dataSource.query(
			`select indexdef from pg_indexes where schemaname = $1 and tablename = $2`,
			[SCHEMA, `${prefix}policies`],
		);
		expect(indexes.map((row: { indexdef: string }) => row.indexdef).join("\n")).toContain(
			"USING gin",
		);

		// **And here is the consequence a consumer must be told about, in the README
		// and in this assertion.** TypeORM's schema builder does not merely ignore an
		// index it did not declare — it proposes *dropping* it, because "the entity is
		// the truth" is the whole premise of `migration:generate`. So on tier 1 the
		// GIN index and the generator are in a standoff: every subsequent
		// `migration:generate` will contain a `DROP INDEX` line for it.
		//
		// Pinned rather than hidden. The choices are to delete that line each time, to
		// go without the index (it serves only the admin-API "which policies mention
		// Run?" query, never the authorization path), or to use tier 2/3 — which is why
		// tier 2/3 exist and why they are what station uses.
		expect(await generate(dataSource)).toEqual([
			`DROP INDEX "${SCHEMA}"."${prefix}policies_cedar_json_index"`,
		]);

		await dataSource.query(`drop table "${SCHEMA}"."${prefix}policy_links" cascade`);
		await dataSource.query(`drop table "${SCHEMA}"."${prefix}policies" cascade`);
		await dataSource.query(`drop table "${SCHEMA}"."${prefix}scope_versions" cascade`);
	});

	// -----------------------------------------------------------------------
	// Tier 2 — buildPermissionsMigration
	// -----------------------------------------------------------------------

	it("executes the raw statements and produces a working store", async () => {
		const prefix = "raw_";
		const entities = createPermissionsEntities({ tablePrefix: prefix, schemaName: SCHEMA });
		const dataSource = await openWith(entities);

		const { up, down } = buildPermissionsMigration({
			dialect: "postgres",
			tablePrefix: prefix,
			schemaName: SCHEMA,
		});
		for (const statement of up) {
			await dataSource.query(statement);
		}

		const store = new TypeOrmPolicyStore(dataSource, { entities, poll: false });
		await store.save([
			{
				id: "p1",
				scope: "t",
				kind: "static",
				cedarJson: {} as never,
				enabled: true,
				updatedAt: new Date("2026-07-30T00:00:00.000Z"),
			},
		]);
		expect((await store.load("t")).policies.map((record) => record.id)).toEqual(["p1"]);
		await store.dispose();

		// The GIN index the schema builder cannot express *is* here.
		const indexes = await dataSource.query(
			`select indexdef from pg_indexes where schemaname = $1 and tablename = $2`,
			[SCHEMA, `${prefix}policies`],
		);
		expect(indexes.map((row: { indexdef: string }) => row.indexdef).join("\n")).toContain(
			"USING gin",
		);

		for (const statement of down) {
			await dataSource.query(statement);
		}
		const remaining = await dataSource.query(
			`select tablename from pg_tables where schemaname = $1 and tablename like $2`,
			[SCHEMA, `${prefix}%`],
		);
		expect(remaining).toEqual([]);
	});

	it("enforces the check constraints the model relies on", async () => {
		const prefix = "checks_";
		const entities = createPermissionsEntities({ tablePrefix: prefix, schemaName: SCHEMA });
		const dataSource = await openWith(entities);

		for (const statement of buildPermissionsMigration({
			dialect: "postgres",
			tablePrefix: prefix,
			schemaName: SCHEMA,
		}).up) {
			await dataSource.query(statement);
		}

		const policies = `"${SCHEMA}"."${prefix}policies"`;
		const links = `"${SCHEMA}"."${prefix}policy_links"`;

		// `kind` is checked, not trusted.
		await expect(
			dataSource.query(
				`insert into ${policies} ("scope","policy_id","kind","cedar_json") values ('t','p','nonsense','{}')`,
			),
		).rejects.toThrow();

		// A half-filled slot pair is a link Cedar would reject at build time.
		await expect(
			dataSource.query(
				`insert into ${links} ("scope","link_id","template_id","principal_type") values ('t','l','t1','User')`,
			),
		).rejects.toThrow();
		// Both halves absent is legal (D6): a template with no slots must be linkable.
		await expect(
			dataSource.query(
				`insert into ${links} ("scope","link_id","template_id") values ('t','l','t1')`,
			),
		).resolves.toBeDefined();

		await dataSource.query(`drop table ${links} cascade`);
		await dataSource.query(`drop table ${policies} cascade`);
		await dataSource.query(`drop table "${SCHEMA}"."${prefix}scope_versions" cascade`);
	});

	it("refuses a dialect it has not implemented, at call time", () => {
		expect(() => buildPermissionsMigration({ dialect: "mysql" })).toThrowError(/mysql/);
		expect(() => buildPermissionsMigration({ dialect: "sqlite" })).toThrowError(
			/only "postgres" is supported/i,
		);
		expect(() => PermissionsInitialMigration({ dialect: "mysql" })).toThrowError(/mysql/);
	});

	it("emits the GRANT/RLS extras byte-identically to the Drizzle driver", () => {
		expect(permissionsPostgresPolicyStatements({ role: "station_app" })).toEqual([
			`ALTER TABLE "public"."permission_policies" ENABLE ROW LEVEL SECURITY`,
			`ALTER TABLE "public"."permission_policy_links" ENABLE ROW LEVEL SECURITY`,
			`ALTER TABLE "public"."permission_policies" FORCE ROW LEVEL SECURITY`,
			`ALTER TABLE "public"."permission_policy_links" FORCE ROW LEVEL SECURITY`,
			`GRANT SELECT, INSERT, UPDATE, DELETE ON "public"."permission_policies", "public"."permission_policy_links" TO "station_app"`,
			`GRANT SELECT, INSERT, UPDATE ON "public"."permission_scope_versions" TO "station_app"`,
		]);

		// The carve-out is off by default and opt-in, never implicit.
		expect(
			permissionsPostgresPolicyStatements({
				role: "station_app",
				rowLevelSecurityOnScopeVersions: true,
			}).filter((statement) => statement.includes("scope_versions")),
		).toEqual([
			`ALTER TABLE "public"."permission_scope_versions" ENABLE ROW LEVEL SECURITY`,
			`ALTER TABLE "public"."permission_scope_versions" FORCE ROW LEVEL SECURITY`,
			`GRANT SELECT, INSERT, UPDATE ON "public"."permission_scope_versions" TO "station_app"`,
		]);
	});

	// -----------------------------------------------------------------------
	// Tier 3 — PermissionsInitialMigration
	// -----------------------------------------------------------------------

	it("runs up and down through TypeORM's own migration runner", async () => {
		const prefix = "mig_";
		const entities = createPermissionsEntities({ tablePrefix: prefix, schemaName: SCHEMA });
		const migration = PermissionsInitialMigration({ tablePrefix: prefix, schemaName: SCHEMA });
		const dataSource = await openWith(entities, [migration]);

		const executed = await dataSource.runMigrations();
		expect(executed.map((entry) => entry.name)).toContain(DEFAULT_MIGRATION_NAME);

		const store = new TypeOrmPolicyStore(dataSource, { entities, poll: false });
		await store.save([
			{
				id: "p1",
				scope: "t",
				kind: "template",
				cedarJson: {} as never,
				enabled: true,
				updatedAt: new Date("2026-07-30T00:00:00.000Z"),
			},
		]);
		expect((await store.load("t")).version).toBe("g0:s1");
		await store.dispose();

		await dataSource.undoLastMigration();

		const remaining = await dataSource.query(
			`select tablename from pg_tables where schemaname = $1 and tablename like $2`,
			[SCHEMA, `${prefix}%`],
		);
		expect(remaining).toEqual([]);
	});

	it("refuses a migration name TypeORM cannot order", () => {
		expect(() => PermissionsInitialMigration({ name: "PermissionsInitial" })).toThrowError(
			/13-digit/,
		);
		expect(() => PermissionsInitialMigration({ name: "Custom1700000000000" })).not.toThrow();
	});

	it("uses a fixed default timestamp, so a redeploy does not re-run it", () => {
		expect(DEFAULT_MIGRATION_NAME).toMatch(/\d{13}$/);
		const first = new (PermissionsInitialMigration())();
		const second = new (PermissionsInitialMigration())();
		expect(first.name).toBe(second.name);
	});
});
