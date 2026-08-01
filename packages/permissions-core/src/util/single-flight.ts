// Keyed in-flight deduplication.
//
// A cold tenant that takes 200 concurrent requests must load its policies once,
// not 200 times — and, more importantly, must call `preparsePolicySet` once,
// since every extra preparse is WASM linear memory that is never returned.

/**
 * Deduplicates concurrent async work by key.
 *
 * The tracked promise is dropped as soon as it settles — on success *and* on
 * failure. A rejected load therefore never poisons the key: the next caller
 * starts a fresh attempt instead of inheriting the old error.
 */
export class SingleFlight<K, V> {
	readonly #inFlight = new Map<K, Promise<V>>();

	/**
	 * Runs `factory` for `key`, or joins the run already in flight for it.
	 *
	 * `factory` is invoked synchronously for the first caller, so a caller that
	 * checked a cache immediately before calling cannot be interleaved with
	 * another caller's completion.
	 */
	run(key: K, factory: () => Promise<V>): Promise<V> {
		const existing = this.#inFlight.get(key);
		if (existing !== undefined) {
			return existing;
		}

		let started: Promise<V>;
		try {
			started = factory();
		} catch (error) {
			// A synchronous throw is still a failed attempt, never a stuck key.
			return Promise.reject(error instanceof Error ? error : new Error(String(error)));
		}

		const tracked = started.finally(() => {
			// Only drop our own entry: a later `run` for the same key may already
			// have installed a newer promise.
			if (this.#inFlight.get(key) === tracked) {
				this.#inFlight.delete(key);
			}
		});

		this.#inFlight.set(key, tracked);
		return tracked;
	}

	/** Whether a run is currently in flight for `key`. */
	has(key: K): boolean {
		return this.#inFlight.has(key);
	}

	/** Number of runs currently in flight. */
	get size(): number {
		return this.#inFlight.size;
	}

	/** Keys currently in flight. */
	keys(): IterableIterator<K> {
		return this.#inFlight.keys();
	}
}
