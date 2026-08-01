// `@nestm/permissions-drizzle/testing` — the harness for running core's shared
// `PolicyStore` conformance suite against a real Postgres.
//
// The suite itself lives in core, because "conformant" has to mean one thing
// across `MemoryPolicyStore`, this driver and the TypeORM one. What a driver has
// to supply is the boring half: a fresh, empty store per test, and a teardown
// that leaves nothing behind. That is all this file is.
//
// Provisioning goes through **drizzle-kit's own generator** rather than
// hand-written DDL. A hand-written `CREATE TABLE` in a test fixture is a second
// source of truth for the schema, and the failure mode is a suite that passes
// against tables no consumer will ever have. drizzle-kit is already an optional
// peer, and it is reached through a dynamic `import` so that merely importing
// this entry does not pull it in.

import type { ConformanceStore, ConformanceStoreFactory } from "@nestm/permissions-core/testing";
import { sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";

import {
	createPermissionsSchema,
	type CreatePermissionsSchemaOptions,
	type PermissionsSchema,
} from "./schema.ts";
import {
	DrizzlePolicyStore,
	type DrizzlePolicyStoreOptions,
} from "./store/drizzle-policy-store.ts";

/** Entry identity. Exported so the built entry has real runtime output. */
export const TESTING_ENTRY_NAME = "@nestm/permissions-drizzle/testing" as const;

// ---------------------------------------------------------------------------
// Core's suite, re-exported
// ---------------------------------------------------------------------------

export {
	CONFORMANCE_SCOPES,
	FIXTURE_TIME,
	FORBID_ALL,
	PERMIT_ALL,
	TEMPLATE_BOTH_SLOTS,
	TEMPLATE_PRINCIPAL_ONLY,
	TEMPLATE_RESOURCE_ONLY,
	evaluatePlanNode,
	filterRowsByPlan,
	matchLikeTokens,
	policyRecordFixture,
	runPolicyStoreConformanceSuite,
	slotValues,
	templateLinkFixture,
	testVocabulary,
	type ConformanceStore,
	type ConformanceStoreFactory,
	type HierarchyQuery,
	type HierarchyResolver,
	type PlanRow,
} from "@nestm/permissions-core/testing";

// ---------------------------------------------------------------------------
// The factory
// ---------------------------------------------------------------------------

/** Options for {@link drizzleStoreFactory}. */
export interface DrizzleStoreFactoryOptions {
	/**
	 * Schema options. `tablePrefix` defaults to a **unique** prefix per created
	 * store, so parallel suites (vitest runs files in separate workers against one
	 * database) cannot drop each other's tables.
	 */
	readonly schema?: CreatePermissionsSchemaOptions<never>;
	/** Store options — poll interval, notify, error sink. */
	readonly store?: DrizzlePolicyStoreOptions;
	/** Extra statements run after the tables exist: `GRANT`, `CREATE POLICY`, seed rows. */
	readonly afterCreate?: readonly string[];
	/** Extra statements run before the tables are created: `CREATE ROLE`, referenced tables. */
	readonly beforeCreate?: readonly string[];
	/** Overrides what the conformance suite is told about global-scope support. */
	readonly supportsGlobalScope?: boolean;
	/** Overrides what the conformance suite is told about `watch`. */
	readonly supportsWatch?: boolean;
	/** Receives the provisioned handle before each test's body runs. */
	readonly onProvision?: (handle: ProvisionedSchema) => void | Promise<void>;
}

/** Everything {@link provisionPermissionsSchema} built. */
export interface ProvisionedSchema {
	readonly db: NodePgDatabase<Record<string, unknown>>;
	readonly schema: PermissionsSchema;
	/** Table names actually created, in creation order. */
	readonly tableNames: readonly string[];
	/** The DDL that created them, for a fixture that wants to inspect or extend it. */
	readonly statements: readonly string[];
	/** Drops the tables and closes the connection. */
	drop(): Promise<void>;
}

let uniqueCounter = 0;

/**
 * Creates the tables in `pgUrl` and returns everything needed to talk to them.
 *
 * Each call gets its own connection **and** its own table prefix, so concurrent
 * callers are independent. `drop()` removes the tables and ends the pool; a
 * caller that forgets it leaks both.
 */
export async function provisionPermissionsSchema(
	pgUrl: string,
	options: DrizzleStoreFactoryOptions = {},
): Promise<ProvisionedSchema> {
	uniqueCounter += 1;
	const prefix =
		options.schema?.tablePrefix ??
		`perm_t${String(process.pid % 100_000)}_${String(uniqueCounter)}_`;

	const schemaOptions = {
		...options.schema,
		tablePrefix: prefix,
	} as CreatePermissionsSchemaOptions;
	const schema = createPermissionsSchema(schemaOptions);

	const statements = await generateSchemaDdl(schema);
	const db = drizzle(pgUrl) as NodePgDatabase<Record<string, unknown>> & {
		$client: { end(): Promise<void> };
	};

	for (const statement of options.beforeCreate ?? []) {
		await db.execute(sql.raw(statement));
	}
	for (const statement of statements) {
		await db.execute(sql.raw(statement));
	}
	for (const statement of options.afterCreate ?? []) {
		await db.execute(sql.raw(statement));
	}

	const tableNames = [`${prefix}policies`, `${prefix}policy_links`, `${prefix}scope_versions`];

	return {
		db,
		schema,
		tableNames,
		statements,
		async drop(): Promise<void> {
			try {
				// One statement, CASCADE, IF EXISTS: teardown runs after a failed test
				// too, and a teardown that can itself fail turns one red test into a
				// cascade of unrelated ones.
				await db.execute(
					sql.raw(
						`drop table if exists ${tableNames.map((name) => `"${name}"`).join(", ")} cascade`,
					),
				);
			} finally {
				await db.$client.end();
			}
		},
	};
}

/**
 * A {@link ConformanceStoreFactory} backed by a real Postgres.
 *
 * ```ts
 * runPolicyStoreConformanceSuite(
 *   "DrizzlePolicyStore",
 *   drizzleStoreFactory(process.env.PG_URL ?? DEFAULT_PG_URL),
 * );
 * ```
 *
 * Every test gets fresh tables and drops them afterwards — the suite creates one
 * store per case by design, and sharing tables between them would let a leaked
 * row from one case decide another.
 */
export function drizzleStoreFactory(
	pgUrl: string,
	options: DrizzleStoreFactoryOptions = {},
): ConformanceStoreFactory {
	return async (): Promise<ConformanceStore> => {
		const provisioned = await provisionPermissionsSchema(pgUrl, options);
		await options.onProvision?.(provisioned);

		const store = new DrizzlePolicyStore(provisioned.db, provisioned.schema, {
			// The conformance suite asserts synchronous post-commit emission, which the
			// store does without any poller. Leaving the poller on would add a timer to
			// every one of the suite's ~20 stores for no assertion's benefit.
			poll: false,
			...options.store,
		});

		const supportsGlobalScope =
			options.supportsGlobalScope ?? options.schema?.scopeColumn?.supportsGlobalScope ?? true;

		return {
			store,
			supportsGlobalScope,
			supportsWatch: options.supportsWatch ?? true,
			async teardown(): Promise<void> {
				await store.dispose();
				await provisioned.drop();
			},
		};
	};
}

/** Default connection string, matching the repo's `compose.yaml`. */
export const DEFAULT_PG_URL = "postgres://nestm:nestm@localhost:55433/nestm_permissions";

/** `PG_URL`, or the compose default. */
export function pgUrlFromEnvironment(): string {
	return process.env["PG_URL"] ?? DEFAULT_PG_URL;
}

// ---------------------------------------------------------------------------
// DDL
// ---------------------------------------------------------------------------

/**
 * The `CREATE TABLE`/`CREATE INDEX` statements for a schema, from drizzle-kit.
 *
 * Note the shape of the call: the tables are spread into a **flat** object.
 * That is the same requirement consumers have — `prepareFromExports` keeps only
 * the top-level values that pass `is(value, PgTable)` — and doing it wrong here
 * would produce an empty statement list and a suite that ran against no tables at
 * all. `tests/integration/drizzle-kit-roundtrip.test.ts` pins both halves.
 */
export async function generateSchemaDdl(schema: PermissionsSchema): Promise<readonly string[]> {
	const { generateDrizzleJson, generateMigration } = await import("drizzle-kit/api");

	const empty = await generateDrizzleJson({});
	const target = await generateDrizzleJson({ ...schema });

	return generateMigration(empty, target);
}
