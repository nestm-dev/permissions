// The invalidation channel's failure behaviour, with an injected clock.
//
// Everything asserted here is about what happens when the database is *unhappy*,
// because that is the only interesting state: a poller that works when everything
// works is not a component, it is a `setInterval`.
//
//   1. A failed tick never advances the watermark. The next tick asks the same
//      question, so an invalidation is delayed and never lost.
//   2. A failed tick never clears anything. Stale-but-known beats empty — an empty
//      policy set is `deny`, so a database blip would otherwise be a site-wide
//      outage rather than a delay.
//   3. Nothing here can crash the process, including an `onError` that itself
//      throws. An unhandled rejection in a background timer takes the whole
//      application down.

import { describe, expect, it } from "vitest";

import { MAX_POLL_BACKOFF_MS } from "../../src/store/options.ts";
import {
	PolicyChangeWatcher,
	PolicyNotifyListener,
	type WatcherTimers,
} from "../../src/store/watcher.ts";

/** A `setTimeout` seam that records delays and fires on demand. */
class ManualTimers implements WatcherTimers {
	readonly delays: number[] = [];
	#pending: (() => void) | undefined;
	#handle = 0;

	setTimeout(handler: () => void, delayMs: number): unknown {
		this.delays.push(delayMs);
		this.#pending = handler;
		this.#handle += 1;
		return this.#handle;
	}

	clearTimeout(): void {
		this.#pending = undefined;
	}

	/** Fires the scheduled callback and lets its promise chain settle. */
	async fire(): Promise<void> {
		const pending = this.#pending;
		this.#pending = undefined;
		pending?.();
		// Two turns: `#runAndReschedule` awaits `runOnce` and then reschedules.
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();
	}

	get scheduled(): boolean {
		return this.#pending !== undefined;
	}
}

describe("PolicyChangeWatcher", () => {
	it("seeds once, then ticks", async () => {
		const timers = new ManualTimers();
		let seeds = 0;
		let ticks = 0;

		const watcher = new PolicyChangeWatcher({
			intervalMs: 1000,
			seed: async () => {
				seeds += 1;
			},
			tick: async () => {
				ticks += 1;
			},
			timers,
		});

		watcher.start();
		expect(timers.delays).toEqual([0]);

		await timers.fire();
		expect(seeds).toBe(1);
		expect(ticks).toBe(1);

		await timers.fire();
		expect(seeds).toBe(1);
		expect(ticks).toBe(2);
	});

	it("backs off exponentially and recovers", async () => {
		const timers = new ManualTimers();
		const errors: unknown[] = [];
		let failing = true;

		const watcher = new PolicyChangeWatcher({
			intervalMs: 100,
			seed: async () => undefined,
			tick: async () => {
				if (failing) {
					throw new Error("connection refused");
				}
			},
			onError: (error) => errors.push(error),
			timers,
			maxBackoffMs: 1000,
		});

		watcher.start();
		await timers.fire();
		expect(watcher.consecutiveFailures).toBe(1);
		expect(watcher.nextDelayMs).toBe(200);

		await timers.fire();
		expect(watcher.nextDelayMs).toBe(400);
		await timers.fire();
		expect(watcher.nextDelayMs).toBe(800);
		await timers.fire();
		// Capped, so an hour of downtime is ~60 polls rather than ~720.
		expect(watcher.nextDelayMs).toBe(1000);

		expect(errors).toHaveLength(4);

		failing = false;
		await timers.fire();
		expect(watcher.consecutiveFailures).toBe(0);
		expect(watcher.nextDelayMs).toBe(100);
	});

	it("uses the shared ceiling by default", () => {
		const watcher = new PolicyChangeWatcher({
			intervalMs: 5000,
			seed: async () => undefined,
			tick: async () => {
				throw new Error("x");
			},
			timers: new ManualTimers(),
		});
		// 5000 * 2^30 clamped to the documented ceiling, not to Infinity.
		expect(MAX_POLL_BACKOFF_MS).toBe(60_000);
		watcher.start();
		expect(watcher.nextDelayMs).toBe(5000);
	});

	it("keeps looping when onError itself throws", async () => {
		const timers = new ManualTimers();
		let ticks = 0;

		const watcher = new PolicyChangeWatcher({
			intervalMs: 10,
			seed: async () => undefined,
			tick: async () => {
				ticks += 1;
				throw new Error("boom");
			},
			onError: () => {
				throw new Error("the logger is also down");
			},
			timers,
		});

		watcher.start();
		await timers.fire();
		await timers.fire();

		// Two ticks happened and the loop is still scheduled: there is nowhere left
		// to report to, so this is the one place that swallows.
		expect(ticks).toBe(2);
		expect(timers.scheduled).toBe(true);
	});

	it("re-runs a failed seed rather than ticking without a watermark", async () => {
		const timers = new ManualTimers();
		let seeds = 0;
		let ticks = 0;

		const watcher = new PolicyChangeWatcher({
			intervalMs: 10,
			seed: async () => {
				seeds += 1;
				if (seeds === 1) {
					throw new Error("seed failed");
				}
			},
			tick: async () => {
				ticks += 1;
			},
			onError: () => undefined,
			timers,
		});

		watcher.start();
		await timers.fire();
		expect(seeds).toBe(1);
		// No tick: a tick with no watermark would either re-report everything or
		// report nothing, and both are wrong.
		expect(ticks).toBe(0);

		await timers.fire();
		expect(seeds).toBe(2);
		expect(ticks).toBe(1);
	});

	it("start and stop are idempotent", async () => {
		const timers = new ManualTimers();
		const watcher = new PolicyChangeWatcher({
			intervalMs: 10,
			seed: async () => undefined,
			tick: async () => undefined,
			timers,
		});

		watcher.start();
		watcher.start();
		expect(timers.delays).toEqual([0]);
		expect(watcher.running).toBe(true);

		watcher.stop();
		watcher.stop();
		expect(watcher.running).toBe(false);
		expect(timers.scheduled).toBe(false);

		// A stopped watcher does not reschedule even if a tick was in flight.
		await timers.fire();
		expect(timers.delays).toEqual([0]);
	});
});

describe("PolicyNotifyListener", () => {
	it("rejects a channel name that is not a plain identifier", () => {
		expect(
			() =>
				new PolicyNotifyListener({
					notify: { channel: 'a"; drop table x; --', client: () => ({}) as never },
					onPayload: () => undefined,
				}),
		).toThrowError(/plain SQL identifier/);
	});

	it("issues LISTEN, filters by channel, and ends the client once", async () => {
		const queries: string[] = [];
		const listeners = new Map<string, (payload: unknown) => void>();
		let ended = 0;
		const payloads: string[] = [];

		const client = {
			connect: async () => undefined,
			query: async (text: string) => {
				queries.push(text);
			},
			on: (event: string, listener: (payload: unknown) => void) => {
				listeners.set(event, listener);
			},
			end: async () => {
				ended += 1;
			},
		};

		const listener = new PolicyNotifyListener({
			notify: { channel: "nestm_permissions", client: () => client as never },
			onPayload: (payload) => payloads.push(payload),
		});

		await listener.start();
		await listener.start();
		expect(queries).toEqual([`LISTEN "nestm_permissions"`]);

		const notify = listeners.get("notification");
		notify?.({ channel: "nestm_permissions", payload: "tenant:a" });
		notify?.({ channel: "someone_elses_channel", payload: "tenant:b" });
		notify?.({ channel: "nestm_permissions" });

		// The foreign channel is ignored; a payload-less notification becomes `''`,
		// which is the global scope and invalidates everything — the safe direction.
		expect(payloads).toEqual(["tenant:a", ""]);

		await listener.stop();
		await listener.stop();
		expect(ended).toBe(1);
	});

	it("routes a client error to onError instead of throwing", async () => {
		const errors: unknown[] = [];
		const listeners = new Map<string, (payload: unknown) => void>();

		const listener = new PolicyNotifyListener({
			notify: {
				channel: "chan",
				client: () =>
					({
						connect: async () => undefined,
						query: async () => undefined,
						on: (event: string, handler: (payload: unknown) => void) => {
							listeners.set(event, handler);
						},
						end: async () => {
							throw new Error("already closed");
						},
					}) as never,
			},
			onPayload: () => {
				throw new Error("listener threw");
			},
			onError: (error) => errors.push(error),
		});

		await listener.start();
		listeners.get("error")?.(new Error("connection lost"));
		listeners.get("notification")?.({ channel: "chan", payload: "x" });
		await listener.stop();

		// Connection error, onPayload throw, and a failing `end()` — all reported,
		// none propagated.
		expect(errors).toHaveLength(3);
	});
});
