// Driver options shared by the store and the watcher.

import type { ScopeColumnOptions } from "../schema.ts";

/** One `pg` `NOTIFY` payload, narrowed to what this package reads. */
export interface PolicyNotifyMessage {
	/** Channel the notification arrived on. */
	readonly channel: string;
	/** Payload string, if the sender supplied one. */
	readonly payload?: string | undefined;
}

/**
 * The slice of `pg.Client` the LISTEN/NOTIFY path uses.
 *
 * Structural rather than a `pg` import because `pg` is **not** a dependency of
 * this package: `drizzle-orm/node-postgres` works against whatever client the
 * consumer already has, and adding a hard dependency here to type one optional
 * feature would put a second copy of `pg` in every install.
 */
export interface PolicyNotifyClient {
	connect(): Promise<void>;
	query(text: string): Promise<unknown>;
	on(event: "notification", listener: (message: PolicyNotifyMessage) => void): unknown;
	on(event: "error", listener: (error: Error) => void): unknown;
	end(): Promise<void>;
}

/** Opt-in `LISTEN`/`NOTIFY` configuration. */
export interface PolicyNotifyOptions {
	/**
	 * Channel name. Must be a plain SQL identifier — it lands in `LISTEN "<name>"`,
	 * which has no bind parameter.
	 */
	readonly channel: string;
	/**
	 * Produces the **dedicated, non-pooled** connection to listen on.
	 *
	 * A listening connection is occupied for its whole life: it cannot be returned
	 * to a pool, and a pooled connection that is handed out mid-`LISTEN` stops
	 * delivering notifications with no error anywhere. The store will not take one
	 * from your pool for you — you pass one you own, and `dispose()` ends it.
	 *
	 * ```ts
	 * notify: { channel: "nestm_permissions", client: () => new Client(process.env.DATABASE_URL) }
	 * ```
	 */
	readonly client: () => PolicyNotifyClient | Promise<PolicyNotifyClient>;
}

/** Options every driver's `PolicyStore` implementation accepts. */
export interface PolicyStoreDriverOptions {
	/**
	 * Invalidation poll. Default `{ intervalMs: 5000 }`; `false` disables it.
	 *
	 * One query per tick reads `(scope, version)` from the scope-versions table and
	 * compares its monotonic counters with the previous snapshot. Counters avoid
	 * the out-of-order-commit hole of a timestamp watermark; query count remains
	 * constant, while rows returned are O(all scopes).
	 */
	readonly poll?: { readonly intervalMs?: number } | false;
	/** Opt-in `LISTEN`/`NOTIFY`. Off by default; see {@link PolicyNotifyOptions}. */
	readonly notify?: PolicyNotifyOptions;
	/**
	 * Where background failures go.
	 *
	 * The poller must never crash the process and must never clear the cache: a
	 * stale-but-known policy set beats an empty one, so a failed tick logs here,
	 * backs off, and retries with its version snapshot untouched.
	 */
	readonly onError?: (error: unknown) => void;
	/**
	 * Scope codec, when the schema was not built by `createPermissionsSchema`.
	 *
	 * Normally unnecessary: the factory attaches the codec to the tables it builds
	 * and the store reads it back, so the schema and the store cannot drift.
	 */
	readonly scopeColumn?: ScopeColumnOptions<unknown>;
}

/** Default poll interval, in milliseconds. */
export const DEFAULT_POLL_INTERVAL_MS = 5000;

/** Longest a failing poller waits between retries, in milliseconds. */
export const MAX_POLL_BACKOFF_MS = 60_000;
