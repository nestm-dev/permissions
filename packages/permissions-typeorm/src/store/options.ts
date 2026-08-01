// Driver options shared by the store and the watcher.
//
// The shape is deliberately the same as `@nestm/permissions-drizzle`'s
// `PolicyStoreDriverOptions`: an application that swaps drivers should change an
// import and a constructor argument, not re-learn how to configure a poller.

import type { PermissionsEntities, ScopeColumnOptions } from "../entities/create-entities.ts";

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
 * this package: TypeORM brings whichever driver the consumer configured, and
 * adding a hard dependency here to type one optional feature would put a second
 * copy of `pg` in every install.
 */
export interface PolicyNotifyClient {
	// `Promise<unknown>` rather than `Promise<void>`: `pg.Client.connect()` resolves
	// to the client itself, and a structural type that a real `pg.Client` is not
	// assignable to would be a structural type for nothing.
	connect(): Promise<unknown>;
	query(text: string): Promise<unknown>;
	on(event: "notification", listener: (message: PolicyNotifyMessage) => void): unknown;
	on(event: "error", listener: (error: Error) => void): unknown;
	end(): Promise<unknown>;
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
	 * delivering notifications with no error anywhere. TypeORM's own pool is
	 * therefore not usable for this, and the store will not take a connection from
	 * it — you pass one you own, and `dispose()` ends it.
	 *
	 * ```ts
	 * notify: { channel: "nestm_permissions", client: () => new Client(process.env.DATABASE_URL) }
	 * ```
	 */
	readonly client: () => PolicyNotifyClient | Promise<PolicyNotifyClient>;
}

/** Options `TypeOrmPolicyStore` accepts. */
export interface PolicyStoreDriverOptions {
	/**
	 * The three entity schemas.
	 *
	 * Defaults to `createPermissionsEntities({ tablePrefix, scopeColumn })`. They
	 * are resolved against the `DataSource` **by entity name**, so a consumer who
	 * declared their own equally-named schemas (or registered the factory's output
	 * from a different module instance) is served correctly.
	 */
	readonly entities?: PermissionsEntities;
	/**
	 * Table-name prefix, when `entities` is not given. Default `'permission_'`.
	 *
	 * Ignored when `entities` is supplied — the schemas already know their names,
	 * and two sources of truth for a table name is one too many.
	 */
	readonly tablePrefix?: string;
	/**
	 * Scope codec, when `entities` is not given or was not built by the factory.
	 *
	 * Normally unnecessary: the factory attaches the codec to the schemas it builds
	 * and the store reads it back, so the entities and the store cannot drift.
	 */
	readonly scopeColumn?: ScopeColumnOptions<unknown>;
	/**
	 * Invalidation poll. Default `{ intervalMs: 5000 }`; `false` disables it.
	 *
	 * One query per tick regardless of tenant count — `WHERE updated_at > $since`
	 * over the scope-versions table — so the cost is O(changed scopes), not
	 * O(cached scopes).
	 */
	readonly poll?: { readonly intervalMs?: number } | false;
	/** Opt-in `LISTEN`/`NOTIFY`. Off by default; see {@link PolicyNotifyOptions}. */
	readonly notify?: PolicyNotifyOptions;
	/**
	 * Where background failures go.
	 *
	 * The poller must never crash the process and must never clear the cache: a
	 * stale-but-known policy set beats an empty one, so a failed tick logs here,
	 * backs off, and retries with its `since` watermark untouched.
	 */
	readonly onError?: (error: unknown) => void;
}

/** Default poll interval, in milliseconds. */
export const DEFAULT_POLL_INTERVAL_MS = 5000;

/** Longest a failing poller waits between retries, in milliseconds. */
export const MAX_POLL_BACKOFF_MS = 60_000;
