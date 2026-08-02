// The migration round-trip, and the footgun, proven.
//
// `createPermissionsSchema` returns an object. drizzle-kit's
// `prepareFromExports` walks `Object.values(moduleExports)` and keeps the
// entries that pass `is(value, PgTable)`. So:
//
// ```ts
// // correct — three top-level PgTables, three CREATE TABLEs
// export const { permissionPolicies, permissionPolicyLinks, permissionScopeVersions } =
//   createPermissionsSchema({ … });
//
// // silently produces an EMPTY migration
// export const permissionsSchema = createPermissionsSchema({ … });
// ```
//
// The second form fails with **no error anywhere**: `drizzle-kit generate`
// reports success, writes a migration with zero statements, and the application
// dies at runtime on `relation "permission_policies" does not exist`. A README
// paragraph is not a strong enough guard against that, so both halves are
// asserted here — including the empty one, which is the assertion that will fail
// (loudly, and in the right place) if a future drizzle-kit starts walking
// nested objects and the README paragraph becomes wrong.
//
// The suite then *applies* the generated DDL and runs the store against it. A
// migration that generates but does not apply, or applies but does not support
// the store, is the same outage one step later.

import { sql } from "drizzle-orm";
import { foreignKey, pgPolicy, pgTable, uuid } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPermissionsSchema, permissionsPostgresPolicyStatements } from "../../src/schema.ts";
import { DrizzlePolicyStore } from "../../src/store/drizzle-policy-store.ts";
import { generateSchemaDdl } from "../../src/testing.ts";
import { PG_SKIPPED, assertPostgresReachable, openPg, uniqueSuffix } from "../fixtures/pg.ts";
import { stationScopeColumn } from "../fixtures/station-scope.ts";

const PREFIX = `${uniqueSuffix("kit")}_`;

type DrizzleKitApi = typeof import("drizzle-kit/api");

let api: DrizzleKitApi;

beforeAll(async () => {
	api = await import("drizzle-kit/api");
});

// ---------------------------------------------------------------------------
// The two export shapes
// ---------------------------------------------------------------------------

describe("drizzle-kit export shapes", () => {
	it("produces the full migration from top-level consts", async () => {
		const { permissionPolicies, permissionPolicyLinks, permissionScopeVersions } =
			createPermissionsSchema({ tablePrefix: PREFIX });

		// Exactly the shape a consumer's `schema.ts` module namespace has after the
		// documented destructuring.
		const statements = await generate({
			permissionPolicies,
			permissionPolicyLinks,
			permissionScopeVersions,
		});

		const createTables = statements.filter((statement) => statement.startsWith("CREATE TABLE"));
		expect(createTables).toHaveLength(3);
		expect(statements.filter((statement) => statement.startsWith("CREATE INDEX"))).toHaveLength(3);
	});

	it("produces an EMPTY migration from a nested object — the documented footgun", async () => {
		const schema = createPermissionsSchema({ tablePrefix: PREFIX });

		// `export const permissionsSchema = createPermissionsSchema(…)`. Nothing in
		// `Object.values({ schema })` is a `PgTable`, so drizzle-kit sees no tables and
		// says so by saying nothing.
		const statements = await generate({ schema });

		expect(statements).toEqual([]);
	});

	it("is the destructuring, not the naming, that matters", async () => {
		// Renaming on the way out is fine — drizzle-kit reads values, not keys — which
		// is worth pinning so the README's emphasis lands on the right word.
		const schema = createPermissionsSchema({ tablePrefix: PREFIX });
		const statements = await generate({
			policies: schema.permissionPolicies,
			links: schema.permissionPolicyLinks,
			versions: schema.permissionScopeVersions,
		});

		expect(statements.filter((statement) => statement.startsWith("CREATE TABLE"))).toHaveLength(3);
	});
});

// ---------------------------------------------------------------------------
// What the migration actually contains
// ---------------------------------------------------------------------------

describe("generated DDL", () => {
	it("emits every column, key, check and index the store depends on", async () => {
		const schema = createPermissionsSchema({ tablePrefix: PREFIX });
		const ddl = (await generateSchemaDdl(schema)).join("\n");

		// Composite primary keys — the store upserts on exactly these targets.
		expect(ddl).toContain(`CONSTRAINT "${PREFIX}policies_pk" PRIMARY KEY("scope","policy_id")`);
		expect(ddl).toContain(`CONSTRAINT "${PREFIX}policy_links_pk" PRIMARY KEY("scope","link_id")`);
		expect(ddl).toContain(`CONSTRAINT "${PREFIX}scope_versions_pk" PRIMARY KEY("scope")`);

		// `kind` is checked, not trusted.
		expect(ddl).toContain("in ('static', 'template')");

		// The paired slot checks: a half-filled slot is a link Cedar rejects at build
		// time, so it is caught at write time instead (D6).
		expect(ddl).toContain(
			`CHECK (("${PREFIX}policy_links"."principal_type" is null) = ` +
				`("${PREFIX}policy_links"."principal_id" is null))`,
		);
		expect(ddl).toContain(
			`CHECK (("${PREFIX}policy_links"."resource_type" is null) = ` +
				`("${PREFIX}policy_links"."resource_id" is null))`,
		);

		// The load path's partial index, and the admin API's GIN index.
		expect(ddl).toContain(`WHERE "${PREFIX}policies"."enabled"`);
		expect(ddl).toContain('USING gin ("cedar_json" jsonb_path_ops)');
		// Polling compares the monotonic counter for every primary-keyed scope; a
		// timestamp index would add write cost without serving a query.
		expect(ddl).not.toContain(`ON "${PREFIX}scope_versions" USING btree ("updated_at")`);
	});

	it("emits NO foreign key from links.template_id to policies.policy_id", async () => {
		// Deliberate. The obvious `ON DELETE CASCADE` turns "an operator deleted a
		// template" into "every grant under it silently disappeared"; core's
		// conformance suite requires the opposite — an orphaned link must survive into
		// the bundle so `buildPolicySet` can refuse it loudly.
		const schema = createPermissionsSchema({ tablePrefix: PREFIX });
		const ddl = (await generateSchemaDdl(schema)).join("\n");

		expect(ddl).not.toContain("FOREIGN KEY");
		expect(ddl.toUpperCase()).not.toContain("ON DELETE CASCADE");
	});

	it("carries extraTableConfig into the migration — the RLS seam", async () => {
		const organizations = pgTable("kit_organizations", { id: uuid("id").primaryKey() });

		const schema = createPermissionsSchema({
			tablePrefix: `${PREFIX}rls_`,
			scopeColumn: stationScopeColumn(),
			extraTableConfig: (tables) => ({
				policies: [
					foreignKey({
						name: `${PREFIX}rls_policies_org_fk`,
						columns: [tables.policies?.["scope"] as never],
						foreignColumns: [organizations.id],
					}).onDelete("cascade"),
					pgPolicy(`${PREFIX}rls_policies_isolation`, {
						as: "permissive",
						for: "all",
						to: "public",
						using: sql`${tables.policies?.["scope"]} = nullif(current_setting('station.organization_id', true), '')::uuid`,
					}),
				],
			}),
		});

		const ddl = (await generateSchemaDdl(schema)).join("\n");

		expect(ddl).toContain("FOREIGN KEY");
		expect(ddl).toContain("ON DELETE cascade");
		expect(ddl).toContain(`CREATE POLICY "${PREFIX}rls_policies_isolation"`);
		// drizzle-kit emits `ENABLE ROW LEVEL SECURITY` for a table carrying a policy;
		// `FORCE` has no schema-level representation at all, which is why
		// `permissionsPostgresPolicyStatements` exists.
		expect(ddl).toContain("ENABLE ROW LEVEL SECURITY");
		expect(ddl).not.toContain("FORCE ROW LEVEL SECURITY");
	});

	it("hand-appends the grants and FORCE that drizzle-kit cannot express", () => {
		const statements = permissionsPostgresPolicyStatements({
			role: "station_app",
			tablePrefix: PREFIX,
		});
		const text = statements.join(";\n");

		expect(text).toContain(`ALTER TABLE "public"."${PREFIX}policies" FORCE ROW LEVEL SECURITY`);
		expect(text).toContain(`ALTER TABLE "public"."${PREFIX}policy_links" FORCE ROW LEVEL SECURITY`);
		expect(text).toContain('TO "station_app"');
		// No DELETE on the versions table: a role that cannot delete a scope's counter
		// cannot reset an invalidation stamp backwards.
		expect(text).toContain(
			`GRANT SELECT, INSERT, UPDATE ON "public"."${PREFIX}scope_versions" TO "station_app"`,
		);
		// And no RLS on it by default — the carve-out the design argues for, because
		// the poller runs with no tenant context.
		expect(text).not.toContain(`"${PREFIX}scope_versions" ENABLE ROW LEVEL SECURITY`);
	});

	it("honours the scope column the consumer supplied", async () => {
		const schema = createPermissionsSchema({
			tablePrefix: `${PREFIX}uuid_`,
			scopeColumn: stationScopeColumn(),
		});
		const ddl = (await generateSchemaDdl(schema)).join("\n");

		expect(ddl).toContain('"organization_id" uuid NOT NULL');
		expect(ddl).not.toContain('"scope" text');
		expect(ddl).toContain(
			`CONSTRAINT "${PREFIX}uuid_policies_pk" PRIMARY KEY("organization_id","policy_id")`,
		);
	});

	it("generates a fresh column builder per table", async () => {
		// `scopeColumn.column` is called once per table and must return a *new*
		// builder each time: drizzle column builders carry per-table state, so a
		// shared one attaches itself to whichever table was built last and the other
		// two lose their scope column entirely.
		const schema = createPermissionsSchema({ tablePrefix: `${PREFIX}fresh_` });
		const ddl = (await generateSchemaDdl(schema)).join("\n");

		expect(ddl.match(/"scope" text NOT NULL/g)).toHaveLength(3);
	});
});

// ---------------------------------------------------------------------------
// It has to actually apply, and the store has to work against it
// ---------------------------------------------------------------------------

describe.skipIf(PG_SKIPPED)("the generated migration applies", () => {
	const APPLIED = `${uniqueSuffix("applied")}_`;
	let pg: ReturnType<typeof openPg>;
	let store: DrizzlePolicyStore | undefined;

	beforeAll(async () => {
		await assertPostgresReachable();
		pg = openPg();
	});

	afterAll(async () => {
		await store?.dispose();
		if (pg !== undefined) {
			await pg.db.execute(
				sql.raw(
					`drop table if exists "${APPLIED}policies", "${APPLIED}policy_links", "${APPLIED}scope_versions" cascade`,
				),
			);
			await pg.close();
		}
	});

	it("creates tables the store can round-trip a policy through", async () => {
		const schema = createPermissionsSchema({ tablePrefix: APPLIED });

		// Statement for statement, exactly what `drizzle-kit generate` would write.
		for (const statement of await generateSchemaDdl(schema)) {
			await pg.db.execute(sql.raw(statement));
		}

		store = new DrizzlePolicyStore(pg.db, schema, { poll: false });

		await store.save([
			{
				id: "p1",
				scope: "tenant",
				kind: "static",
				cedarJson: {
					effect: "permit",
					principal: { op: "All" },
					action: { op: "All" },
					resource: { op: "All" },
					conditions: [],
				} as never,
				enabled: true,
				updatedAt: new Date("2026-07-30T00:00:00.000Z"),
			},
		]);

		const bundle = await store.load("tenant");
		expect(bundle.policies.map((record) => record.id)).toEqual(["p1"]);
		expect(bundle.version).toBe("g0:s1");
	});

	it("re-generating against the applied schema produces an empty diff", async () => {
		// The `db:generate must produce an EMPTY diff` check from the design's
		// verification list, in miniature: the factory's output is a fixed point.
		const schema = createPermissionsSchema({ tablePrefix: APPLIED });
		const snapshot = await api.generateDrizzleJson({ ...schema });
		const diff = await api.generateMigration(snapshot, snapshot);

		expect(diff).toEqual([]);
	});
});

/** `drizzle-kit generate` over a module namespace of the given shape. */
async function generate(moduleExports: Record<string, unknown>): Promise<readonly string[]> {
	const empty = await api.generateDrizzleJson({});
	return api.generateMigration(empty, await api.generateDrizzleJson(moduleExports as never));
}
