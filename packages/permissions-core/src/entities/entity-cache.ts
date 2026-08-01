// The optional cross-request entity cache.
//
// core.md §4 describes entity memoisation as two tiers, and only one of them
// lives here:
//
//   1. **Per request** — resolve the principal graph once and reuse it for every
//      decision in that request (check + plan + a batch of checks). That tier is
//      the *caller's* job: the engine does it inside one `checkMany` call, and
//      the NestJS guard does it across one HTTP request by resolving once and
//      passing `entities` explicitly. Nothing here is needed for it.
//
//   2. **Across requests** — this file. It is **off by default** (`entityCache:
//      false`) because it trades correctness latency for speed: a role granted in
//      the identity system becomes visible to Cedar only after the entry expires.
//      `PolicyChangeEvent`s invalidate it (the engine wires that up), but a
//      *membership* change that never touches a policy does not emit one.
//
// Enable it when principal resolution is expensive and a `ttlMs` window of stale
// ancestors is acceptable. Do not enable it and then reason about grants as if
// they were immediate.

import type { EntityRef } from "../cedar/uid.ts";
import type { PolicyScopeId } from "../policy/policy-store.ts";
import { LruCache } from "../util/lru.ts";
import type { EntityGraph } from "./entity-provider.ts";

/** Default lifetime of a cached entity graph. */
export const DEFAULT_ENTITY_CACHE_TTL_MS = 30_000;

/** Default number of graphs held at once. */
export const DEFAULT_ENTITY_CACHE_MAX_ENTRIES = 2048;

/** Construction options for {@link EntityCache}. */
export interface EntityCacheOptions {
	/** Entry lifetime in milliseconds. Default {@link DEFAULT_ENTITY_CACHE_TTL_MS}. */
	readonly ttlMs?: number;
	/** Maximum number of entries. Default {@link DEFAULT_ENTITY_CACHE_MAX_ENTRIES}. */
	readonly maxEntries?: number;
	/** Clock in milliseconds. Defaults to `Date.now`. Test seam. */
	readonly clock?: () => number;
}

/** Counters reported by {@link EntityCache.stats}. */
export interface EntityCacheStats {
	/** Reads served from a live entry. */
	readonly hits: number;
	/** Reads that found nothing, or found an expired entry. */
	readonly misses: number;
	/** Entries dropped because their TTL had passed when they were read. */
	readonly expirations: number;
	/** Entries dropped by `invalidate`/`invalidateEntity`/`clear`. */
	readonly invalidations: number;
	/** Entries dropped by capacity pressure. */
	readonly evictions: number;
	/** Entries currently held. */
	readonly entries: number;
	/** Configured capacity. */
	readonly maxEntries: number;
	/** Configured entry lifetime. */
	readonly ttlMs: number;
}

interface CacheEntry {
	readonly scope: PolicyScopeId;
	readonly type: string;
	readonly id: string;
	readonly graph: EntityGraph;
	readonly expiresAt: number;
}

/**
 * Process-level LRU over resolved entity graphs, keyed `${scope}:${type}:${id}`
 * with a TTL.
 *
 * The engine populates it with **principal** graphs only. A principal graph is
 * the expensive one (roles, groups, organisation) and the one reused across
 * decisions; a resource graph is per-row and rarely read twice, and sharing one
 * keyspace between the two roles would let a resource graph — which need not
 * carry the principal's role ancestors — be served to a principal lookup.
 * Callers driving the cache themselves should keep that distinction.
 */
export class EntityCache {
	readonly #entries: LruCache<string, CacheEntry>;
	readonly #ttlMs: number;
	readonly #clock: () => number;

	#hits = 0;
	#misses = 0;
	#expirations = 0;
	#invalidations = 0;
	#evictions = 0;

	constructor(options: EntityCacheOptions = {}) {
		this.#ttlMs = options.ttlMs ?? DEFAULT_ENTITY_CACHE_TTL_MS;
		this.#clock = options.clock ?? Date.now;
		this.#entries = new LruCache<string, CacheEntry>({
			max: options.maxEntries ?? DEFAULT_ENTITY_CACHE_MAX_ENTRIES,
			onEvict: (_key, _entry, reason) => {
				if (reason === "capacity") {
					this.#evictions += 1;
				}
			},
		});
	}

	/** Entries currently held, expired ones included until they are read. */
	get size(): number {
		return this.#entries.size;
	}

	/** Configured entry lifetime, in milliseconds. */
	get ttlMs(): number {
		return this.#ttlMs;
	}

	/** The cache key for one reference, as documented on the class. */
	keyFor(scope: PolicyScopeId, ref: EntityRef): string {
		return `${scope}:${ref.type}:${ref.id}`;
	}

	/**
	 * The cached graph for `ref` in `scope`, or `undefined`.
	 *
	 * An expired entry is dropped rather than returned: a stale ancestor set means
	 * stale authorization, and serving it once more to save a lookup is exactly the
	 * trade this cache must not make silently.
	 */
	get(scope: PolicyScopeId, ref: EntityRef): EntityGraph | undefined {
		const key = this.keyFor(scope, ref);
		const entry = this.#entries.get(key);

		if (entry === undefined) {
			this.#misses += 1;
			return undefined;
		}

		if (this.#clock() >= entry.expiresAt) {
			this.#entries.delete(key);
			this.#expirations += 1;
			// `delete` fires `onEvict` with reason `"delete"`, which the listener
			// ignores — an expiry is not capacity pressure.
			this.#misses += 1;
			return undefined;
		}

		this.#hits += 1;
		return entry.graph;
	}

	/** Stores `graph` for `ref` in `scope`, restarting its TTL. */
	set(scope: PolicyScopeId, ref: EntityRef, graph: EntityGraph): void {
		this.#entries.set(this.keyFor(scope, ref), {
			scope,
			type: ref.type,
			id: ref.id,
			graph,
			expiresAt: this.#clock() + this.#ttlMs,
		});
	}

	/**
	 * Drops every entry for `scope`, or for every scope when given `'*'`.
	 *
	 * Wired to `PolicyChangeEvent`s by the engine: a policy that newly traverses a
	 * hierarchy makes a previously-sufficient graph insufficient, so the two caches
	 * have to be invalidated together.
	 */
	// oxlint-disable-next-line typescript/no-redundant-type-constituents -- `PolicyScopeId` widens to `string`, but spelling the sentinel out is the contract
	invalidate(scope: PolicyScopeId | "*"): number {
		return this.#dropWhere((entry) => scope === "*" || entry.scope === scope);
	}

	/**
	 * Drops the cached graph for one entity — in `scope`, or in every scope when
	 * `scope` is omitted.
	 *
	 * The app-callable half of invalidation: membership changes (a role granted, a
	 * member removed) do not move a policy version, so nothing else can know.
	 */
	invalidateEntity(ref: EntityRef, scope?: PolicyScopeId): number {
		return this.#dropWhere(
			(entry) =>
				entry.type === ref.type &&
				entry.id === ref.id &&
				(scope === undefined || entry.scope === scope),
		);
	}

	/** Drops everything. */
	clear(): void {
		this.#invalidations += this.#entries.size;
		this.#entries.clear();
	}

	/** Counter snapshot. */
	stats(): EntityCacheStats {
		return Object.freeze({
			hits: this.#hits,
			misses: this.#misses,
			expirations: this.#expirations,
			invalidations: this.#invalidations,
			evictions: this.#evictions,
			entries: this.#entries.size,
			maxEntries: this.#entries.max,
			ttlMs: this.#ttlMs,
		});
	}

	#dropWhere(predicate: (entry: CacheEntry) => boolean): number {
		const doomed: string[] = [];

		for (const [key, entry] of this.#entries) {
			if (predicate(entry)) {
				doomed.push(key);
			}
		}

		for (const key of doomed) {
			this.#entries.delete(key);
		}

		this.#invalidations += doomed.length;
		return doomed.length;
	}
}
