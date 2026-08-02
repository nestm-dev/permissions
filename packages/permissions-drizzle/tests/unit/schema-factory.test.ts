// `createPermissionsSchema`'s two seams that decide what lands in a migration:
// `extraTableConfig` (the RLS/foreign-key hook) and `linkIdColumn`.
//
// Both are here rather than in the drizzle-kit round-trip suite because the
// behaviour under test is *when the factory calls the consumer's code*, which is
// observable without a database and worth failing fast on.
//
// The bug these pin: `pgTable()` does not invoke its config callback, it stores
// it, and drizzle-kit invokes each table's independently and in no guaranteed
// order. Resolving `extraTableConfig` from inside those callbacks therefore
// evaluated the consumer's whole returned object once per table, each time
// against a differently-filled `tables` — so an entry dereferencing a table that
// had not been built yet threw from inside drizzle-kit, and the guard that
// avoided the throw silently dropped the entry instead.

import { sql } from "drizzle-orm";
import {
	foreignKey,
	getTableConfig,
	index,
	pgPolicy,
	pgTable,
	text,
	uuid,
	type AnyPgColumn,
	type PgTableExtraConfigValue,
} from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import {
	assertTablesReady,
	createPermissionsSchema,
	type PermissionsSchema,
	type RawPermissionsTables,
} from "../../src/schema.ts";
import { generateSchemaDdl } from "../../src/testing.ts";
import { stationScopeColumn } from "../fixtures/station-scope.ts";

const organizations = pgTable("schema_factory_organizations", { id: uuid("id").primaryKey() });
const roleGrants = pgTable("schema_factory_role_grants", {
	organizationId: uuid("organization_id").notNull(),
	id: uuid("id").primaryKey(),
});

/** Mirrors RLS's string constraint and pins the concrete inline text builder. */
function acceptsTextTenantColumn(
	column: AnyPgColumn<{ data: string; columnType: "PgText" }>,
): void {
	void column;
}

function acceptsWidenedSchema(schema: PermissionsSchema): void {
	void schema;
}

// ---------------------------------------------------------------------------
// extraTableConfig: evaluation
// ---------------------------------------------------------------------------

describe("extraTableConfig evaluation", () => {
	it("is called exactly once, however many tables are serialised", () => {
		let calls = 0;
		const schema = createPermissionsSchema({
			tablePrefix: "eval_once_",
			extraTableConfig: () => {
				calls += 1;
				return {};
			},
		});

		// Nothing is asked of the consumer while the factory is priming.
		expect(calls).toBe(0);

		getTableConfig(schema.permissionPolicies);
		getTableConfig(schema.permissionPolicyLinks);
		getTableConfig(schema.permissionScopeVersions);
		// And re-serialising (drizzle-kit does, twice, to diff) asks again for nothing.
		getTableConfig(schema.permissionPolicies);

		expect(calls).toBe(1);
	});

	it("sees all three tables' columns, whichever table is serialised first", () => {
		let seen: RawPermissionsTables | undefined;
		const schema = createPermissionsSchema({
			tablePrefix: "eval_all_",
			extraTableConfig: (tables) => {
				seen = tables;
				return {};
			},
		});

		// The links table first — the order that used to leave `tables.policies`
		// undefined, because drizzle-kit walks module exports, not build order.
		getTableConfig(schema.permissionPolicyLinks);

		expect(Object.keys(seen ?? {}).toSorted()).toEqual(["links", "policies", "scopeVersions"]);
		expect(seen?.policies?.["scope"]).toBeDefined();
		expect(seen?.links?.["linkId"]).toBeDefined();
		expect(seen?.scopeVersions?.["version"]).toBeDefined();
	});

	it("does not throw when an entry dereferences a table built after its own", () => {
		// Unguarded on purpose: this is the shape the README teaches and the shape
		// that used to throw `Cannot read properties of undefined (reading 'scope')`
		// out of drizzle-kit, naming neither this option nor the table.
		const schema = createPermissionsSchema({
			tablePrefix: "eval_fwd_",
			extraTableConfig: (t) => ({
				policies: [index("eval_fwd_policies_idx").on(t.policies!["scope"]!)],
				links: [
					foreignKey({
						name: "eval_fwd_links_template_fk",
						columns: [t.links!["scope"]!, t.links!["templateId"]!],
						foreignColumns: [t.policies!["scope"]!, t.policies!["policyId"]!],
					}),
				],
			}),
		});

		expect(() => getTableConfig(schema.permissionPolicyLinks)).not.toThrow();
		expect(getTableConfig(schema.permissionPolicyLinks).foreignKeys).toHaveLength(1);
		expect(getTableConfig(schema.permissionPolicies).indexes).toHaveLength(3);
	});

	it("keeps a links entry that a serialisation-order guard would have dropped", async () => {
		// The workaround the previous release forced — `tables.policies === undefined
		// ? [] : […]` — is now dead code rather than load-bearing, and must not
		// change the answer. Under the old factory this emitted no foreign key at
		// all whenever links was serialised first.
		const schema = createPermissionsSchema({
			tablePrefix: "eval_guard_",
			extraTableConfig: (tables) => ({
				links:
					tables.links === undefined || tables.policies === undefined
						? []
						: [
								foreignKey({
									name: "eval_guard_links_template_fk",
									columns: [tables.links["scope"]!, tables.links["templateId"]!],
									foreignColumns: [tables.policies["scope"]!, tables.policies["policyId"]!],
								}).onDelete("cascade"),
							],
			}),
		});

		getTableConfig(schema.permissionPolicyLinks);

		const ddl = (await generateSchemaDdl(schema)).join("\n");
		expect(ddl).toContain("eval_guard_links_template_fk");
	});
});

// ---------------------------------------------------------------------------
// extraTableConfig: shape
// ---------------------------------------------------------------------------

describe("extraTableConfig shape", () => {
	it("builds all three tables from a config naming only `policies`", async () => {
		const schema = createPermissionsSchema({
			tablePrefix: "shape_partial_",
			extraTableConfig: (t) => ({
				policies: [index("shape_partial_policies_idx").on(t.policies!["kind"]!)],
			}),
		});

		const ddl = await generateSchemaDdl(schema);
		expect(ddl.filter((statement) => statement.startsWith("CREATE TABLE"))).toHaveLength(3);
		expect(ddl.join("\n")).toContain("shape_partial_policies_idx");
	});

	it("tolerates undefined keys and a callback returning nothing at all", async () => {
		const schema = createPermissionsSchema({
			tablePrefix: "shape_empty_",
			extraTableConfig: () => undefined,
		});
		expect(
			(await generateSchemaDdl(schema)).filter((s) => s.startsWith("CREATE TABLE")),
		).toHaveLength(3);

		const explicit = createPermissionsSchema({
			tablePrefix: "shape_undef_",
			extraTableConfig: () => ({
				policies: undefined,
				links: undefined,
				scopeVersions: undefined,
			}),
		});
		expect(
			(await generateSchemaDdl(explicit)).filter((s) => s.startsWith("CREATE TABLE")),
		).toHaveLength(3);
	});

	it("accepts a thunk per key, and calls it at most once", async () => {
		let calls = 0;
		const schema = createPermissionsSchema({
			tablePrefix: "shape_thunk_",
			extraTableConfig: (raw) => {
				const t = assertTablesReady(raw);
				return {
					// A thunk defers to the moment the owning table is serialised, which is
					// what a consumer needs when the entry names something declared later.
					links: (): readonly PgTableExtraConfigValue[] => {
						calls += 1;
						return [index("shape_thunk_links_idx").on(t.links["templateId"]!)];
					},
				};
			},
		});

		expect(calls).toBe(0);
		getTableConfig(schema.permissionPolicyLinks);
		getTableConfig(schema.permissionPolicyLinks);
		expect(calls).toBe(1);

		expect((await generateSchemaDdl(schema)).join("\n")).toContain("shape_thunk_links_idx");
	});

	it("assertTablesReady narrows away the optionality", () => {
		let narrowed = false;
		const schema = createPermissionsSchema({
			tablePrefix: "shape_ready_",
			extraTableConfig: (raw) => {
				const t = assertTablesReady(raw);
				// No `!`, no `?.`, no guard — the point of the helper.
				narrowed = t.policies["scope"] !== undefined && t.links["scope"] !== undefined;
				return {};
			},
		});

		getTableConfig(schema.permissionPolicies);
		expect(narrowed).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// The scope column's *property* name
// ---------------------------------------------------------------------------

describe("the scope column's property name", () => {
	it("preserves an inline scope builder's concrete text type on every table", () => {
		const schema = createPermissionsSchema({
			tablePrefix: "scope_type_",
			scopeColumn: {
				name: "organization_id",
				column: () => text("organization_id").notNull(),
				toScope: (value: string) => value,
				fromScope: (scope: string) => scope,
				supportsGlobalScope: false,
			},
		});

		acceptsTextTenantColumn(schema.permissionPolicies.scope);
		acceptsTextTenantColumn(schema.permissionPolicyLinks.scope);
		acceptsTextTenantColumn(schema.permissionScopeVersions.scope);
		acceptsWidenedSchema(schema);
	});

	it("is `scope` on every table whatever the SQL name is", async () => {
		// The doc bug this pins: `scopeColumn.name` sets the SQL name only. The
		// drizzle property stays `scope`, so `t.policies.organizationId` is
		// `undefined` and an `extraTableConfig` written that way silently produces a
		// policy over nothing.
		const schema = createPermissionsSchema({
			tablePrefix: "prop_name_",
			scopeColumn: stationScopeColumn(),
		});

		for (const table of [
			schema.permissionPolicies,
			schema.permissionPolicyLinks,
			schema.permissionScopeVersions,
		]) {
			const columns = getTableConfig(table).columns;
			const scope = columns.find((column) => column.name === "organization_id");
			expect(scope).toBeDefined();
			expect((table as unknown as Record<string, unknown>)["scope"]).toBeDefined();
			expect((table as unknown as Record<string, unknown>)["organizationId"]).toBeUndefined();
		}

		expect((await generateSchemaDdl(schema)).join("\n")).toContain(
			'"organization_id" uuid NOT NULL',
		);
	});

	it("is `scope` in the object `extraTableConfig` receives", () => {
		let keys: readonly string[] = [];
		const schema = createPermissionsSchema({
			tablePrefix: "prop_raw_",
			scopeColumn: stationScopeColumn(),
			extraTableConfig: (raw) => {
				keys = Object.keys(assertTablesReady(raw).policies);
				return {};
			},
		});

		getTableConfig(schema.permissionPolicies);
		expect(keys).toContain("scope");
		expect(keys).not.toContain("organizationId");
	});
});

// ---------------------------------------------------------------------------
// linkIdColumn
// ---------------------------------------------------------------------------

describe("linkIdColumn", () => {
	it("defaults to text", async () => {
		const schema = createPermissionsSchema({ tablePrefix: "link_text_" });
		expect((await generateSchemaDdl(schema)).join("\n")).toContain('"link_id" text NOT NULL');
	});

	it("emits a uuid link id in the generated DDL", async () => {
		const schema = createPermissionsSchema({
			tablePrefix: "link_uuid_",
			scopeColumn: stationScopeColumn(),
			linkIdColumn: () => uuid("link_id").notNull(),
		});

		const ddl = (await generateSchemaDdl(schema)).join("\n");
		expect(ddl).toContain('"link_id" uuid NOT NULL');
		expect(ddl).toContain(
			'CONSTRAINT "link_uuid_policy_links_pk" PRIMARY KEY("organization_id","link_id")',
		);
	});

	it("keeps the drizzle property name `linkId`, so the store still reads it", () => {
		const schema = createPermissionsSchema({
			tablePrefix: "link_prop_",
			linkIdColumn: () => uuid("grant_id").notNull(),
		});

		const linkId = (schema.permissionPolicyLinks as unknown as Record<string, { name?: string }>)[
			"linkId"
		];
		expect(linkId?.name).toBe("grant_id");
	});

	it("makes the composite foreign key to a uuid grants table expressible", async () => {
		// The whole point: Postgres refuses a foreign key between `text` and `uuid`
		// ("foreign key constraint cannot be implemented … incompatible types"), so
		// a deployment reusing its grant table's uuid primary key as the link id
		// needs the column type to be a first-class option rather than an
		// undocumented `extraColumns` spread-ordering trick.
		const schema = createPermissionsSchema({
			tablePrefix: "link_fk_",
			scopeColumn: stationScopeColumn(),
			linkIdColumn: () => uuid("link_id").notNull(),
			extraTableConfig: (raw) => {
				const t = assertTablesReady(raw);
				return {
					links: [
						foreignKey({
							name: "link_fk_links_role_grant_fk",
							columns: [t.links["scope"]!, t.links["linkId"]!],
							foreignColumns: [roleGrants.organizationId, roleGrants.id],
						}).onDelete("cascade"),
						pgPolicy("link_fk_links_isolation", {
							as: "permissive",
							for: "all",
							to: "public",
							using: sql`${t.links["scope"]} = nullif(current_setting('station.organization_id', true), '')::uuid`,
						}),
					],
					policies: [
						foreignKey({
							name: "link_fk_policies_org_fk",
							columns: [t.policies["scope"]!],
							foreignColumns: [organizations.id],
						}),
					],
				};
			},
		});

		const ddl = (await generateSchemaDdl(schema)).join("\n");
		expect(ddl).toContain("link_fk_links_role_grant_fk");
		expect(ddl).toContain("link_fk_policies_org_fk");
		expect(ddl).toContain('CREATE POLICY "link_fk_links_isolation"');
	});

	it("still honours an extraColumns override of linkId, the old escape hatch", async () => {
		const schema = createPermissionsSchema({
			tablePrefix: "link_extra_",
			extraColumns: { links: { linkId: uuid("link_id").notNull() } },
		});
		expect((await generateSchemaDdl(schema)).join("\n")).toContain('"link_id" uuid NOT NULL');
	});
});
