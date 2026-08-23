import type { PolicyScopeId } from "@nestm/permissions-core";
import type { DataSource, EntityManager } from "typeorm";

/** Every foreground operation a {@link TypeOrmPolicyStoreExecutor} can run. */
export type TypeOrmPolicyStoreOperation =
	"load" | "currentVersion" | "save" | "delete" | "linkTemplate" | "unlinkTemplate";

/** Whether the operation only reads policy state or may mutate it. */
export type TypeOrmPolicyStoreAccess = "read-only" | "read-write";

/** PostgreSQL snapshot level the executor must provide for an operation. */
export enum TypeOrmPolicyStoreIsolationLevel {
	READ_UNCOMMITTED = "read uncommitted",
	READ_COMMITTED = "read committed",
	REPEATABLE_READ = "repeatable read",
	SERIALIZABLE = "serializable",
}

/** Whether `run()` must own the commit that makes the operation durable. */
export type TypeOrmPolicyStoreCommitOwnership = "required" | "not-required";

/**
 * Complete foreground-operation context handed to an executor.
 *
 * `scopes` is the exact database scope set the operation may touch. For a
 * global-capable schema, `load("tenant")` and `currentVersion("tenant")` name
 * both `""` and `"tenant"`; a tenant-only schema names only the tenant. A
 * request-aware executor can therefore reject a global or mismatched scope
 * before any SQL runs instead of relying on an empty RLS result.
 */
export interface TypeOrmPolicyStoreExecution {
	readonly operation: TypeOrmPolicyStoreOperation;
	readonly access: TypeOrmPolicyStoreAccess;
	/** Isolation level the transaction must provide. */
	readonly isolationLevel: TypeOrmPolicyStoreIsolationLevel;
	/**
	 * `required` means `run()` must resolve only after the real database commit;
	 * an ambient savepoint is not sufficient because the store emits immediately
	 * after `run()` resolves.
	 */
	readonly commitOwnership: TypeOrmPolicyStoreCommitOwnership;
	readonly scopes: readonly PolicyScopeId[];
}

/**
 * Runs foreground policy-store work on one pinned TypeORM `EntityManager`.
 *
 * A tenant/RLS integration derives the request tenant, validates every
 * `execution.scopes` entry, opens and pins the transaction, sets its
 * transaction-local database context, and then calls `work` with that manager.
 *
 * Contract:
 * - honor `execution.access` and `execution.isolationLevel` on the pinned transaction;
 * - when commit ownership is required, never substitute an ambient savepoint; and
 * - in that case, resolve only after commit so synchronous watch events are post-commit.
 */
export interface TypeOrmPolicyStoreExecutor {
	run<Result>(
		execution: TypeOrmPolicyStoreExecution,
		work: (manager: EntityManager) => Result | Promise<Result>,
	): Promise<Result>;
}

const TYPEORM_ISOLATION: Readonly<
	Record<
		TypeOrmPolicyStoreIsolationLevel,
		"READ UNCOMMITTED" | "READ COMMITTED" | "REPEATABLE READ" | "SERIALIZABLE"
	>
> = {
	[TypeOrmPolicyStoreIsolationLevel.READ_UNCOMMITTED]: "READ UNCOMMITTED",
	[TypeOrmPolicyStoreIsolationLevel.READ_COMMITTED]: "READ COMMITTED",
	[TypeOrmPolicyStoreIsolationLevel.REPEATABLE_READ]: "REPEATABLE READ",
	[TypeOrmPolicyStoreIsolationLevel.SERIALIZABLE]: "SERIALIZABLE",
};

/**
 * Default executor used when the store receives a root `DataSource` and no
 * custom executor.
 *
 * A `QueryRunner` is required rather than `DataSource.transaction(...)` because
 * TypeORM's transaction helper cannot express `READ ONLY`. PostgreSQL accepts
 * `SET TRANSACTION READ ONLY` only after the transaction begins and before its
 * first data statement.
 */
export function defaultTypeOrmPolicyStoreExecutor(
	dataSource: DataSource,
): TypeOrmPolicyStoreExecutor {
	return {
		run: async <Result>(
			execution: TypeOrmPolicyStoreExecution,
			work: (manager: EntityManager) => Result | Promise<Result>,
		): Promise<Result> => {
			const runner = dataSource.createQueryRunner();
			await runner.connect();
			await runner.startTransaction(TYPEORM_ISOLATION[execution.isolationLevel]);
			try {
				if (execution.access === "read-only") {
					await runner.query("SET TRANSACTION READ ONLY");
				}
				const result = await work(runner.manager);
				await runner.commitTransaction();
				return result;
			} catch (error) {
				if (runner.isTransactionActive) {
					await runner.rollbackTransaction();
				}
				throw error;
			} finally {
				await runner.release();
			}
		},
	};
}
