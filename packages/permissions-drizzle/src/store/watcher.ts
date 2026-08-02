// The invalidation channel: a version-stamp poller, plus an optional
// `LISTEN`/`NOTIFY` subscription.
//
// Three rules make this component boring in the right way, and all three are
// about what happens when the database is *unhappy*:
//
//   1. **A failed tick never touches the observed-version snapshot.** The next tick asks the
//      same question again, so nothing is skipped. The alternative — advancing
//      observed state optimistically — loses an invalidation permanently and the cache
//      serves the pre-change policy set until the next unrelated write.
//   2. **A failed tick never clears anything.** Stale-but-known beats empty:
//      an empty policy set is `deny`, so "the poller could not reach the
//      database" would become a site-wide outage rather than a delay.
//   3. **Nothing here can crash the process.** Every path is wrapped and routed
//      to `onError`; an unhandled rejection in a background timer takes the
//      whole application down, which is a far worse failure than a late cache.
//
// Backoff is exponential from the configured interval and capped, so a database
// that is down for an hour is polled ~60 times rather than ~720.

import {
	MAX_POLL_BACKOFF_MS,
	type PolicyNotifyClient,
	type PolicyNotifyOptions,
} from "./options.ts";

/** A `setTimeout`-shaped seam. Injected by the tests to drive ticks deterministically. */
export interface WatcherTimers {
	setTimeout(handler: () => void, delayMs: number): unknown;
	clearTimeout(handle: unknown): void;
}

const defaultTimers: WatcherTimers = {
	setTimeout(handler, delayMs) {
		const handle = setTimeout(handler, delayMs);
		// A background poller must not be the reason `node index.js` refuses to exit.
		handle.unref?.();
		return handle;
	},
	clearTimeout(handle) {
		clearTimeout(handle as ReturnType<typeof setTimeout>);
	},
};

/** Construction options for {@link PolicyChangeWatcher}. */
export interface PolicyChangeWatcherOptions {
	/** Base delay between successful ticks, in milliseconds. */
	readonly intervalMs: number;
	/** Runs once before the first tick — seeds the observed state. */
	readonly seed: () => Promise<void>;
	/** One poll. Emits whatever it found; must not swallow its own errors. */
	readonly tick: () => Promise<void>;
	/** Where failures go. */
	readonly onError?: (error: unknown) => void;
	/** Timer seam. Defaults to the global `setTimeout`/`clearTimeout`. */
	readonly timers?: WatcherTimers;
	/** Backoff ceiling. Defaults to {@link MAX_POLL_BACKOFF_MS}. */
	readonly maxBackoffMs?: number;
}

/**
 * Drives {@link PolicyChangeWatcherOptions.tick} on an interval, with backoff.
 *
 * Chained `setTimeout` rather than `setInterval`: a tick slower than the
 * interval would otherwise stack, and a database under load would get more
 * queries exactly when it can least afford them.
 */
export class PolicyChangeWatcher {
	readonly #options: PolicyChangeWatcherOptions;
	readonly #timers: WatcherTimers;
	#handle: unknown;
	#running = false;
	#seeded = false;
	#consecutiveFailures = 0;

	constructor(options: PolicyChangeWatcherOptions) {
		this.#options = options;
		this.#timers = options.timers ?? defaultTimers;
	}

	/** Consecutive failed ticks. Zero after any success. */
	get consecutiveFailures(): number {
		return this.#consecutiveFailures;
	}

	/** Delay before the next tick, given the current failure count. */
	get nextDelayMs(): number {
		if (this.#consecutiveFailures === 0) {
			return this.#options.intervalMs;
		}
		const ceiling = this.#options.maxBackoffMs ?? MAX_POLL_BACKOFF_MS;
		// `2 ** n` grows fast enough to be useful and is capped immediately after,
		// so the exponent never needs a bound of its own.
		const backoff = this.#options.intervalMs * 2 ** Math.min(this.#consecutiveFailures, 30);
		return Math.min(backoff, ceiling);
	}

	/** Whether the loop is scheduled. */
	get running(): boolean {
		return this.#running;
	}

	/** Starts the loop. Idempotent. */
	start(): void {
		if (this.#running) {
			return;
		}
		this.#running = true;
		this.#schedule(0);
	}

	/** Stops the loop. Idempotent; a tick already in flight still finishes. */
	stop(): void {
		this.#running = false;
		if (this.#handle !== undefined) {
			this.#timers.clearTimeout(this.#handle);
			this.#handle = undefined;
		}
	}

	/**
	 * Runs one tick synchronously with respect to the caller, seeding first if
	 * needed. Exposed for tests; the loop uses the same path.
	 */
	async runOnce(): Promise<void> {
		if (!this.#seeded) {
			await this.#options.seed();
			this.#seeded = true;
		}
		await this.#options.tick();
	}

	#schedule(delayMs: number): void {
		if (!this.#running) {
			return;
		}
		this.#handle = this.#timers.setTimeout(() => {
			this.#handle = undefined;
			// The returned promise is deliberately not awaited by anything: this is
			// the top of a background chain, and `#runAndReschedule` never rejects.
			void this.#runAndReschedule();
		}, delayMs);
	}

	async #runAndReschedule(): Promise<void> {
		try {
			await this.runOnce();
			this.#consecutiveFailures = 0;
		} catch (error) {
			// Note what does *not* happen here: the observed state is untouched (it lives
			// in `tick`'s closure and is only advanced on success) and no cache is
			// cleared. The next tick re-asks the same question.
			this.#consecutiveFailures += 1;
			this.#report(error);
		}
		this.#schedule(this.nextDelayMs);
	}

	#report(error: unknown): void {
		try {
			this.#options.onError?.(error);
		} catch {
			// An `onError` that throws must not take the loop with it. There is
			// nowhere left to report to, so this is the one place that swallows.
		}
	}
}

// ---------------------------------------------------------------------------
// LISTEN / NOTIFY
// ---------------------------------------------------------------------------

/** Construction options for {@link PolicyNotifyListener}. */
export interface PolicyNotifyListenerOptions {
	readonly notify: PolicyNotifyOptions;
	/** Called with the payload of each notification on the channel. */
	readonly onPayload: (payload: string) => void;
	readonly onError?: (error: unknown) => void;
}

const CHANNEL_NAME = /^[A-Za-z_][A-Za-z0-9_$]*$/;

/**
 * Holds a dedicated connection open on `LISTEN <channel>`.
 *
 * Separate from the pool by construction (the caller supplies the client), and
 * separate from the poller by design: `NOTIFY` is best-effort — it is lost if no
 * one is listening at that instant, and a dropped connection loses every
 * notification until it reconnects — so it *accelerates* invalidation rather
 * than replacing the poll. Leaving `poll: false` alongside `notify` is supported
 * but means a missed notification is never recovered.
 */
export class PolicyNotifyListener {
	readonly #options: PolicyNotifyListenerOptions;
	#client: PolicyNotifyClient | undefined;
	#started = false;

	constructor(options: PolicyNotifyListenerOptions) {
		const channel = options.notify.channel;
		if (!CHANNEL_NAME.test(channel)) {
			throw new TypeError(
				`notify.channel must be a plain SQL identifier, received ${JSON.stringify(channel)}. ` +
					`It is concatenated into LISTEN, which takes no bind parameter.`,
			);
		}
		this.#options = options;
	}

	/** Connects and issues `LISTEN`. Idempotent. */
	async start(): Promise<void> {
		if (this.#started) {
			return;
		}
		this.#started = true;

		const client = await this.#options.notify.client();
		this.#client = client;

		client.on("error", (error) => {
			this.#options.onError?.(error);
		});
		client.on("notification", (message) => {
			if (message.channel !== this.#options.notify.channel) {
				return;
			}
			try {
				this.#options.onPayload(message.payload ?? "");
			} catch (error) {
				this.#options.onError?.(error);
			}
		});

		await client.connect();
		await client.query(`LISTEN "${this.#options.notify.channel}"`);
	}

	/** Ends the dedicated connection. Idempotent. */
	async stop(): Promise<void> {
		const client = this.#client;
		this.#client = undefined;
		this.#started = false;
		if (client === undefined) {
			return;
		}
		try {
			await client.end();
		} catch (error) {
			this.#options.onError?.(error);
		}
	}
}
