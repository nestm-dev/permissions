import type { PolicyRecord } from "@nestm/permissions-core";
import type { PgTransactionConfig } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
	DrizzlePolicyStore,
	type DrizzlePolicyStoreDatabase,
	type DrizzlePolicyStoreExecution,
	type DrizzlePolicyStoreExecutor,
} from "../../src/store/drizzle-policy-store.ts";
import { provisionPermissionsSchema, type ProvisionedSchema } from "../../src/testing.ts";
import { PG_SKIPPED, PG_URL, assertPostgresReachable, uniqueSuffix } from "../fixtures/pg.ts";

const PREFIX = `${uniqueSuffix("executor")}_`;
const FIXTURE_TIME = new Date("2026-08-02T00:00:00.000Z");

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

function pgConfig(execution: DrizzlePolicyStoreExecution): PgTransactionConfig {
	return {
		accessMode: execution.access === "read-only" ? "read only" : "read write",
		isolationLevel: execution.isolationLevel,
	};
}

class RecordingExecutor implements DrizzlePolicyStoreExecutor {
	readonly calls: DrizzlePolicyStoreExecution[] = [];

	constructor(private readonly database: DrizzlePolicyStoreDatabase) {}

	async run<Result>(
		execution: DrizzlePolicyStoreExecution,
		work: (database: DrizzlePolicyStoreDatabase) => Result | Promise<Result>,
	): Promise<Result> {
		this.calls.push({ ...execution, scopes: [...execution.scopes] });
		return this.database.transaction(async (tx) => work(tx), pgConfig(execution));
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

class GatedWriteExecutor implements DrizzlePolicyStoreExecutor {
	readonly workCompleted = voidDeferred();
	readonly release = voidDeferred();
	seenExecution: DrizzlePolicyStoreExecution | undefined;

	constructor(
		private readonly database: DrizzlePolicyStoreDatabase,
		private readonly rollback: boolean,
	) {}

	async run<Result>(
		execution: DrizzlePolicyStoreExecution,
		work: (database: DrizzlePolicyStoreDatabase) => Result | Promise<Result>,
	): Promise<Result> {
		this.seenExecution = execution;
		return this.database.transaction(async (tx) => {
			const result = await work(tx);
			this.workCompleted.resolve();
			await this.release.promise;
			if (this.rollback) {
				throw new Error("forced rollback after policy work");
			}
			return result;
		}, pgConfig(execution));
	}
}

describe.skipIf(PG_SKIPPED)("DrizzlePolicyStore executor", () => {
	let provisioned: ProvisionedSchema;

	beforeAll(async () => {
		await assertPostgresReachable();
		provisioned = await provisionPermissionsSchema(PG_URL, {
			schema: { tablePrefix: PREFIX },
		});
	});

	afterAll(async () => {
		await provisioned?.drop();
	});

	it("routes foreground operations with operation, access, and exact effective scopes", async () => {
		const executor = new RecordingExecutor(provisioned.db);
		const store = new DrizzlePolicyStore(provisioned.db, provisioned.schema, {
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
		const executor = new GatedWriteExecutor(provisioned.db, false);
		const store = new DrizzlePolicyStore(provisioned.db, provisioned.schema, {
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

	it("rejects the default executor on an ambient Drizzle transaction", async () => {
		await provisioned.db.transaction(async (tx) => {
			let failure: unknown;
			try {
				new DrizzlePolicyStore(tx, provisioned.schema, { poll: false });
			} catch (error) {
				failure = error;
			}
			expect(failure).toMatchObject({
				code: "POLICY_STORE",
				message: expect.stringContaining("ambient Drizzle transaction") as unknown,
			});
		});
	});

	it("publishes no local event when the executor rolls the write back", async () => {
		const executor = new GatedWriteExecutor(provisioned.db, true);
		const store = new DrizzlePolicyStore(provisioned.db, provisioned.schema, {
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

			const verifier = new DrizzlePolicyStore(provisioned.db, provisioned.schema, { poll: false });
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
