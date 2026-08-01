// The row-level-security harness — station's shape, reproduced.
//
// Station runs its application as a `NOLOGIN NOBYPASSRLS` role against tables
// under `FORCE ROW LEVEL SECURITY`, with the tenant supplied by
// `current_setting('…', true)`. Three claims have to hold for this driver to be
// droppable into that regime, and each fails as *wrong authorization* rather than
// as an error:
//
//   1. **With a tenant context, the driver works normally.** Nothing in it issues
//      `SET`/`SET LOCAL`, so a consumer's own context wrapper is all that is
//      needed.
//   2. **Without a context, a read yields ZERO rows — not a partial one.** An
//      empty policy bundle is `deny` everywhere downstream, which is the
//      fail-closed answer. A *partial* read would be the dangerous one: a bundle
//      missing its `forbid` policies is strictly more permissive than the real one.
//   3. **The `scope_versions` carve-out is real.** The invalidation poller runs
//      with no tenant context by construction — it asks "which scopes changed?",
//      a question that has no tenant. Under RLS it would see nothing and no cache
//      would ever invalidate. The design's recommendation is to leave that one
//      table unprotected (it holds a monotonic counter keyed by tenant id, not
//      tenant data), and `permissionsPostgresPolicyStatements` defaults to exactly
//      that. This suite pins both halves: protected tables are invisible without a
//      context, and the version table is not.
//
// The connection pool is capped at **one** client, which is not an optimisation:
// `set_config(..., false)` is session-scoped, so a second client would be a second
// session with no context at all — and a `load()` that fanned its reads out
// concurrently would deadlock against its own pool. It does not, and this suite is
// where that would show.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DataSource } from "typeorm";

import { createPermissionsEntities } from "../../src/entities/create-entities.ts";
import { buildPermissionsMigration } from "../../src/entities/migration.ts";
import { TypeOrmPolicyStore } from "../../src/store/typeorm-policy-store.ts";
import { PG_SKIPPED, PG_URL, assertPostgresReachable, uniqueSuffix } from "../fixtures/pg.ts";
import { scopeToUuid, stationScopeColumn } from "../fixtures/station-scope.ts";

const SCHEMA = uniqueSuffix("nestm_rls");
const PREFIX = "rls_";
const ROLE = uniqueSuffix("nestm_app");
const SETTING = "nestm.tenant";

const TENANT_A = "tenant:a";
const TENANT_B = "tenant:b";
const AT = new Date("2026-07-30T00:00:00.000Z");

const entities = createPermissionsEntities({
	tablePrefix: PREFIX,
	schemaName: SCHEMA,
	scopeColumn: stationScopeColumn(),
});

let admin: DataSource;
let app: DataSource;
let store: TypeOrmPolicyStore;

function policy(id: string, scope: string) {
	return {
		id,
		scope,
		kind: "static" as const,
		cedarJson: { effect: "permit", id } as never,
		enabled: true,
		updatedAt: AT,
	};
}

/** The isolation policy, in the shape station writes it. */
function isolationPolicy(table: string): string {
	const predicate = `"organization_id" = nullif(current_setting('${SETTING}', true), '')::uuid`;
	return (
		`create policy "${table}_isolation_policy" on "${SCHEMA}"."${table}" ` +
		`as permissive for all to public using (${predicate}) with check (${predicate})`
	);
}

/** Enters the app role with a tenant context; `undefined` means "no context at all". */
async function enter(scope: string | undefined): Promise<void> {
	await app.query(`set role "${ROLE}"`);
	await app.query(`select set_config($1, $2, false)`, [
		SETTING,
		scope === undefined ? "" : scopeToUuid(scope),
	]);
}

async function leave(): Promise<void> {
	await app.query(`select set_config($1, '', false)`, [SETTING]);
	await app.query("reset role");
}

describe.skipIf(PG_SKIPPED)("row-level security", () => {
	beforeAll(async () => {
		await assertPostgresReachable();

		admin = new DataSource({ type: "postgres", url: PG_URL, extra: { max: 2 } });
		await admin.initialize();

		await admin.query(`drop role if exists "${ROLE}"`);
		// NOLOGIN because the application reaches it through `SET ROLE`, NOBYPASSRLS
		// because a role that bypasses RLS makes the whole exercise decorative.
		await admin.query(`create role "${ROLE}" nologin nobypassrls`);
		await admin.query(`create schema if not exists "${SCHEMA}"`);
		await admin.query(`grant usage on schema "${SCHEMA}" to "${ROLE}"`);

		const { up } = buildPermissionsMigration({
			dialect: "postgres",
			tablePrefix: PREFIX,
			schemaName: SCHEMA,
			scopeColumn: stationScopeColumn(),
			// The driver's own GRANT/RLS statements, with the design's default: RLS on
			// the two tenant tables, and *not* on the version table.
			postgresPolicies: { role: ROLE },
		});
		for (const statement of up) {
			await admin.query(statement);
		}

		// The `USING` predicate is application-specific — the driver deliberately
		// does not guess one — so the harness supplies station's.
		await admin.query(isolationPolicy(`${PREFIX}policies`));
		await admin.query(isolationPolicy(`${PREFIX}policy_links`));

		app = new DataSource({
			type: "postgres",
			url: PG_URL,
			entities: [entities.policy, entities.link, entities.scopeVersion],
			// One client, one session: `set_config(..., false)` is session-scoped.
			extra: { max: 1 },
		});
		await app.initialize();

		store = new TypeOrmPolicyStore(app, { entities, poll: false });

		// Written as the table owner (the DataSource's login role), which FORCE RLS
		// does *not* exempt — so the seed itself runs under a context.
		await enter(TENANT_A);
		await store.save([policy("a1", TENANT_A), policy("a2", TENANT_A)]);
		await store.linkTemplate({
			id: "link-a",
			scope: TENANT_A,
			templateId: "a1",
			values: { "?principal": { type: "User", id: "u1" } },
			updatedAt: AT,
		});
		await leave();

		await enter(TENANT_B);
		await store.save([policy("b1", TENANT_B)]);
		await leave();
	});

	afterAll(async () => {
		if (app?.isInitialized) {
			await store.dispose();
			await app.destroy();
		}
		if (admin?.isInitialized) {
			await admin.query(`drop schema if exists "${SCHEMA}" cascade`);
			await admin.query(`drop owned by "${ROLE}"`);
			await admin.query(`drop role if exists "${ROLE}"`);
			await admin.destroy();
		}
	});

	it("reads a tenant's own bundle under its context", async () => {
		await enter(TENANT_A);
		try {
			const bundle = await store.load(TENANT_A);
			expect(bundle.policies.map((record) => record.id)).toEqual(["a1", "a2"]);
			expect(bundle.links.map((link) => link.id)).toEqual(["link-a"]);
		} finally {
			await leave();
		}
	});

	it("cannot see another tenant's rows even when asked for them", async () => {
		await enter(TENANT_A);
		try {
			// The store issues `WHERE scope IN (…)` for tenant B; RLS removes the rows
			// underneath it. Belt and braces: the driver's filter and the database's.
			const bundle = await store.load(TENANT_B);
			expect(bundle.policies).toEqual([]);
			expect(bundle.links).toEqual([]);
		} finally {
			await leave();
		}
	});

	it("yields ZERO rows with no context — not a partial read", async () => {
		await enter(undefined);
		try {
			const bundle = await store.load(TENANT_A);

			// This is the assertion the whole file exists for. An empty bundle is
			// `deny` downstream, which is the fail-closed answer. A bundle carrying
			// tenant A's *permits* but not its *forbids* would be strictly more
			// permissive than the real one, and that is what a partial read looks like.
			expect(bundle.policies).toEqual([]);
			expect(bundle.links).toEqual([]);

			const rows = await app.query(
				`select count(*)::int as count from "${SCHEMA}"."${PREFIX}policies"`,
			);
			expect(rows[0].count).toBe(0);
		} finally {
			await leave();
		}
	});

	it("refuses to write into another tenant under WITH CHECK", async () => {
		await enter(TENANT_A);
		try {
			const beforeA = await store.currentVersion(TENANT_A);
			const beforeB = await store.currentVersion(TENANT_B);

			await expect(store.save([policy("smuggled", TENANT_B)])).rejects.toThrow();

			// And nothing was written: the version bump shares the transaction with the
			// policy write, so a row the database refused cannot leave a bumped counter
			// behind for a replica to act on.
			expect(await store.currentVersion(TENANT_A)).toBe(beforeA);
			expect(await store.currentVersion(TENANT_B)).toBe(beforeB);
		} finally {
			await leave();
		}
	});

	it("exposes only a counter across tenants — the carve-out's actual cost", async () => {
		// Naming the trade rather than discovering it later: with no RLS on
		// `scope_versions`, tenant A *can* read tenant B's revision number. That is
		// the whole of what leaks — an integer that says "something changed", keyed by
		// a tenant id the application already knows. No policy text, no principal, no
		// resource. A security reviewer signs off on this line, not on a paragraph.
		await enter(TENANT_A);
		try {
			expect(await store.currentVersion(TENANT_B)).toMatch(/^g0:s[1-9]/);

			// The policies themselves stay invisible, which is the half that matters.
			const bundle = await store.load(TENANT_B);
			expect(bundle.policies).toEqual([]);
		} finally {
			await leave();
		}
	});

	it("keeps the invalidation poller working without any tenant context", async () => {
		// The carve-out. `permissionsPostgresPolicyStatements` leaves
		// `scope_versions` unprotected by default, so the poller — which has no
		// tenant to set — still sees every changed scope.
		const seen: string[] = [];
		const unsubscribe = store.watch((event) => {
			seen.push(String(event.scope));
		});

		try {
			await enter(undefined);
			await store.pollOnce();

			// A write by "another replica", under its own context.
			await leave();
			await enter(TENANT_A);
			await store.save([policy("a3", TENANT_A)]);
			await leave();

			await enter(undefined);
			seen.length = 0;
			await store.pollOnce();

			expect(seen).toEqual([TENANT_A]);
		} finally {
			await leave();
			unsubscribe();
		}
	});

	it("stops invalidating if the carve-out is closed, which is why it exists", async () => {
		// The counter-example, asserted rather than asserted-about: turning RLS on for
		// the version table with no policy makes the poller blind. Anyone tempted to
		// "just protect everything" gets this test's name in their search results.
		await admin.query(
			`alter table "${SCHEMA}"."${PREFIX}scope_versions" enable row level security`,
		);
		await admin.query(`alter table "${SCHEMA}"."${PREFIX}scope_versions" force row level security`);

		try {
			await enter(undefined);
			const rows = await app.query(
				`select count(*)::int as count from "${SCHEMA}"."${PREFIX}scope_versions"`,
			);
			expect(rows[0].count).toBe(0);
		} finally {
			await leave();
			await admin.query(
				`alter table "${SCHEMA}"."${PREFIX}scope_versions" disable row level security`,
			);
		}
	});
});
