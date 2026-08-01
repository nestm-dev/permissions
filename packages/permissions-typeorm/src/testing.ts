// `@nestm/permissions-typeorm/testing` — the harness for running core's shared
// `PolicyStore` conformance suite against a real Postgres.
//
// The suite itself lives in core, because "conformant" has to mean one thing
// across `MemoryPolicyStore`, this driver and the Drizzle one. What a driver has
// to supply is the boring half: a fresh, empty store per test, and a teardown
// that leaves nothing behind. That is all this file is.
//
// Provisioning goes through **`buildPermissionsMigration`** rather than
// hand-written DDL. A hand-written `CREATE TABLE` in a test fixture is a second
// source of truth for the schema, and the failure mode is a suite that passes
// against tables no consumer will ever have. Running the shipped migration means
// every conformance assertion is also an assertion about the migration.

import type { ConformanceStore, ConformanceStoreFactory } from "@nestm/permissions-core/testing";
import { DataSource } from "typeorm";

import {
	createPermissionsEntities,
	type CreatePermissionsEntitiesOptions,
	type PermissionsEntities,
} from "./entities/create-entities.ts";
import { buildPermissionsMigration } from "./entities/migration.ts";
import {
	TypeOrmPolicyStore,
	type TypeOrmPolicyStoreOptions,
} from "./store/typeorm-policy-store.ts";

/** Entry identity. Exported so the built entry has real runtime output. */
export const TESTING_ENTRY_NAME = "@nestm/permissions-typeorm/testing" as const;

// ---------------------------------------------------------------------------
// Core's suite and oracles, re-exported
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

/** Options for {@link typeormStoreFactory} and {@link provisionPermissionsSchema}. */
export interface TypeOrmStoreFactoryOptions {
	/**
	 * Entity options. `tablePrefix` defaults to a **unique** prefix per created
	 * store and `schemaName` to a unique Postgres schema per process, so parallel
	 * suites (vitest runs files in separate workers against one database) cannot
	 * drop each other's tables — nor can another driver's suite sharing the server.
	 */
	readonly entities?: CreatePermissionsEntitiesOptions<never>;
	/** Store options — poll interval, notify, error sink. */
	readonly store?: TypeOrmPolicyStoreOptions;
	/** Extra statements run before the tables are created: `CREATE ROLE`, referenced tables. */
	readonly beforeCreate?: readonly string[];
	/** Extra statements run after the tables exist: `GRANT`, `CREATE POLICY`, seed rows. */
	readonly afterCreate?: readonly string[];
	/** Overrides what the conformance suite is told about global-scope support. */
	readonly supportsGlobalScope?: boolean;
	/** Overrides what the conformance suite is told about `watch`. */
	readonly supportsWatch?: boolean;
	/** Receives the provisioned handle before each test's body runs. */
	readonly onProvision?: (handle: ProvisionedSchema) => void | Promise<void>;
}

/** Everything {@link provisionPermissionsSchema} built. */
export interface ProvisionedSchema {
	/** An initialised `DataSource` owning the three entities. */
	readonly dataSource: DataSource;
	/** The entity schemas, with the unique prefix and schema baked in. */
	readonly entities: PermissionsEntities;
	/** Postgres schema the tables live in. */
	readonly schemaName: string;
	/** Table names actually created, unqualified, in creation order. */
	readonly tableNames: readonly string[];
	/** The DDL that created them, for a fixture that wants to inspect or extend it. */
	readonly statements: readonly string[];
	/** Drops the tables and closes the connection. */
	drop(): Promise<void>;
}

let uniqueCounter = 0;

/** A unique-per-process Postgres schema name. Collides with nothing, including other drivers. */
export function uniqueSchemaName(label = "nestm_to"): string {
	return `${label}_${String(process.pid % 1_000_000)}_${Math.floor(Math.random() * 1e9).toString(36)}`;
}

const processSchema = uniqueSchemaName();

/**
 * Creates the tables in `pgUrl` and returns everything needed to talk to them.
 *
 * Each call gets its own `DataSource` **and** its own table prefix, inside a
 * per-process Postgres **schema**, so concurrent callers — including another
 * driver's suite running against the same database — are independent. `drop()`
 * removes the tables and destroys the `DataSource`; a caller that forgets it leaks
 * both.
 */
export async function provisionPermissionsSchema(
	pgUrl: string,
	options: TypeOrmStoreFactoryOptions = {},
): Promise<ProvisionedSchema> {
	uniqueCounter += 1;
	const tablePrefix = options.entities?.tablePrefix ?? `perm_t${String(uniqueCounter)}_`;
	const schemaName = options.entities?.schemaName ?? processSchema;

	const entityOptions = {
		...options.entities,
		tablePrefix,
		schemaName,
	} as CreatePermissionsEntitiesOptions;
	const entities = createPermissionsEntities(entityOptions);

	const { up } = buildPermissionsMigration({ ...entityOptions, dialect: "postgres" });

	const dataSource = new DataSource({
		type: "postgres",
		url: pgUrl,
		entities: [entities.policy, entities.link, entities.scopeVersion],
		synchronize: false,
		logging: false,
		// A conformance run creates ~25 stores in sequence; a large pool per store
		// would exhaust Postgres's connection limit long before the suite finished.
		extra: { max: 4 },
	});

	await dataSource.initialize();

	try {
		await dataSource.query(`create schema if not exists "${schemaName}"`);
		for (const statement of options.beforeCreate ?? []) {
			await dataSource.query(statement);
		}
		for (const statement of up) {
			await dataSource.query(statement);
		}
		for (const statement of options.afterCreate ?? []) {
			await dataSource.query(statement);
		}
	} catch (error) {
		await dataSource.destroy();
		throw error;
	}

	const tableNames = [
		`${tablePrefix}policies`,
		`${tablePrefix}policy_links`,
		`${tablePrefix}scope_versions`,
	];

	return {
		dataSource,
		entities,
		schemaName,
		tableNames,
		statements: up,
		async drop(): Promise<void> {
			try {
				// One statement, CASCADE, IF EXISTS: teardown runs after a failed test
				// too, and a teardown that can itself fail turns one red test into a
				// cascade of unrelated ones.
				await dataSource.query(
					`drop table if exists ${tableNames
						.map((name) => `"${schemaName}"."${name}"`)
						.join(", ")} cascade`,
				);
			} finally {
				await dataSource.destroy();
			}
		},
	};
}

/**
 * A {@link ConformanceStoreFactory} backed by a real Postgres.
 *
 * ```ts
 * runPolicyStoreConformanceSuite(
 *   "TypeOrmPolicyStore",
 *   typeormStoreFactory(process.env.PG_URL ?? DEFAULT_PG_URL),
 * );
 * ```
 *
 * Every test gets fresh tables and drops them afterwards — the suite creates one
 * store per case by design, and sharing tables between them would let a leaked
 * row from one case decide another.
 */
export function typeormStoreFactory(
	pgUrl: string,
	options: TypeOrmStoreFactoryOptions = {},
): ConformanceStoreFactory {
	return async (): Promise<ConformanceStore> => {
		const provisioned = await provisionPermissionsSchema(pgUrl, options);
		await options.onProvision?.(provisioned);

		const store = new TypeOrmPolicyStore(provisioned.dataSource, {
			entities: provisioned.entities,
			// The conformance suite asserts synchronous post-commit emission, which the
			// store does without any poller. Leaving the poller on would add a timer to
			// every one of the suite's ~25 stores for no assertion's benefit.
			poll: false,
			...options.store,
		});

		const supportsGlobalScope =
			options.supportsGlobalScope ?? options.entities?.scopeColumn?.supportsGlobalScope ?? true;

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
