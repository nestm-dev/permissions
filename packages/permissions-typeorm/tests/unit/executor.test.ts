import type { DataSource, EntityManager, QueryRunner } from "typeorm";
import { describe, expect, it, vi } from "vitest";

import {
	defaultTypeOrmPolicyStoreExecutor,
	TypeOrmPolicyStoreAccess,
	TypeOrmPolicyStoreIsolationLevel,
	type TypeOrmPolicyStoreExecution,
} from "../../src/store/executor.ts";

function execution(
	overrides: Partial<TypeOrmPolicyStoreExecution> = {},
): TypeOrmPolicyStoreExecution {
	return {
		operation: "load",
		access: TypeOrmPolicyStoreAccess.READ_ONLY,
		isolationLevel: TypeOrmPolicyStoreIsolationLevel.REPEATABLE_READ,
		commitOwnership: "not-required",
		scopes: ["tenant-a"],
		...overrides,
	};
}

function fixture(): {
	readonly dataSource: DataSource;
	readonly manager: EntityManager;
	readonly runner: QueryRunner;
	readonly calls: string[];
} {
	const calls: string[] = [];
	const manager = {} as EntityManager;
	const runner = {
		manager,
		isTransactionActive: false,
		connect: vi.fn(async () => void calls.push("connect")),
		startTransaction: vi.fn(async (level: string) => {
			calls.push(`start:${level}`);
			runner.isTransactionActive = true;
		}),
		query: vi.fn(async (sql: string) => void calls.push(`query:${sql}`)),
		commitTransaction: vi.fn(async () => {
			calls.push("commit");
			runner.isTransactionActive = false;
		}),
		rollbackTransaction: vi.fn(async () => {
			calls.push("rollback");
			runner.isTransactionActive = false;
		}),
		release: vi.fn(async () => void calls.push("release")),
	} as unknown as QueryRunner & { isTransactionActive: boolean };
	const dataSource = { createQueryRunner: () => runner } as unknown as DataSource;
	return { dataSource, manager, runner, calls };
}

describe("defaultTypeOrmPolicyStoreExecutor", () => {
	it("pins a read-only repeatable-read transaction and resolves after commit", async () => {
		const { dataSource, manager, calls } = fixture();
		const executor = defaultTypeOrmPolicyStoreExecutor(dataSource);

		await expect(
			executor.run(execution(), (active) => {
				expect(active).toBe(manager);
				calls.push("work");
				return "done";
			}),
		).resolves.toBe("done");

		expect(calls).toEqual([
			"connect",
			"start:REPEATABLE READ",
			"query:SET TRANSACTION READ ONLY",
			"work",
			"commit",
			"release",
		]);
	});

	it("rolls a failed write back and always releases the runner", async () => {
		const { dataSource, calls } = fixture();
		const executor = defaultTypeOrmPolicyStoreExecutor(dataSource);

		await expect(
			executor.run(
				execution({
					operation: "save",
					access: TypeOrmPolicyStoreAccess.READ_WRITE,
					isolationLevel: TypeOrmPolicyStoreIsolationLevel.READ_COMMITTED,
					commitOwnership: "required",
				}),
				() => {
					calls.push("work");
					throw new Error("write failed");
				},
			),
		).rejects.toThrow("write failed");

		expect(calls).toEqual(["connect", "start:READ COMMITTED", "work", "rollback", "release"]);
	});
});
