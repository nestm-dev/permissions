import type { PolicyRecord } from "@nestm/permissions-core";
import type { DataSource, EntityManager } from "typeorm";
import type { IsolationLevel } from "typeorm/driver/types/IsolationLevel.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
	TypeOrmPolicyStore,
	TypeOrmPolicyStoreIsolationLevel,
	type TypeOrmPolicyStoreExecution,
	type TypeOrmPolicyStoreExecutor,
} from "../../src/store/typeorm-policy-store.ts";
import { provisionPermissionsSchema, type ProvisionedSchema } from "../../src/testing.ts";
import { PG_SKIPPED, PG_URL, assertPostgresReachable } from "../fixtures/pg.ts";

const FIXTURE_TIME = new Date("2026-08-21T00:00:00.000Z");

const TYPEORM_ISOLATION: Readonly<
	Record<TypeOrmPolicyStoreExecution["isolationLevel"], IsolationLevel>
> = {
	[TypeOrmPolicyStoreIsolationLevel.READ_UNCOMMITTED]: "READ UNCOMMITTED",
	[TypeOrmPolicyStoreIsolationLevel.READ_COMMITTED]: "READ COMMITTED",
	[TypeOrmPolicyStoreIsolationLevel.REPEATABLE_READ]: "REPEATABLE READ",
	[TypeOrmPolicyStoreIsolationLevel.SERIALIZABLE]: "SERIALIZABLE",
};

function policy(id: string, scope: string): PolicyRecord {
	return {
		id,
		scope,
		kind: "static",
		cedarJson: {
			effect: "permit",
			principal: { op: "All" },
			action: { op: "All" },
			resource: { op: "All" },
			conditions: [],
		},
		enabled: true,
		updatedAt: FIXTURE_TIME,
	};
}

async function runTransaction<Result>(
	dataSource: DataSource,
	execution: TypeOrmPolicyStoreExecution,
	work: (manager: EntityManager) => Result | Promise<Result>,
): Promise<Result> {
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
}

class RecordingExecutor implements TypeOrmPolicyStoreExecutor {
	readonly calls: TypeOrmPolicyStoreExecution[] = [];

	constructor(private readonly dataSource: DataSource) {}

	async run<Result>(
		execution: TypeOrmPolicyStoreExecution,
		work: (manager: EntityManager) => Result | Promise<Result>,
	): Promise<Result> {
		this.calls.push({ ...execution, scopes: [...execution.scopes] });
		return runTransaction(this.dataSource, execution, work);
	}
}

interface VoidDeferred {
	readonly promise: Promise<void>;
	resolve(): void;
}

function voidDeferred(): VoidDeferred {
	let resolvePromise: (() => void) | undefined;
	const promise = new Promise<void>((resolve) => {
		resolvePromise = resolve;
	});
	return {
		promise,
		resolve(): void {
			resolvePromise?.();
		},
	};
}

class GatedWriteExecutor implements TypeOrmPolicyStoreExecutor {
	readonly workCompleted = voidDeferred();
	readonly release = voidDeferred();
	seenExecution: TypeOrmPolicyStoreExecution | undefined;

	constructor(
		private readonly dataSource: DataSource,
		private readonly rollback: boolean,
	) {}

	async run<Result>(
		execution: TypeOrmPolicyStoreExecution,
		work: (manager: EntityManager) => Result | Promise<Result>,
	): Promise<Result> {
		this.seenExecution = execution;
		return runTransaction(this.dataSource, execution, async (manager) => {
			const result = await work(manager);
			this.workCompleted.resolve();
			await this.release.promise;
			if (this.rollback) {
				throw new Error("forced rollback after policy work");
			}
			return result;
		});
	}
}

describe.skipIf(PG_SKIPPED)("TypeOrmPolicyStore executor", () => {
	let provisioned: ProvisionedSchema;

	beforeAll(async () => {
		await assertPostgresReachable();
		provisioned = await provisionPermissionsSchema(PG_URL);
	});

	afterAll(async () => {
		await provisioned?.drop();
	});

	it("routes foreground operations with access, snapshot, commit, and exact effective scopes", async () => {
		const executor = new RecordingExecutor(provisioned.dataSource);
		const store = new TypeOrmPolicyStore(provisioned.dataSource, {
			entities: provisioned.entities,
			executor,
			poll: false,
		});

		try {
			await store.load("snapshot-scope");
			await store.currentVersion("snapshot-scope");
			await store.save([
				policy("snapshot-policy", "snapshot-scope"),
				policy("other-policy", "z-scope"),
			]);
			await store.linkTemplate({
				id: "snapshot-link",
				scope: "snapshot-scope",
				templateId: "snapshot-policy",
				values: {},
				updatedAt: FIXTURE_TIME,
			});
			await store.unlinkTemplate("snapshot-scope", "snapshot-link");
			await store.delete("snapshot-scope", ["snapshot-policy"]);

			expect(executor.calls).toEqual([
				{
					operation: "load",
					access: "read-only",
					isolationLevel: "repeatable read",
					commitOwnership: "not-required",
					scopes: ["", "snapshot-scope"],
				},
				{
					operation: "currentVersion",
					access: "read-only",
					isolationLevel: "read committed",
					commitOwnership: "not-required",
					scopes: ["", "snapshot-scope"],
				},
				{
					operation: "save",
					access: "read-write",
					isolationLevel: "read committed",
					commitOwnership: "required",
					scopes: ["snapshot-scope", "z-scope"],
				},
				{
					operation: "linkTemplate",
					access: "read-write",
					isolationLevel: "read committed",
					commitOwnership: "required",
					scopes: ["snapshot-scope"],
				},
				{
					operation: "unlinkTemplate",
					access: "read-write",
					isolationLevel: "read committed",
					commitOwnership: "required",
					scopes: ["snapshot-scope"],
				},
				{
					operation: "delete",
					access: "read-write",
					isolationLevel: "read committed",
					commitOwnership: "required",
					scopes: ["snapshot-scope"],
				},
			]);
		} finally {
			await store.dispose();
		}
	});

	it("publishes the local watch event only after the executor commits", async () => {
		const executor = new GatedWriteExecutor(provisioned.dataSource, false);
		const store = new TypeOrmPolicyStore(provisioned.dataSource, {
			entities: provisioned.entities,
			executor,
			poll: false,
		});
		const seen: string[] = [];
		store.watch((event) => void seen.push(`${event.reason}:${event.scope}`));

		try {
			const saving = store.save([policy("committed-policy", "commit-scope")]);
			await executor.workCompleted.promise;

			expect(executor.seenExecution).toEqual({
				operation: "save",
				access: "read-write",
				isolationLevel: "read committed",
				commitOwnership: "required",
				scopes: ["commit-scope"],
			});
			expect(seen).toEqual([]);

			executor.release.resolve();
			await saving;
			expect(seen).toEqual(["save:commit-scope"]);
		} finally {
			executor.release.resolve();
			await store.dispose();
		}
	});

	it("publishes no local event when the executor rolls the write back", async () => {
		const executor = new GatedWriteExecutor(provisioned.dataSource, true);
		const store = new TypeOrmPolicyStore(provisioned.dataSource, {
			entities: provisioned.entities,
			executor,
			poll: false,
		});
		const seen: string[] = [];
		store.watch((event) => void seen.push(event.scope));

		try {
			const saving = store.save([policy("rolled-back-policy", "rollback-scope")]);
			await executor.workCompleted.promise;
			executor.release.resolve();

			await expect(saving).rejects.toThrowError(/forced rollback/);
			expect(seen).toEqual([]);

			const verifier = new TypeOrmPolicyStore(provisioned.dataSource, {
				entities: provisioned.entities,
				poll: false,
			});
			try {
				const bundle = await verifier.load("rollback-scope");
				expect(bundle.policies.map((record) => record.id)).not.toContain("rolled-back-policy");
			} finally {
				await verifier.dispose();
			}
		} finally {
			executor.release.resolve();
			await store.dispose();
		}
	});
});
