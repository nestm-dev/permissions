// The plan cache (core.md §5.6).
//
// This is not an optimisation. `isAuthorizedPartial` is 2.28 ms/op and
// `PartialAuthorizationCall` has **no `preparsedPolicySetId` field** (verified
// against the shipped `.d.ts`), so a query plan cannot use the preparse cache at
// all — it re-parses the whole policy set on every call, ~17x the cost of a
// stateful check. A JS-side cache is what makes `plan()` affordable per request.
//
// The key is where the correctness lives. It must cover everything that can
// change the residuals:
//
//   instance + scope + policy-set version   the policies themselves
//   action + resource type                  which policies apply
//   canonical context                       context folds into constants
//   vocabulary hash                         the schema requests validate against
//   the resolved entity graph               ** see below **
//
// core.md §5.6 names "principal uid + sorted principal-ancestor uids" for the
// last one. That is not sufficient, and this implementation hashes the whole
// resolved graph instead. A residual folds `principal.<attr>` into a *constant*
// — `resource.organization == principal.organization` compiles to
// `organization == Organization::"o1"` — so two principals with identical
// ancestors but different attributes must not share a plan. Ancestors alone
// would return one tenant's filter for another tenant's user.
//
// Canonicalisation is order-independent in both directions: entities are sorted
// by uid, each entity's parents are sorted, and attribute records go through
// `stableStringify`, which sorts keys. A provider that returns roles in a
// different order on two calls therefore still hits.

import { formatEntityUid, normalizeEntityUid, type EntityRef } from "../cedar/uid.ts";
import type { EntityGraph } from "../entities/entity-provider.ts";
import type { PolicyScopeId } from "../policy/policy-store.ts";
import { sha256Hex, stableStringify } from "../util/hash.ts";
import { LruCache } from "../util/lru.ts";

/** Default number of plans held at once. */
export const DEFAULT_PLAN_CACHE_MAX = 2000;

/** Default entry lifetime. */
export const DEFAULT_PLAN_CACHE_TTL_MS = 30_000;

/** Field separator inside a canonicalised entity. */
const FIELD = "\u0001";
/** Entity separator inside a canonicalised graph. */
const ENTITY = "\u0002";
/** Segment separator inside the cache key. */
const SEGMENT = "\u001f";

/** Everything a plan-cache key is derived from. */
export interface PlanCacheKeyInput {
	/** Engine instance. Two engines in one process must not share plans. */
	readonly instanceId: string;
	/** Policy scope. */
	readonly scope: PolicyScopeId;
	/** Version of the policy bundle the plan would be compiled from. */
	readonly policySetVersion: string;
	/** Principal being planned for. */
	readonly principal: EntityRef<string>;
	/** The resolved entity graph — principal, ancestors, attributes and all. */
	readonly entities: EntityGraph;
	/** Action being planned for. */
	readonly action: string;
	/** Resource type being planned over. */
	readonly resourceType: string;
	/** Request context. Canonicalised, so key order does not matter. */
	readonly context: unknown;
	/** Hash of the vocabulary's Cedar schema. */
	readonly vocabHash: string;
}

/**
 * Order-independent rendering of an entity graph.
 *
 * Exported for the cache-key tests, which assert that two graphs differing only
 * in entity order, parent order or attribute key order produce the same string.
 */
export function canonicalEntityGraph(entities: EntityGraph): string {
	return entities
		.map((entity) => {
			const uid = normalizeEntityUid(entity.uid);
			const parents = entity.parents.map((parent) => formatEntityUid(parent)).toSorted();
			const tags = entity.tags === undefined ? "" : stableStringify(entity.tags);
			return [
				`${uid.type}::${uid.id}`,
				stableStringify(entity.attrs),
				parents.join(","),
				tags,
			].join(FIELD);
		})
		.toSorted()
		.join(ENTITY);
}

/** Derives the cache key. SHA-256, so the key length is bounded whatever the graph size. */
export function planCacheKey(input: PlanCacheKeyInput): string {
	return sha256Hex(
		[
			input.instanceId,
			input.scope,
			input.policySetVersion,
			`${input.principal.type}::${input.principal.id}`,
			canonicalEntityGraph(input.entities),
			input.action,
			input.resourceType,
			stableStringify(input.context),
			input.vocabHash,
		].join(SEGMENT),
	);
}

/** Construction options for {@link PlanCache}. */
export interface PlanCacheOptions {
	/** Maximum entries. Default {@link DEFAULT_PLAN_CACHE_MAX}. */
	readonly max?: number;
	/** Entry lifetime in milliseconds. Default {@link DEFAULT_PLAN_CACHE_TTL_MS}. */
	readonly ttlMs?: number;
	/** Monotonic clock in milliseconds. Defaults to `Date.now`. Test seam. */
	readonly clock?: () => number;
}

/** Counters reported by {@link PlanCache.stats}. */
export interface PlanCacheStats {
	/** Lookups served from the cache. */
	readonly hits: number;
	/** Lookups that found nothing, or found an expired entry. */
	readonly misses: number;
	/** Entries dropped by capacity pressure. */
	readonly evictions: number;
	/** Entries dropped because they were past their TTL when read. */
	readonly expirations: number;
	/** Entries dropped by `invalidate`. */
	readonly invalidations: number;
	/** Entries currently held. */
	readonly entries: number;
	/** Configured capacity. */
	readonly max: number;
	/** Configured entry lifetime. */
	readonly ttlMs: number;
}

interface PlanCacheEntry<V> {
	readonly value: V;
	readonly scope: PolicyScopeId;
	readonly storedAt: number;
}

/**
 * LRU + TTL store for compiled plans, invalidatable per scope.
 *
 * Both bounds matter and for different reasons: the LRU bounds memory in a
 * process with many tenants, and the TTL bounds *staleness* for a store that
 * cannot `watch` — with a watching store, `invalidate(scope)` does the real work
 * and the TTL is only a backstop.
 */
export class PlanCache<V> {
	readonly #entries: LruCache<string, PlanCacheEntry<V>>;
	readonly #ttlMs: number;
	readonly #clock: () => number;

	#hits = 0;
	#misses = 0;
	#evictions = 0;
	#expirations = 0;
	#invalidations = 0;

	constructor(options: PlanCacheOptions = {}) {
		this.#ttlMs = options.ttlMs ?? DEFAULT_PLAN_CACHE_TTL_MS;
		this.#clock = options.clock ?? Date.now;
		this.#entries = new LruCache<string, PlanCacheEntry<V>>({
			max: options.max ?? DEFAULT_PLAN_CACHE_MAX,
			onEvict: (_key, _value, reason) => {
				if (reason === "capacity") {
					this.#evictions += 1;
				}
			},
		});
	}

	/** Entries currently held. */
	get size(): number {
		return this.#entries.size;
	}

	/** Reads `key`, dropping and missing on an expired entry. */
	get(key: string): V | undefined {
		const entry = this.#entries.get(key);

		if (entry === undefined) {
			this.#misses += 1;
			return undefined;
		}

		if (this.#clock() - entry.storedAt >= this.#ttlMs) {
			this.#entries.delete(key);
			this.#expirations += 1;
			this.#misses += 1;
			return undefined;
		}

		this.#hits += 1;
		return entry.value;
	}

	/** Stores `value` under `key`, tagged with the scope that invalidates it. */
	set(key: string, scope: PolicyScopeId, value: V): void {
		this.#entries.set(key, { value, scope, storedAt: this.#clock() });
	}

	/**
	 * Drops every plan compiled in `scope`, or every plan for `'*'`.
	 *
	 * Plans are *dropped*, not marked stale — unlike a preparsed policy set, a
	 * stale plan has no value at all: it filters rows by policies that no longer
	 * apply, which is precisely the over-share this package exists to prevent.
	 *
	 * @returns how many entries were dropped.
	 */
	// oxlint-disable-next-line typescript/no-redundant-type-constituents -- `PolicyScopeId` widens to `string`, but spelling the sentinel out is the contract
	invalidate(scope: PolicyScopeId | "*"): number {
		if (scope === "*") {
			const dropped = this.#entries.size;
			this.#entries.clear();
			this.#invalidations += dropped;
			return dropped;
		}

		const keys: string[] = [];
		for (const [key, entry] of this.#entries) {
			if (entry.scope === scope) {
				keys.push(key);
			}
		}

		for (const key of keys) {
			this.#entries.delete(key);
		}
		this.#invalidations += keys.length;
		return keys.length;
	}

	/** Drops everything without counting it as an invalidation. */
	clear(): void {
		this.#entries.clear();
	}

	/** Counter snapshot. */
	stats(): PlanCacheStats {
		return Object.freeze({
			hits: this.#hits,
			misses: this.#misses,
			evictions: this.#evictions,
			expirations: this.#expirations,
			invalidations: this.#invalidations,
			entries: this.#entries.size,
			max: this.#entries.max,
			ttlMs: this.#ttlMs,
		});
	}
}
