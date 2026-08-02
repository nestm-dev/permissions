// Invalidation: the poller, the synchronous local emit, and LISTEN/NOTIFY.
//
// `watch()` is a **promise that every write becomes an event** (D1). The engine
// stops calling `currentVersion` on the check path the moment a store implements
// it, so a missed event is not a slow cache — it is a cache that serves the
// pre-change policy set until something unrelated happens to write. That makes
// the interesting assertions the negative ones:
//
//   * a tick that fails must not advance the observed version snapshot, so the change it did not
//     see is still delivered afterwards;
//   * a tick that fails must not clear anything — stale-but-known beats empty,
//     because an empty policy set is `deny` for the whole tenant;
//   * nothing here may reject, ever. An unhandled rejection in a background
//     timer takes the process down, which is a far worse failure than a late
//     cache.
//
// The `PolicyChangeWatcher` group drives the loop through the injected timer
// seam, so "backs off exponentially, capped" is asserted in microseconds rather
// than by waiting a minute.

import type { PolicyChangeEvent, PolicyRecord } from "@nestm/permissions-core";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { MAX_POLL_BACKOFF_MS } from "../../src/store/options.ts";
import { DrizzlePolicyStore } from "../../src/store/drizzle-policy-store.ts";
import {
	PolicyChangeWatcher,
	PolicyNotifyListener,
	type WatcherTimers,
} from "../../src/store/watcher.ts";
import { provisionPermissionsSchema, type ProvisionedSchema } from "../../src/testing.ts";
import { PG_SKIPPED, PG_URL, assertPostgresReachable, uniqueSuffix } from "../fixtures/pg.ts";

const FIXTURE_TIME = new Date("2026-07-30T00:00:00.000Z");

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

// ---------------------------------------------------------------------------
// The loop, through the timer seam
// ---------------------------------------------------------------------------

/** A `WatcherTimers` that records delays and lets the test decide when to fire. */
class ManualTimers implements WatcherTimers {
	readonly delays: number[] = [];
	#pending: (() => void) | undefined;
	#cancelled = 0;

	setTimeout(handler: () => void, delayMs: number): unknown {
		this.delays.push(delayMs);
		this.#pending = handler;
		return this.delays.length;
	}

	clearTimeout(): void {
		this.#cancelled += 1;
		this.#pending = undefined;
	}

	get cancellations(): number {
		return this.#cancelled;
	}

	/** Fires the scheduled callback and lets its async chain settle. */
	async fire(): Promise<void> {
		const handler = this.#pending;
		this.#pending = undefined;
		handler?.();
		// The loop's chain is `void this.#runAndReschedule()`, so a few microtask
		// turns are needed before the reschedule is observable.
		for (let turn = 0; turn < 8; turn += 1) {
			await Promise.resolve();
		}
	}

	get scheduled(): boolean {
		return this.#pending !== undefined;
	}
}

describe("PolicyChangeWatcher", () => {
	it("seeds exactly once, before the first tick", async () => {
		const calls: string[] = [];
		const timers = new ManualTimers();
		const watcher = new PolicyChangeWatcher({
			intervalMs: 100,
			seed: async () => void calls.push("seed"),
			tick: async () => void calls.push("tick"),
			timers,
		});

		watcher.start();
		await timers.fire();
		await timers.fire();
		await timers.fire();

		expect(calls).toEqual(["seed", "tick", "tick", "tick"]);
	});

	it("starts immediately, then waits the configured interval", async () => {
		const timers = new ManualTimers();
		const watcher = new PolicyChangeWatcher({
			intervalMs: 5000,
			seed: async () => undefined,
			tick: async () => undefined,
			timers,
		});

		watcher.start();
		// The first schedule is `0` — a store that has just been watched should not
		// wait a whole interval before it knows anything.
		expect(timers.delays).toEqual([0]);

		await timers.fire();
		expect(timers.delays).toEqual([0, 5000]);
	});

	it("backs off exponentially and caps, then resets after a success", async () => {
		let failing = true;
		const timers = new ManualTimers();
		const watcher = new PolicyChangeWatcher({
			intervalMs: 1000,
			seed: async () => undefined,
			tick: async () => {
				if (failing) {
					throw new Error("database is down");
				}
			},
			onError: () => undefined,
			timers,
		});

		watcher.start();
		for (let attempt = 0; attempt < 8; attempt += 1) {
			await timers.fire();
		}

		// 1000·2^1, 2^2, … capped at MAX_POLL_BACKOFF_MS. A database down for an hour
		// is polled ~60 times, not ~720.
		expect(timers.delays).toEqual([0, 2000, 4000, 8000, 16_000, 32_000, 60_000, 60_000, 60_000]);
		expect(watcher.consecutiveFailures).toBe(8);
		expect(watcher.nextDelayMs).toBe(MAX_POLL_BACKOFF_MS);

		failing = false;
		await timers.fire();
		expect(watcher.consecutiveFailures).toBe(0);
		expect(watcher.nextDelayMs).toBe(1000);
	});

	it("routes every failure to onError and never rejects", async () => {
		const errors: unknown[] = [];
		const timers = new ManualTimers();
		const watcher = new PolicyChangeWatcher({
			intervalMs: 10,
			seed: async () => undefined,
			tick: async () => {
				throw new Error("boom");
			},
			onError: (error) => errors.push(error),
			timers,
		});

		const rejections: unknown[] = [];
		const onRejection = (reason: unknown): void => void rejections.push(reason);
		process.on("unhandledRejection", onRejection);
		try {
			watcher.start();
			await timers.fire();
			await timers.fire();
		} finally {
			process.off("unhandledRejection", onRejection);
		}

		expect(errors).toHaveLength(2);
		expect(rejections).toEqual([]);
		// Still scheduled: a failing poller retries, it does not give up.
		expect(timers.scheduled).toBe(true);
	});

	it("survives an onError that itself throws", async () => {
		// There is nowhere left to report to, so this is the one place that swallows —
		// and the loop has to keep running, because the alternative is that a broken
		// logger silently disables invalidation.
		const timers = new ManualTimers();
		const watcher = new PolicyChangeWatcher({
			intervalMs: 10,
			seed: async () => undefined,
			tick: async () => {
				throw new Error("boom");
			},
			onError: () => {
				throw new Error("the logger is broken too");
			},
			timers,
		});

		watcher.start();
		await timers.fire();
		await timers.fire();

		expect(watcher.consecutiveFailures).toBe(2);
		expect(timers.scheduled).toBe(true);
	});

	it("propagates a seed failure as a tick failure and retries the seed", async () => {
		let seeds = 0;
		const timers = new ManualTimers();
		const watcher = new PolicyChangeWatcher({
			intervalMs: 10,
			seed: async () => {
				seeds += 1;
				if (seeds === 1) {
					throw new Error("cannot reach the versions table");
				}
			},
			tick: async () => undefined,
			onError: () => undefined,
			timers,
		});

		watcher.start();
		await timers.fire();
		expect(watcher.consecutiveFailures).toBe(1);

		await timers.fire();
		expect(seeds).toBe(2);
		expect(watcher.consecutiveFailures).toBe(0);
	});

	it("is idempotent on start and stop", async () => {
		const timers = new ManualTimers();
		const watcher = new PolicyChangeWatcher({
			intervalMs: 10,
			seed: async () => undefined,
			tick: async () => undefined,
			timers,
		});

		watcher.start();
		watcher.start();
		watcher.start();
		expect(timers.delays).toEqual([0]);
		expect(watcher.running).toBe(true);

		watcher.stop();
		watcher.stop();
		expect(watcher.running).toBe(false);
		expect(timers.cancellations).toBe(1);
	});

	it("stops rescheduling once stopped", async () => {
		let ticks = 0;
		const timers = new ManualTimers();
		const watcher = new PolicyChangeWatcher({
			intervalMs: 10,
			seed: async () => undefined,
			tick: async () => void (ticks += 1),
			timers,
		});

		watcher.start();
		await timers.fire();
		expect(ticks).toBe(1);

		watcher.stop();
		await timers.fire();
		expect(ticks).toBe(1);
		expect(timers.scheduled).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// The store's poll, against a real database
// ---------------------------------------------------------------------------

describe.skipIf(PG_SKIPPED)("DrizzlePolicyStore invalidation", () => {
	let provisioned: ProvisionedSchema;
	const stores: DrizzlePolicyStore[] = [];

	/** A store over the shared tables, tracked so `afterEach` can dispose it. */
	function makeStore(
		options: ConstructorParameters<typeof DrizzlePolicyStore>[2] = {},
	): DrizzlePolicyStore {
		const store = new DrizzlePolicyStore(provisioned.db, provisioned.schema, {
			poll: false,
			...options,
		});
		stores.push(store);
		return store;
	}

	beforeAll(async () => {
		await assertPostgresReachable();
		provisioned = await provisionPermissionsSchema(PG_URL);
	});

	afterEach(async () => {
		await Promise.all(stores.splice(0).map((store) => store.dispose()));
	});

	afterAll(async () => {
		await provisioned?.drop();
	});

	it("emits synchronously after commit, with no poll involved", async () => {
		const store = makeStore();
		const events: PolicyChangeEvent[] = [];
		store.watch((event) => events.push(event));

		const scope = uniqueSuffix("sync");
		await store.save([policy("p1", scope)]);

		// Zero staleness for the writing replica: the event is already delivered by
		// the time `save()` resolves.
		expect(events).toEqual([{ scope, reason: "save" }]);

		await store.linkTemplate({
			id: "l1",
			scope,
			templateId: "p1",
			values: {},
			updatedAt: FIXTURE_TIME,
		});
		expect(events.at(-1)).toEqual({ scope, reason: "link" });

		await store.unlinkTemplate(scope, "l1");
		expect(events.at(-1)).toEqual({ scope, reason: "unlink" });

		await store.delete(scope, ["p1"]);
		expect(events.at(-1)).toEqual({ scope, reason: "delete" });
	});

	it("does not emit for a delete that matched nothing", async () => {
		// A no-op write must not bump the version, or every failed revoke would
		// invalidate every replica's cache for that tenant.
		const store = makeStore();
		const events: PolicyChangeEvent[] = [];
		store.watch((event) => events.push(event));

		await store.delete(uniqueSuffix("noop"), ["absent"]);
		await store.unlinkTemplate(uniqueSuffix("noop"), "absent");

		expect(events).toEqual([]);
	});

	it("emits exactly once per changed scope on a poll tick", async () => {
		// The writer and the poller are separate stores, exactly as two replicas are:
		// the reader has no local knowledge of the write at all.
		const writer = makeStore();
		const reader = makeStore();

		const events: PolicyChangeEvent[] = [];
		reader.watch((event) => events.push(event));

		// Seed the reader's observed versions before anything changes.
		await reader.pollOnce();
		expect(events).toEqual([]);

		const alpha = uniqueSuffix("alpha");
		const beta = uniqueSuffix("beta");

		// Three writes across two scopes. The tick must collapse them to one event
		// per *scope*, not one per write.
		await writer.save([policy("p1", alpha)]);
		await writer.save([policy("p2", alpha)]);
		await writer.save([policy("p3", beta)]);

		await reader.pollOnce();

		expect(events.map((event) => event.scope).toSorted()).toEqual([alpha, beta].toSorted());
		expect(events.every((event) => event.reason === "external")).toBe(true);
	});

	it("emits nothing on a tick with no changes", async () => {
		const store = makeStore();
		const events: PolicyChangeEvent[] = [];
		store.watch((event) => events.push(event));

		await store.pollOnce();
		await store.pollOnce();
		await store.pollOnce();

		expect(events).toEqual([]);
	});

	it("does not re-report a change it has already delivered", async () => {
		// The observed version map advances after delivery, so unchanged counters are
		// not re-reported on later ticks.
		const writer = makeStore();
		const reader = makeStore();
		const events: PolicyChangeEvent[] = [];
		reader.watch((event) => events.push(event));

		await reader.pollOnce();
		const scope = uniqueSuffix("once");
		await writer.save([policy("p1", scope)]);

		await reader.pollOnce();
		expect(events).toHaveLength(1);

		await reader.pollOnce();
		await reader.pollOnce();
		expect(events).toHaveLength(1);
	});

	it("broadcasts a global write as '*'", async () => {
		const writer = makeStore();
		const reader = makeStore();
		const events: PolicyChangeEvent[] = [];
		reader.watch((event) => events.push(event));

		await reader.pollOnce();
		await writer.save([policy("global", "")]);

		await reader.pollOnce();
		// A global write changes the effective bundle of every scope (D2), so it is
		// broadcast rather than reported as a change to `''`.
		expect(events.map((event) => event.scope)).toEqual(["*"]);
	});

	it("keeps the version snapshot and delivers the change after a failed tick", async () => {
		// The assertion the whole backoff design exists for. The scope-versions table
		// is renamed out from under the poller, so the tick throws; the change written
		// *before* the failure must still arrive once the table is back.
		const writer = makeStore();
		const reader = makeStore();
		const events: PolicyChangeEvent[] = [];
		const errors: unknown[] = [];
		reader.watch((event) => events.push(event));

		await reader.pollOnce();

		const scope = uniqueSuffix("resilient");
		await writer.save([policy("p1", scope)]);

		const versions = provisioned.tableNames[2] as string;
		await provisioned.db.execute(
			sql.raw(`alter table "${versions}" rename to "${versions}_hidden"`),
		);
		try {
			await reader.pollOnce().catch((error: unknown) => errors.push(error));
			expect(errors).toHaveLength(1);
			expect(events, "a failed tick must not invent events").toEqual([]);
		} finally {
			await provisioned.db.execute(
				sql.raw(`alter table "${versions}_hidden" rename to "${versions}"`),
			);
		}

		await reader.pollOnce();
		expect(events.map((event) => event.scope)).toEqual([scope]);
	});

	it("does not miss a transaction that starts first and commits last", async () => {
		const writer = makeStore();
		const reader = makeStore();
		const events: PolicyChangeEvent[] = [];
		reader.watch((event) => events.push(event));
		await reader.pollOnce();

		const olderScope = uniqueSuffix("older-commit");
		const newerScope = uniqueSuffix("newer-commit");
		const started = voidDeferred();
		const release = voidDeferred();
		const table = provisioned.schema.permissionScopeVersions;
		const olderWrite = provisioned.db.transaction(async (tx) => {
			await tx
				.insert(table)
				.values({ scope: olderScope, version: 1, updatedAt: sql`now()` } as never)
				.onConflictDoUpdate({
					target: table.scope,
					set: { version: sql`${table.version} + 1`, updatedAt: sql`now()` } as never,
				});
			started.resolve();
			await release.promise;
		});

		try {
			await started.promise;
			await writer.save([policy("newer", newerScope)]);
			await reader.pollOnce();
			expect(events.map((event) => event.scope)).toEqual([newerScope]);

			release.resolve();
			await olderWrite;
			await reader.pollOnce();
			expect(events.map((event) => event.scope)).toEqual([newerScope, olderScope]);
		} finally {
			release.resolve();
			await olderWrite.catch(() => undefined);
		}
	});

	it("starts the poller on the first watch and stops it on the last unsubscribe", () => {
		const store = makeStore({ poll: { intervalMs: 60_000 } });
		expect(store.watcher).toBeUndefined();

		const first = store.watch(() => undefined);
		const second = store.watch(() => undefined);
		expect(store.watcher?.running).toBe(true);

		first();
		expect(store.watcher?.running, "one listener remains").toBe(true);

		second();
		expect(store.watcher?.running, "no listener remains").toBe(false);

		// Idempotent: a second unsubscribe must not restart or double-stop anything.
		second();
		expect(store.watcher?.running).toBe(false);
	});

	it("issues no background query at all for a store nobody watches", () => {
		const store = makeStore({ poll: { intervalMs: 10 } });
		expect(store.watcher).toBeUndefined();
	});

	it("notifies every listener even when one throws, then reports", async () => {
		const store = makeStore();
		const seen: string[] = [];
		store.watch(() => {
			throw new Error("listener one is broken");
		});
		store.watch(() => void seen.push("two"));

		// A half-notified set of caches is worse than a loud failure after the fact:
		// the second listener still gets its event, and the throw is not swallowed.
		await expect(store.save([policy("p1", uniqueSuffix("throwing"))])).rejects.toThrow(
			/listener\(s\) threw/,
		);
		expect(seen).toEqual(["two"]);
	});

	it("stops delivering after dispose", async () => {
		const store = makeStore();
		const events: PolicyChangeEvent[] = [];
		store.watch((event) => events.push(event));

		await store.dispose();
		await store.save([policy("p1", uniqueSuffix("disposed"))]);

		expect(events).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// LISTEN / NOTIFY
// ---------------------------------------------------------------------------

describe.skipIf(PG_SKIPPED)("LISTEN/NOTIFY", () => {
	let provisioned: ProvisionedSchema;
	const disposers: (() => Promise<void>)[] = [];
	const CHANNEL = `nestm_test_${String(process.pid % 100_000)}`;

	beforeAll(async () => {
		await assertPostgresReachable();
		provisioned = await provisionPermissionsSchema(PG_URL);
	});

	afterEach(async () => {
		await Promise.all(disposers.splice(0).map((dispose) => dispose()));
	});

	afterAll(async () => {
		await provisioned?.drop();
	});

	it("carries a writing replica's scope id over the channel", async () => {
		// The deterministic half: the listener is awaited, so `LISTEN` is provably
		// live before the write happens. `PolicyNotifyListener` is what the store
		// drives, so this is the same code path with the race removed.
		const { Client } = await import("pg");

		const payloads: string[] = [];
		const listener = new PolicyNotifyListener({
			// A dedicated, non-pooled connection by construction: the caller supplies
			// it, because a pooled connection handed out mid-`LISTEN` stops delivering
			// notifications with no error anywhere.
			notify: { channel: CHANNEL, client: () => new Client(PG_URL) as never },
			onPayload: (payload) => void payloads.push(payload),
		});
		await listener.start();
		disposers.push(() => listener.stop());

		const writer = new DrizzlePolicyStore(provisioned.db, provisioned.schema, {
			poll: false,
			notify: { channel: CHANNEL, client: () => new Client(PG_URL) as never },
		});
		disposers.push(() => writer.dispose());

		const scope = uniqueSuffix("notify");
		await writer.save([policy("p1", scope)]);

		await waitFor(() => Promise.resolve(payloads.includes(scope)));
		expect(payloads).toContain(scope);
	});

	it("broadcasts a global write as the '*' payload", async () => {
		const { Client } = await import("pg");

		const payloads: string[] = [];
		const listener = new PolicyNotifyListener({
			notify: { channel: CHANNEL, client: () => new Client(PG_URL) as never },
			onPayload: (payload) => void payloads.push(payload),
		});
		await listener.start();
		disposers.push(() => listener.stop());

		const writer = new DrizzlePolicyStore(provisioned.db, provisioned.schema, {
			poll: false,
			notify: { channel: CHANNEL, client: () => new Client(PG_URL) as never },
		});
		disposers.push(() => writer.dispose());

		await writer.save([policy("global-notify", "")]);

		await waitFor(() => Promise.resolve(payloads.includes("*")));
		expect(payloads).toContain("*");
	});

	it("turns a delivered payload into a change event on the receiving store", async () => {
		// The store half. `watch()` starts the listener in the background — there is
		// no handle to await — so the write is retried until one notification lands.
		// That is not test flakiness being papered over: `NOTIFY` genuinely is
		// best-effort, which is exactly why it accelerates the poll rather than
		// replacing it.
		const { Client } = await import("pg");

		const reader = new DrizzlePolicyStore(provisioned.db, provisioned.schema, {
			poll: false,
			notify: { channel: CHANNEL, client: () => new Client(PG_URL) as never },
		});
		disposers.push(() => reader.dispose());

		const writer = new DrizzlePolicyStore(provisioned.db, provisioned.schema, {
			poll: false,
			notify: { channel: CHANNEL, client: () => new Client(PG_URL) as never },
		});
		disposers.push(() => writer.dispose());

		const events: PolicyChangeEvent[] = [];
		reader.watch((event) => events.push(event));

		const scope = uniqueSuffix("notify_store");
		await waitFor(async () => {
			await writer.save([policy("p1", scope)]);
			await new Promise((resolve) => setTimeout(resolve, 50));
			return events.some((event) => event.scope === scope);
		});

		expect(events.find((event) => event.scope === scope)?.reason).toBe("external");
	});

	it("does not announce a rolled-back write", async () => {
		// `pg_notify` runs in the same transaction as the version bump, so a write
		// that never commits cannot announce itself.
		const { Client } = await import("pg");
		const client = new Client(PG_URL);
		await client.connect();
		disposers.push(() => client.end());

		const payloads: string[] = [];
		client.on("notification", (message) => void payloads.push(message.payload ?? ""));
		await client.query(`LISTEN "${CHANNEL}"`);

		await provisioned.db
			.transaction(async (tx) => {
				await tx.execute(sql`select pg_notify(${CHANNEL}, ${"rolled-back"})`);
				throw new Error("abort");
			})
			.catch(() => undefined);

		await provisioned.db.execute(sql`select pg_notify(${CHANNEL}, ${"committed"})`);
		await waitFor(() => Promise.resolve(payloads.includes("committed")));

		expect(payloads).toContain("committed");
		expect(payloads).not.toContain("rolled-back");
	});

	it("rejects a channel name that is not a plain identifier", async () => {
		const { Client } = await import("pg");
		expect(() =>
			new DrizzlePolicyStore(provisioned.db, provisioned.schema, {
				poll: false,
				notify: { channel: 'evil"; drop table x; --', client: () => new Client(PG_URL) as never },
			}).watch(() => undefined),
		).toThrow(TypeError);
	});
});

/** Polls `condition` until it holds, or fails with a message that says what was waited on. */
async function waitFor(condition: () => Promise<boolean>, timeoutMs = 5000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await condition()) {
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	throw new Error(`Condition did not hold within ${String(timeoutMs)}ms.`);
}
