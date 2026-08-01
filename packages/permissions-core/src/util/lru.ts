// A dependency-free LRU keyed on insertion order.
//
// `Map` already keeps insertion order, so "least recently used" is "first key"
// as long as every read re-inserts. That is the whole implementation; the part
// that matters is `onEvict`, because the policy-set cache uses it to run the
// verified evict-by-empty-overwrite against the Cedar WASM.

import { invariant } from "./assert.ts";

/** Why an entry left the cache. */
export type LruEvictionReason =
	/** Pushed out because {@link LruCacheOptions.max} was exceeded. */
	| "capacity"
	/** Removed by an explicit {@link LruCache.delete}. */
	| "delete"
	/** Removed by {@link LruCache.clear}. */
	| "clear";

/** Called for every entry that leaves the cache. */
export type LruEvictionListener<K, V> = (key: K, value: V, reason: LruEvictionReason) => void;

/** Construction options for {@link LruCache}. */
export interface LruCacheOptions<K, V> {
	/** Maximum number of live entries. Must be a positive integer. */
	readonly max: number;
	/**
	 * Invoked synchronously for every evicted entry.
	 *
	 * Deliberately **not** invoked when {@link LruCache.set} replaces the value of
	 * an existing key: the policy-set cache replaces an entry on every reload, and
	 * releasing the WASM policy-set id there would empty the set it just prepared.
	 */
	readonly onEvict?: LruEvictionListener<K, V>;
}

/**
 * A small LRU map.
 *
 * `get` refreshes recency; `peek` deliberately does not, so diagnostics and
 * internal bookkeeping cannot reorder the eviction queue.
 */
export class LruCache<K, V> {
	readonly #entries = new Map<K, V>();
	readonly #max: number;
	readonly #onEvict: LruEvictionListener<K, V> | undefined;

	constructor(options: LruCacheOptions<K, V>) {
		invariant(
			Number.isInteger(options.max) && options.max > 0,
			"ENGINE_INIT",
			`LruCache requires a positive integer max, received ${String(options.max)}.`,
		);
		this.#max = options.max;
		this.#onEvict = options.onEvict;
	}

	/** Maximum number of live entries. */
	get max(): number {
		return this.#max;
	}

	/** Number of live entries. */
	get size(): number {
		return this.#entries.size;
	}

	/** Whether `key` is present. Does not refresh recency. */
	has(key: K): boolean {
		return this.#entries.has(key);
	}

	/** Reads `key` without refreshing recency. */
	peek(key: K): V | undefined {
		return this.#entries.get(key);
	}

	/** Reads `key` and marks it most-recently-used. */
	get(key: K): V | undefined {
		if (!this.#entries.has(key)) {
			return undefined;
		}
		const value = this.#entries.get(key) as V;
		this.#entries.delete(key);
		this.#entries.set(key, value);
		return value;
	}

	/**
	 * Inserts or replaces `key` and marks it most-recently-used, evicting the
	 * least-recently-used entries until the cache fits in {@link max}.
	 */
	set(key: K, value: V): this {
		this.#entries.delete(key);
		this.#entries.set(key, value);

		while (this.#entries.size > this.#max) {
			const oldest = this.#entries.keys().next();
			if (oldest.done === true) {
				break;
			}
			this.#evict(oldest.value, "capacity");
		}

		return this;
	}

	/** Removes `key`, firing `onEvict` with reason `"delete"`. */
	delete(key: K): boolean {
		if (!this.#entries.has(key)) {
			return false;
		}
		this.#evict(key, "delete");
		return true;
	}

	/** Removes every entry, firing `onEvict` with reason `"clear"`, oldest first. */
	clear(): void {
		// Emptied before the listeners run, so a listener that inspects the cache
		// never observes a half-cleared one.
		const snapshot = Array.from(this.#entries);
		this.#entries.clear();

		for (const [key, value] of snapshot) {
			this.#onEvict?.(key, value, "clear");
		}
	}

	/** Keys, least-recently-used first. */
	keys(): IterableIterator<K> {
		return this.#entries.keys();
	}

	/** Values, least-recently-used first. */
	values(): IterableIterator<V> {
		return this.#entries.values();
	}

	/** Entries, least-recently-used first. */
	entries(): IterableIterator<[K, V]> {
		return this.#entries.entries();
	}

	/** Entries, least-recently-used first. */
	[Symbol.iterator](): IterableIterator<[K, V]> {
		return this.#entries.entries();
	}

	#evict(key: K, reason: LruEvictionReason): void {
		const value = this.#entries.get(key) as V;
		this.#entries.delete(key);
		this.#onEvict?.(key, value, reason);
	}
}
