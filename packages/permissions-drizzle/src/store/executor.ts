import type { PolicyScopeId } from "@nestm/permissions-core";
import { PermissionsError } from "@nestm/permissions-core";
import type { PgDatabase, PgQueryResultHKT, PgTransactionConfig } from "drizzle-orm/pg-core";

/** A portable Drizzle Postgres database or transaction handle. */
export type DrizzlePolicyStoreDatabase = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

/** Every foreground operation a {@link DrizzlePolicyStoreExecutor} can run. */
export type DrizzlePolicyStoreOperation =
	"load" | "currentVersion" | "save" | "delete" | "linkTemplate" | "unlinkTemplate";

/** Whether the operation only reads policy state or may mutate it. */
export type DrizzlePolicyStoreAccess = "read-only" | "read-write";

/** PostgreSQL snapshot level the executor must provide for an operation. */
export type DrizzlePolicyStoreIsolationLevel = NonNullable<PgTransactionConfig["isolationLevel"]>;

/** Whether `run()` must own the commit that makes the operation durable. */
export type DrizzlePolicyStoreCommitOwnership = "required" | "not-required";

/**
 * Complete foreground-operation context handed to an executor.
 *
 * `scopes` is the exact database scope set the operation may touch. For a
 * global-capable schema, `load("tenant")` and `currentVersion("tenant")` name
 * both `""` and `"tenant"`; a tenant-only schema names only the tenant. A
 * request-aware executor can therefore reject a global or mismatched scope
 * before any SQL runs instead of relying on an empty RLS result.
 */
export interface DrizzlePolicyStoreExecution {
	readonly operation: DrizzlePolicyStoreOperation;
	readonly access: DrizzlePolicyStoreAccess;
	/** Isolation level the transaction must provide. */
	readonly isolationLevel: DrizzlePolicyStoreIsolationLevel;
	/**
	 * `required` means `run()` must resolve only after the real database commit;
	 * an ambient savepoint is not sufficient because the store emits immediately
	 * after `run()` resolves.
	 */
	readonly commitOwnership: DrizzlePolicyStoreCommitOwnership;
	readonly scopes: readonly PolicyScopeId[];
}

/**
 * Runs foreground policy-store work on one pinned Drizzle transaction.
 *
 * A tenant/RLS integration derives the request tenant, validates every
 * `execution.scopes` entry, opens and pins the transaction, sets its
 * transaction-local database context, and then calls `work` with that handle.
 *
 * Contract:
 * - honor `execution.access` and `execution.isolationLevel` on the pinned transaction;
 * - when commit ownership is required, never substitute an ambient savepoint; and
 * - in that case, resolve only after commit so synchronous watch events are post-commit.
 */
export interface DrizzlePolicyStoreExecutor {
	run<Result>(
		execution: DrizzlePolicyStoreExecution,
		work: (database: DrizzlePolicyStoreDatabase) => Result | Promise<Result>,
	): Promise<Result>;
}

/** Default executor used when the store receives a root database and no custom executor. */
export function defaultDrizzlePolicyStoreExecutor(
	database: DrizzlePolicyStoreDatabase,
): DrizzlePolicyStoreExecutor {
	if (isAmbientTransaction(database)) {
		throw new PermissionsError(
			"POLICY_STORE",
			"DrizzlePolicyStore received an ambient Drizzle transaction without an explicit executor. " +
				"The default executor would create only a savepoint, so it could not guarantee the requested " +
				"snapshot or report writes as committed. Pass a root database handle or provide a " +
				"DrizzlePolicyStoreExecutor that validates the ambient transaction requirements.",
		);
	}

	return {
		run: async <Result>(
			execution: DrizzlePolicyStoreExecution,
			work: (database: DrizzlePolicyStoreDatabase) => Result | Promise<Result>,
		): Promise<Result> =>
			database.transaction(async (tx) => work(tx), transactionConfig(execution)),
	};
}

function transactionConfig(execution: DrizzlePolicyStoreExecution): PgTransactionConfig {
	return {
		accessMode: execution.access === "read-only" ? "read only" : "read write",
		isolationLevel: execution.isolationLevel,
	};
}

/**
 * Cross-copy structural detection for Drizzle's `PgTransaction` subclasses.
 * A root `PgDatabase` has neither method; every transaction implementation has
 * both even when a bundler duplicates Drizzle and makes `instanceof` unusable.
 */
function isAmbientTransaction(database: DrizzlePolicyStoreDatabase): boolean {
	const candidate = database as unknown as {
		readonly rollback?: unknown;
		readonly setTransaction?: unknown;
	};
	return typeof candidate.rollback === "function" && typeof candidate.setTransaction === "function";
}
