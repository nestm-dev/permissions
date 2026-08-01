// The store's change channel, against a real server.
//
// D1 is the contract being tested: **implementing `watch` is a promise that every
// write becomes an event.** The engine stops polling `currentVersion` the moment a
// store implements it, so a missed event serves stale decisions indefinitely —
// which is the only failure in this package that gets *more* permissive over time,
// because a revoked grant stays live.
//
// Two channels, and the difference matters:
//
//   * The writing replica emits **synchronously after commit**. Zero staleness for
//     the process that made the change, with no round-trip.
//   * Every other replica learns from the poller — one query per tick regardless
//     of tenant count — or, opted in, from `LISTEN`/`NOTIFY` on a dedicated
//     connection.

import { Client } from "pg";
import { beforeAll, describe, expect, it } from "vitest";
import type { PolicyChangeEvent } from "@nestm/permissions-core";

import { TypeOrmPolicyStore } from "../../src/store/typeorm-policy-store.ts";
import { provisionPermissionsSchema, type ProvisionedSchema } from "../../src/testing.ts";
import { PG_SKIPPED, PG_URL, assertPostgresReachable } from "../fixtures/pg.ts";

const AT = new Date("2026-07-30T00:00:00.000Z");

function policy(id: string, scope: string) {
	return {
		id,
		scope,
		kind: "static" as const,
		cedarJson: { id } as never,
		enabled: true,
		updatedAt: AT,
	};
}

/** Provisions a schema and hands back a teardown that always runs. */
async function withSchema(body: (handle: ProvisionedSchema) => Promise<void>): Promise<void> {
	const provisioned = await provisionPermissionsSchema(PG_URL);
	try {
		await body(provisioned);
	} finally {
		await provisioned.drop();
	}
}

describe.skipIf(PG_SKIPPED)("change channel", () => {
	beforeAll(async () => {
		await assertPostgresReachable();
	});

	it("emits synchronously after commit on the writing replica", async () => {
		await withSchema(async ({ dataSource, entities }) => {
			const store = new TypeOrmPolicyStore(dataSource, { entities, poll: false });
			const events: PolicyChangeEvent[] = [];
			const unsubscribe = store.watch((event) => events.push(event));

			await store.save([policy("p1", "tenant:a")]);
			// Already delivered by the time `save` resolves — no timer, no round-trip.
			expect(events).toEqual([{ scope: "tenant:a", reason: "save" }]);

			await store.linkTemplate({
				id: "l1",
				scope: "tenant:a",
				templateId: "p1",
				values: {},
				updatedAt: AT,
			});
			await store.unlinkTemplate("tenant:a", "l1");
			await store.delete("tenant:a", ["p1"]);

			expect(events.map((event) => event.reason)).toEqual(["save", "link", "unlink", "delete"]);

			unsubscribe();
			await store.save([policy("p2", "tenant:a")]);
			expect(events).toHaveLength(4);

			await store.dispose();
		});
	});

	it("does not emit for a write that changed nothing", async () => {
		await withSchema(async ({ dataSource, entities }) => {
			const store = new TypeOrmPolicyStore(dataSource, { entities, poll: false });
			const events: PolicyChangeEvent[] = [];
			store.watch((event) => events.push(event));

			// Neither of these touches a row, so neither may claim the cache is stale:
			// a spurious event is a full policy reload on every replica.
			await store.delete("tenant:a", ["absent"]);
			await store.unlinkTemplate("tenant:a", "absent");
			await store.save([]);
			await store.delete("tenant:a", []);

			expect(events).toEqual([]);
			await store.dispose();
		});
	});

	it("broadcasts a global write as '*', because it changes every scope's bundle", async () => {
		await withSchema(async ({ dataSource, entities }) => {
			const store = new TypeOrmPolicyStore(dataSource, { entities, poll: false });
			const events: PolicyChangeEvent[] = [];
			store.watch((event) => events.push(event));

			await store.save([policy("g1", "")]);
			expect(events).toEqual([{ scope: "*", reason: "save" }]);

			await store.dispose();
		});
	});

	it("polls exactly one event per changed scope, and none for an unchanged one", async () => {
		await withSchema(async ({ dataSource, entities }) => {
			const writer = new TypeOrmPolicyStore(dataSource, { entities, poll: false });
			const reader = new TypeOrmPolicyStore(dataSource, { entities, poll: false });

			const events: PolicyChangeEvent[] = [];
			reader.watch((event) => events.push(event));

			// Seed the watermark *before* the writes, as a replica that has been up
			// would have.
			await reader.pollOnce();
			expect(events).toEqual([]);

			await writer.save([policy("p1", "tenant:a"), policy("p2", "tenant:a")]);
			await writer.save([policy("p3", "tenant:b")]);

			await reader.pollOnce();
			expect(events.map((event) => event.scope).toSorted()).toEqual(["tenant:a", "tenant:b"]);
			expect(events.every((event) => event.reason === "external")).toBe(true);

			// The watermark advanced: a second tick with no writes in between is silent.
			events.length = 0;
			await reader.pollOnce();
			expect(events).toEqual([]);

			// One write, one event — not one per policy in it.
			await writer.save([policy("p4", "tenant:a"), policy("p5", "tenant:a")]);
			await reader.pollOnce();
			expect(events).toEqual([{ scope: "tenant:a", reason: "external" }]);

			await writer.dispose();
			await reader.dispose();
		});
	});

	it("reports a polled global change as '*' too", async () => {
		await withSchema(async ({ dataSource, entities }) => {
			const writer = new TypeOrmPolicyStore(dataSource, { entities, poll: false });
			const reader = new TypeOrmPolicyStore(dataSource, { entities, poll: false });
			const events: PolicyChangeEvent[] = [];

			reader.watch((event) => events.push(event));
			await reader.pollOnce();

			await writer.save([policy("g1", "")]);
			await reader.pollOnce();

			expect(events).toEqual([{ scope: "*", reason: "external" }]);
			await writer.dispose();
			await reader.dispose();
		});
	});

	it("keeps a sub-millisecond watermark, so a row is never re-reported forever", async () => {
		await withSchema(async ({ dataSource, entities }) => {
			const writer = new TypeOrmPolicyStore(dataSource, { entities, poll: false });
			const reader = new TypeOrmPolicyStore(dataSource, { entities, poll: false });
			const events: PolicyChangeEvent[] = [];

			reader.watch((event) => events.push(event));
			await reader.pollOnce();

			await writer.save([policy("p1", "tenant:a")]);

			// `timestamptz` has microsecond precision and a JavaScript `Date` has
			// milliseconds. A truncated watermark would re-report this row on every
			// tick, forever, because `updated_at > 12:00:00.000` never excludes
			// `12:00:00.0005`.
			await reader.pollOnce();
			expect(events).toHaveLength(1);
			for (let index = 0; index < 5; index += 1) {
				await reader.pollOnce();
			}
			expect(events).toHaveLength(1);

			await writer.dispose();
			await reader.dispose();
		});
	});

	it("starts the poller on the first watch and stops it on the last unsubscribe", async () => {
		await withSchema(async ({ dataSource, entities }) => {
			const store = new TypeOrmPolicyStore(dataSource, { entities, poll: { intervalMs: 50 } });
			expect(store.watcher).toBeUndefined();

			const first = store.watch(() => undefined);
			const second = store.watch(() => undefined);
			expect(store.watcher?.running).toBe(true);

			first();
			expect(store.watcher?.running).toBe(true);
			second();
			// A store nobody watches issues no background queries at all.
			expect(store.watcher?.running).toBe(false);

			await store.dispose();
		});
	});

	it("notifies every listener even when one throws", async () => {
		await withSchema(async ({ dataSource, entities }) => {
			const store = new TypeOrmPolicyStore(dataSource, { entities, poll: false });
			const seen: string[] = [];

			store.watch(() => {
				throw new Error("first listener is broken");
			});
			store.watch(() => seen.push("second"));

			// A half-notified set of caches is worse than a loud failure after the fact,
			// so every listener runs and the failure surfaces afterwards.
			await expect(store.save([policy("p1", "tenant:a")])).rejects.toThrow(/listener/);
			expect(seen).toEqual(["second"]);

			await store.dispose();
		});
	});

	it("delivers a LISTEN/NOTIFY event to another replica", async () => {
		await withSchema(async ({ dataSource, entities }) => {
			const channel = "nestm_permissions_test";
			const clients: Client[] = [];

			const reader = new TypeOrmPolicyStore(dataSource, {
				entities,
				poll: false,
				notify: {
					channel,
					client: () => {
						const client = new Client({ connectionString: PG_URL });
						clients.push(client);
						return client;
					},
				},
			});
			// The writer announces on the same channel, inside the bump transaction.
			const writer = new TypeOrmPolicyStore(dataSource, {
				entities,
				poll: false,
				notify: { channel, client: () => new Client({ connectionString: PG_URL }) },
			});

			const events: PolicyChangeEvent[] = [];
			reader.watch((event) => events.push(event));

			// `watch` starts the listener asynchronously; wait for the LISTEN to land.
			await waitFor(() => clients.length > 0);
			await new Promise((resolve) => setTimeout(resolve, 150));

			await writer.save([policy("p1", "tenant:a")]);

			await waitFor(() =>
				events.some((event) => event.scope === "tenant:a" && event.reason === "external"),
			);

			await reader.dispose();
			await writer.dispose();
		});
	});

	it("does not announce a rolled-back write", async () => {
		await withSchema(async ({ dataSource, entities }) => {
			const channel = "nestm_permissions_rollback";
			const store = new TypeOrmPolicyStore(dataSource, {
				entities,
				poll: false,
				notify: { channel, client: () => new Client({ connectionString: PG_URL }) },
			});

			const received: string[] = [];
			const listener = new Client({ connectionString: PG_URL });
			await listener.connect();
			listener.on("notification", (message) => received.push(message.payload ?? ""));
			await listener.query(`LISTEN "${channel}"`);

			try {
				// A record the store itself refuses: nothing reaches the database, so
				// nothing may be announced.
				await expect(
					store.save([{ ...policy("bad", "tenant:a"), kind: "nonsense" as never }]),
				).rejects.toThrow();

				await new Promise((resolve) => setTimeout(resolve, 200));
				expect(received).toEqual([]);

				// `pg_notify` runs in the bump's transaction, so a committed write does
				// arrive — the point being that the channel is transactional, not that it
				// is silent.
				await store.save([policy("good", "tenant:a")]);
				await waitFor(
					() => received.includes("tenant:a"),
					3000,
					() => listener.query("select 1"),
				);
			} finally {
				await listener.end();
				await store.dispose();
			}
		});
	});
});

/** Polls `predicate` until it holds, or fails with a useful message. */
async function waitFor(
	predicate: () => boolean,
	timeoutMs = 5000,
	poke?: () => Promise<unknown>,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) {
			return;
		}
		await poke?.();
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	throw new Error(`condition did not hold within ${String(timeoutMs)}ms`);
}
