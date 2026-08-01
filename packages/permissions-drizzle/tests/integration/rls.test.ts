// The store under station's row-level-security regime.
//
// Station's shape, reproduced exactly:
//
//   * a `uuid NOT NULL` tenant column with `supportsGlobalScope: false` — no
//     NULL-tenant escape hatch;
//   * an isolation policy comparing that column to
//     `current_setting('station.organization_id', true)`, declared through
//     `extraTableConfig` so drizzle-kit emits it;
//   * `ENABLE` **and** `FORCE ROW LEVEL SECURITY`, from
//     `permissionsPostgresPolicyStatements`;
//   * a `NOLOGIN NOBYPASSRLS` application role, entered with `SET LOCAL ROLE`;
//   * the context set with `set_config(…, true)` — **transaction-local**, so it
//     cannot leak to the next borrower of a pooled connection.
//
// The role switch is not ceremony. `FORCE ROW LEVEL SECURITY` makes policies
// apply to the table's *owner*, but a **superuser bypasses RLS regardless** —
// and the user these suites connect as is one. A harness that skipped
// `SET LOCAL ROLE` would report green against a table whose policy never ran.
// The first test asserts precisely that, so the harness proves its own teeth.
//
// The load-bearing assertion is the negative one: with no context, `load()`
// returns **zero** policies and zero links — not "some". A partial read is worse
// than an empty one, because an empty one denies and a partial one authorizes
// against half a policy set.

import type { PolicyRecord, TemplateLinkRecord } from "@nestm/permissions-core";
import { sql } from "drizzle-orm";
import { pgPolicy, type PgColumn, type PgTableExtraConfigValue } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
	permissionsPostgresPolicyStatements,
	type RawPermissionsTables,
} from "../../src/schema.ts";
import { DrizzlePolicyStore } from "../../src/store/drizzle-policy-store.ts";
import { provisionPermissionsSchema, type ProvisionedSchema } from "../../src/testing.ts";
import { PG_SKIPPED, PG_URL, assertPostgresReachable, uniqueSuffix } from "../fixtures/pg.ts";
import { scopeToUuid, stationScopeColumn } from "../fixtures/station-scope.ts";

const PREFIX = `${uniqueSuffix("rls")}_`;
const ROLE = `${PREFIX}app`;
const SETTING = "station.organization_id";

const ORG_A = "orgA";
const ORG_B = "orgB";

const FIXTURE_TIME = new Date("2026-07-30T00:00:00.000Z");

function policy(id: string, scope: string, kind: "static" | "template" = "static"): PolicyRecord {
	return {
		id,
		scope,
		kind,
		cedarJson: {
			effect: "permit",
			principal: { op: "All" },
			action: { op: "All" },
			resource: { op: "All" },
			conditions: [],
		} as PolicyRecord["cedarJson"],
		enabled: true,
		updatedAt: FIXTURE_TIME,
	};
}

function link(id: string, scope: string, templateId: string): TemplateLinkRecord {
	return { id, scope, templateId, values: {}, updatedAt: FIXTURE_TIME };
}

describe.skipIf(PG_SKIPPED)("row-level security harness", () => {
	let provisioned: ProvisionedSchema;

	beforeAll(async () => {
		await assertPostgresReachable();

		provisioned = await provisionPermissionsSchema(PG_URL, {
			schema: {
				tablePrefix: PREFIX,
				scopeColumn: stationScopeColumn(),
				extraTableConfig: (tables: RawPermissionsTables) => ({
					policies: [isolationPolicy(`${PREFIX}policies_isolation`, tables.policies)],
					links: [isolationPolicy(`${PREFIX}links_isolation`, tables.links)],
					// Deliberately **no** policy on scope_versions: the approved carve-out.
					scopeVersions: [],
				}),
			} as never,
			beforeCreate: [
				// NOLOGIN: nothing connects as it. NOBYPASSRLS: it is subject to every
				// policy, which is the whole point of the role existing.
				`do $$ begin
					if not exists (select 1 from pg_roles where rolname = '${ROLE}') then
						create role "${ROLE}" nologin nobypassrls;
					end if;
				end $$`,
			],
			afterCreate: [
				...permissionsPostgresPolicyStatements({ role: ROLE, tablePrefix: PREFIX }),
				// The poller reads the versions table with no tenant context at all, so
				// the carve-out has to be granted explicitly rather than implied.
				`grant usage on schema public to "${ROLE}"`,
			],
		});

		// Seed as the superuser, before any role switch: two tenants, two policies
		// each, one template link each.
		const seeder = new DrizzlePolicyStore(provisioned.db, provisioned.schema, { poll: false });
		try {
			await seeder.save([
				policy("a1", ORG_A),
				policy("a-template", ORG_A, "template"),
				policy("b1", ORG_B),
				policy("b-template", ORG_B, "template"),
			]);
			await seeder.linkTemplate(link("a-link", ORG_A, "a-template"));
			await seeder.linkTemplate(link("b-link", ORG_B, "b-template"));
		} finally {
			await seeder.dispose();
		}
	});

	afterAll(async () => {
		await provisioned?.drop();
		// The role owns nothing once the tables are gone, so the drop is unconditional.
		await provisioned?.db.execute(sql.raw(`drop role if exists "${ROLE}"`)).catch(() => undefined);
	});

	/**
	 * Runs `body` as the application role, inside one transaction, with the tenant
	 * context set exactly as station's `withOrganizationContext` does.
	 *
	 * A store built over the transaction handle rather than the pool is not a test
	 * shortcut — it is the only correct wiring under RLS. `set_config(…, true)` is
	 * transaction-local, so a store issuing its statements on a *different* pooled
	 * connection would see no context and read nothing.
	 */
	async function asTenant<T>(
		scope: string | undefined,
		body: (store: DrizzlePolicyStore) => Promise<T>,
	): Promise<T> {
		return provisioned.db.transaction(async (tx) => {
			await tx.execute(sql.raw(`set local role "${ROLE}"`));
			if (scope !== undefined) {
				await tx.execute(sql`select set_config(${SETTING}, ${scopeToUuid(scope)}, true)`);
			}
			const store = new DrizzlePolicyStore(tx, provisioned.schema, { poll: false });
			return body(store);
		});
	}

	// -------------------------------------------------------------------------
	// The harness proves its own teeth
	// -------------------------------------------------------------------------

	it("FORCE ROW LEVEL SECURITY does not constrain a superuser — hence the role switch", async () => {
		// If this ever starts returning zero, the role switch below has stopped being
		// what makes the isolation tests meaningful, and someone should find out why
		// before trusting them.
		const store = new DrizzlePolicyStore(provisioned.db, provisioned.schema, { poll: false });
		try {
			const bundle = await store.load(ORG_A);
			expect(bundle.policies.map((record) => record.id)).toEqual(["a-template", "a1"]);
		} finally {
			await store.dispose();
		}

		const rows = await provisioned.db.execute<{ n: string }>(
			sql.raw(`select count(*)::text as n from "${PREFIX}policies"`),
		);
		const list = Array.isArray(rows) ? rows : (rows as { rows: { n: string }[] }).rows;
		// All four rows, across both tenants: the policy exists and is simply not
		// applied to this role.
		expect(list[0]?.n).toBe("4");
	});

	it("confirms the role really is NOBYPASSRLS", async () => {
		const rows = await provisioned.db.execute<{ rolbypassrls: boolean; rolcanlogin: boolean }>(
			sql`select rolbypassrls, rolcanlogin from pg_roles where rolname = ${ROLE}`,
		);
		const list = Array.isArray(rows)
			? rows
			: (rows as { rows: { rolbypassrls: boolean; rolcanlogin: boolean }[] }).rows;
		expect(list[0]).toMatchObject({ rolbypassrls: false, rolcanlogin: false });
	});

	// -------------------------------------------------------------------------
	// Inside a tenant context
	// -------------------------------------------------------------------------

	it("reads exactly one tenant's bundle inside that tenant's context", async () => {
		const bundle = await asTenant(ORG_A, (store) => store.load(ORG_A));

		expect(bundle.policies.map((record) => record.id)).toEqual(["a-template", "a1"]);
		expect(bundle.links.map((record) => record.id)).toEqual(["a-link"]);
		expect(bundle.policies.every((record) => record.scope === ORG_A)).toBe(true);
	});

	it("reads the other tenant's bundle inside the other tenant's context", async () => {
		const bundle = await asTenant(ORG_B, (store) => store.load(ORG_B));

		expect(bundle.policies.map((record) => record.id)).toEqual(["b-template", "b1"]);
		expect(bundle.links.map((record) => record.id)).toEqual(["b-link"]);
	});

	it("returns nothing when asked for another tenant from inside a context", async () => {
		// Belt and braces: the store's own `WHERE scope = …` and the database's policy
		// both say no. Either alone would be enough; the point is that neither is
		// relied on.
		const bundle = await asTenant(ORG_A, (store) => store.load(ORG_B));
		expect(bundle.policies).toEqual([]);
		expect(bundle.links).toEqual([]);
	});

	it("writes and reads back inside a context", async () => {
		const bundle = await asTenant(ORG_A, async (store) => {
			await store.save([policy("a2", ORG_A)]);
			return store.load(ORG_A);
		});

		expect(bundle.policies.map((record) => record.id)).toEqual(["a-template", "a1", "a2"]);
	});

	it("refuses a write aimed at another tenant, by WITH CHECK", async () => {
		// The store would happily write it — the row names ORG_B and the store was
		// asked for ORG_B. It is the database that refuses, which is the second wall
		// the whole regime exists to provide.
		await expectRlsViolation(asTenant(ORG_A, (store) => store.save([policy("smuggled", ORG_B)])));

		// And nothing landed: the transaction rolled back with it.
		const bundle = await asTenant(ORG_B, (store) => store.load(ORG_B));
		expect(bundle.policies.map((record) => record.id)).not.toContain("smuggled");
	});

	// -------------------------------------------------------------------------
	// With no context at all
	// -------------------------------------------------------------------------

	it("returns ZERO rows with no context — never a partial read", async () => {
		const bundle = await asTenant(undefined, (store) => store.load(ORG_A));

		// Zero, and specifically zero of *both*: a bundle carrying policies but no
		// links (or the reverse) would build a policy set that silently revokes every
		// template grant.
		expect(bundle.policies).toEqual([]);
		expect(bundle.links).toEqual([]);
	});

	it("returns zero rows for every tenant with no context", async () => {
		for (const scope of [ORG_A, ORG_B]) {
			const bundle = await asTenant(undefined, (store) => store.load(scope));
			expect(bundle.policies, scope).toEqual([]);
			expect(bundle.links, scope).toEqual([]);
		}
	});

	it("refuses a write with no context", async () => {
		await expectRlsViolation(asTenant(undefined, (store) => store.save([policy("orphan", ORG_A)])));
	});

	it("treats an empty context string as no context, not as a match", async () => {
		// `nullif(current_setting(…), '')::uuid` is NULL, and `col = NULL` is NULL,
		// which excludes the row. An implementation that cast `''` directly would
		// raise instead — also safe, but the harness pins which one happens.
		const bundle = await provisioned.db.transaction(async (tx) => {
			await tx.execute(sql.raw(`set local role "${ROLE}"`));
			await tx.execute(sql`select set_config(${SETTING}, ${""}, true)`);
			const store = new DrizzlePolicyStore(tx, provisioned.schema, { poll: false });
			return store.load(ORG_A);
		});

		expect(bundle.policies).toEqual([]);
	});

	it("issues no overlapping queries when run over a transaction handle", async () => {
		// Running the store over a `transaction()` handle is not an exotic call shape
		// under RLS — it is the *required* one, because `set_config(…, true)` is
		// transaction-local and a store querying a different pooled connection would
		// see no context and read nothing. A transaction handle is a single `pg`
		// client, and overlapping queries on one client are deprecated in `pg@8` and
		// **removed in `pg@9`**. So a `Promise.all` inside `load()` would be a
		// forward-compat break in exactly the deployment this package is aimed at.
		const warnings: string[] = [];
		const onWarning = (warning: Error): void => {
			if (warning.name === "DeprecationWarning") {
				warnings.push(warning.message);
			}
		};

		process.on("warning", onWarning);
		try {
			await asTenant(ORG_A, async (store) => {
				await store.load(ORG_A);
				await store.currentVersion(ORG_A);
			});
			// `process.on('warning')` fires on a later turn than the call that emitted it.
			await new Promise((resolve) => setTimeout(resolve, 50));
		} finally {
			process.off("warning", onWarning);
		}

		expect(warnings.filter((message) => message.includes("already executing a query"))).toEqual([]);
	});

	it("does not leak the context to the next user of the connection", async () => {
		// `set_config(…, true)` is transaction-local. If it were session-local, a
		// pooled connection would hand one tenant's context to the next request.
		await asTenant(ORG_A, (store) => store.load(ORG_A));

		const rows = await provisioned.db.execute<{ setting: string }>(
			sql`select current_setting(${SETTING}, true) as setting`,
		);
		const list = Array.isArray(rows) ? rows : (rows as { rows: { setting: string }[] }).rows;
		expect(list[0]?.setting ?? "").toBe("");
	});

	// -------------------------------------------------------------------------
	// The scope-versions carve-out
	// -------------------------------------------------------------------------

	it("keeps the scope-versions table readable with no context — the approved carve-out", async () => {
		// The invalidation poller runs `SELECT scope, version … WHERE updated_at > $1`
		// with **no** tenant context. Under RLS that would return zero rows and no
		// cache would ever invalidate. The table holds no tenant *data* — only a
		// monotonic counter keyed by tenant id — so it is deliberately left
		// unprotected, and that decision is asserted here rather than assumed.
		const versions = provisioned.tableNames[2] as string;

		const rows = await provisioned.db.transaction(async (tx) => {
			await tx.execute(sql.raw(`set local role "${ROLE}"`));
			const result = await tx.execute<{ n: string }>(
				sql.raw(`select count(*)::text as n from "${versions}"`),
			);
			return Array.isArray(result) ? result : (result as { rows: { n: string }[] }).rows;
		});

		// Both tenants' counters, with no context set.
		expect(Number(rows[0]?.n ?? "0")).toBeGreaterThanOrEqual(2);
	});

	it("leaves RLS off the scope-versions table and on the other two", async () => {
		const rows = await provisioned.db.execute<{
			relname: string;
			relrowsecurity: boolean;
			relforcerowsecurity: boolean;
		}>(
			sql`select relname, relrowsecurity, relforcerowsecurity from pg_class
			    where relname in (${provisioned.tableNames[0]}, ${provisioned.tableNames[1]}, ${provisioned.tableNames[2]})
			    order by relname`,
		);
		const list = (
			Array.isArray(rows) ? rows : (rows as { rows: Record<string, unknown>[] }).rows
		) as { relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }[];

		const byName = new Map(list.map((row) => [row.relname, row]));

		expect(byName.get(provisioned.tableNames[0] as string)).toMatchObject({
			relrowsecurity: true,
			relforcerowsecurity: true,
		});
		expect(byName.get(provisioned.tableNames[1] as string)).toMatchObject({
			relrowsecurity: true,
			relforcerowsecurity: true,
		});
		expect(byName.get(provisioned.tableNames[2] as string)).toMatchObject({
			relrowsecurity: false,
			relforcerowsecurity: false,
		});
	});

	it("lets the poller see a change made by another tenant's transaction", async () => {
		// The end-to-end consequence of the carve-out: a write inside ORG_B's context
		// must become visible to a poller that has no context at all.
		const poller = new DrizzlePolicyStore(provisioned.db, provisioned.schema, { poll: false });
		const seen: string[] = [];
		poller.watch((event) => void seen.push(String(event.scope)));

		try {
			await poller.pollOnce();
			expect(seen).toEqual([]);

			await asTenant(ORG_B, (store) => store.save([policy("b2", ORG_B)]));

			await poller.pollOnce();
			expect(seen).toEqual([ORG_B]);
		} finally {
			await poller.dispose();
		}
	});

	// -------------------------------------------------------------------------
	// The no-global-scope half of the station shape
	// -------------------------------------------------------------------------

	it("refuses to write the global scope at all", async () => {
		// A `NOT NULL uuid` column has no value meaning "every tenant". The store
		// rejects it before any SQL is issued, rather than inventing a sentinel.
		const store = new DrizzlePolicyStore(provisioned.db, provisioned.schema, { poll: false });
		try {
			expect(store.supportsGlobalScope).toBe(false);
			await expect(store.save([policy("global", "")])).rejects.toThrow(/global scope/i);
		} finally {
			await store.dispose();
		}
	});

	it("skips the global half of the load union entirely", async () => {
		const store = new DrizzlePolicyStore(provisioned.db, provisioned.schema, { poll: false });
		try {
			const bundle = await store.load(ORG_A);
			// `g<n>:s<m>` with the global half pinned at 0 — no global row can exist
			// under this schema, so it is never read.
			expect(bundle.version).toMatch(/^g0:s\d+$/);
		} finally {
			await store.dispose();
		}
	});
});

/**
 * Asserts `promise` rejected because Postgres refused the row, not for some
 * other reason.
 *
 * The whole cause chain is searched: drizzle wraps the driver error in a
 * `Failed query: …` of its own, so a plain `rejects.toThrow(/row-level/)` would
 * match nothing and a bare `rejects.toThrow()` would pass for a typo in the
 * fixture just as happily as for a genuine policy violation.
 */
async function expectRlsViolation(promise: Promise<unknown>): Promise<void> {
	let thrown: unknown;
	try {
		await promise;
	} catch (error) {
		thrown = error;
	}

	expect(thrown, "expected the write to be refused").toBeDefined();

	const messages: string[] = [];
	for (let error = thrown; error instanceof Error; error = error.cause) {
		messages.push(error.message);
		// `pg` reports the SQLSTATE for an RLS refusal as 42501 (insufficient
		// privilege), which is the machine-readable half of the same fact.
		const code = (error as { code?: unknown }).code;
		if (code === "42501") {
			return;
		}
	}

	expect(messages.join("\n")).toMatch(/row-level security/i);
}

/** Station's isolation policy, over whichever scope column the factory built. */
function isolationPolicy(
	name: string,
	table: Record<string, PgColumn> | undefined,
): PgTableExtraConfigValue {
	const scope = table?.["scope"];
	const predicate = sql`${scope} = nullif(current_setting(${sql.raw(`'${SETTING}'`)}, true), '')::uuid`;
	return pgPolicy(name, {
		as: "permissive",
		for: "all",
		to: "public",
		using: predicate,
		withCheck: predicate,
	}) as unknown as PgTableExtraConfigValue;
}
