// The multi-tenant preparse cache.
//
// Everything in this file follows from four measured facts about cedar-wasm
// (docs/design/core.md §0):
//
//   1. `statefulIsAuthorized` is 14.6x faster than `isAuthorized`, so every
//      check must run against a *preparsed* policy set.
//   2. There is no unregister API, and 2000 distinct preparsed ids cost +126 MB
//      RSS. Ids are therefore `${instanceId}:${scope}` — stable per scope,
//      **never** version-suffixed.
//   3. Re-preparsing the *same* id frees the previous set (+6 MB for 2000
//      rewrites). Staleness is handled by overwriting in place.
//   4. `preparsePolicySet(id, { staticPolicies: {} })` frees the slot. That is
//      the only eviction primitive there is, and it is what `evict`, the LRU's
//      `onEvict` and `dispose` all call.
//
// Freshness follows **D1**: with a watching store, `currentVersion` is never
// called on the hit path — events mark entries stale. Without one, entries are
// revalidated after `staleAfterMs`.

import type { CedarBinding, PolicySet } from "../cedar/binding.ts";
import { unwrapCheckParse } from "../cedar/answers.ts";
import { PermissionsError } from "../diagnostics/errors.ts";
import { buildPolicySet } from "../policy/policy-set-builder.ts";
import type {
	PolicyBundle,
	PolicyChangeEvent,
	PolicyScopeId,
	PolicyStore,
	Unsubscribe,
} from "../policy/policy-store.ts";
import { fail } from "../util/assert.ts";
import { LruCache } from "../util/lru.ts";
import { SingleFlight } from "../util/single-flight.ts";

/** Default number of scopes kept preparsed at once. */
export const DEFAULT_MAX_SCOPES = 256;

/** Default revalidation interval used only when the store cannot `watch`. */
export const DEFAULT_STALE_AFTER_MS = 30_000;

/** Separator between the instance id and the scope in a WASM policy-set id. */
export const PSET_ID_SEPARATOR = ":";

/** Construction options for {@link PolicySetCache}. */
export interface PolicySetCacheOptions {
	/** Cedar binding to preparse against. */
	readonly binding: CedarBinding;
	/** Store the bundles are loaded from. */
	readonly store: PolicyStore;
	/**
	 * Prefix of every WASM policy-set id this cache owns.
	 *
	 * Must be unique per engine instance in the process: two engines sharing a
	 * prefix would overwrite each other's preparsed sets.
	 */
	readonly instanceId: string;
	/** Maximum number of simultaneously preparsed scopes. Default {@link DEFAULT_MAX_SCOPES}. */
	readonly maxScopes?: number;
	/**
	 * How long a prepared entry is trusted when the store has no `watch`.
	 * Default {@link DEFAULT_STALE_AFTER_MS}. Ignored entirely when it does.
	 */
	readonly staleAfterMs?: number;
	/** Vocabulary namespace used to qualify template-link entity refs. */
	readonly namespace?: string;
	/** Monotonic clock in milliseconds. Defaults to `Date.now`. Test seam. */
	readonly clock?: () => number;
	/**
	 * Called with every freshly compiled policy set, **before** it is preparsed.
	 *
	 * Throwing rejects the load: nothing is preparsed, the entry is left exactly as
	 * it was, and the error reaches the caller that triggered the reload. That is
	 * the whole point — a policy set that fails an admission check must not replace
	 * a working one, and the previously prepared set stays resident and serviceable.
	 *
	 * Deliberately generic. The engine uses it for `validateOnLoad` (Cedar's
	 * `validate()` against the vocabulary's schema); a host could use it for a
	 * policy-count budget or a signature check with no change here.
	 */
	readonly onPolicySetBuilt?: (set: PolicySet, scope: PolicyScopeId) => void;
}

/** What {@link PolicySetCache.ensure} hands back to the engine. */
export interface PolicySetHandle {
	/** WASM policy-set id to pass as `preparsedPolicySetId`. */
	readonly psetId: string;
	/** Version of the bundle currently prepared under {@link psetId}. */
	readonly version: string;
	/** `'miss'` when this call loaded and preparsed; `'hit'` otherwise. */
	readonly cache: "hit" | "miss";
}

/** Diagnostic view of one cached scope. */
export interface PolicySetEntryView {
	/** Scope the entry belongs to. */
	readonly scope: PolicyScopeId;
	/** Bundle version currently prepared. */
	readonly version: string;
	/** Clock reading of the last successful preparse or revalidation. */
	readonly preparedAt: number;
	/** Clock reading of the last `ensure` that used it. */
	readonly lastUsedAt: number;
	/** Whether the next `ensure` must reload before serving it. */
	readonly stale: boolean;
}

/** Counters reported by {@link PolicySetCache.stats}. */
export interface PolicySetCacheStats {
	/** `ensure`/`warm` calls served without reloading. */
	readonly hits: number;
	/** `ensure`/`warm` calls that had to load and preparse. */
	readonly misses: number;
	/** Policy-set ids released by LRU pressure, `evict` or `dispose`. */
	readonly evictions: number;
	/** Scopes currently held. */
	readonly scopes: number;
	/** `preparsePolicySet` calls made to *populate* a set (excludes evictions). */
	readonly preparses: number;
	/** `store.load` calls made. */
	readonly loads: number;
	/** `store.currentVersion` probes made. */
	readonly revalidations: number;
	/** Loads or preparses that threw. */
	readonly failures: number;
	/** Loads currently in flight. */
	readonly inFlight: number;
	/** Configured LRU capacity. */
	readonly maxScopes: number;
	/** Whether freshness is event-driven (**D1**) rather than time-based. */
	readonly watching: boolean;
}

interface MutableEntry {
	version: string;
	preparedAt: number;
	lastUsedAt: number;
	stale: boolean;
	/**
	 * The compiled policy set, retained for `isAuthorizedPartial`.
	 *
	 * Partial evaluation takes its policies **inline** — `PartialAuthorizationCall`
	 * has no `preparsedPolicySetId` field — so `plan()` needs this object on every
	 * call. Keeping the reference that `#load` already built costs no extra work
	 * and is bounded by the same `maxScopes` the operator tunes for WASM memory;
	 * the alternative is a `store.load` round-trip per plan, which would defeat D1
	 * and make the plan cache pointless.
	 */
	set: PolicySet;
}

/**
 * Owns the mapping from policy scope to preparsed Cedar policy set.
 *
 * ```ts
 * const cache = new PolicySetCache({ binding, store, instanceId: "engine-1" });
 * const { psetId } = await cache.ensure("org:8f3e");
 * binding.statefulIsAuthorized({ ...call, preparsedPolicySetId: psetId });
 * ```
 *
 * Failure semantics are deliberate: a failed load or preparse leaves the
 * previous entry — and the policy set already resident under its id — untouched,
 * because a stale-but-known policy set is strictly better than an empty one. The
 * error still propagates to the caller that triggered the reload, and the
 * single-flight slot is cleared so the next caller retries rather than
 * inheriting the failure.
 */
export class PolicySetCache {
	readonly #binding: CedarBinding;
	readonly #store: PolicyStore;
	readonly #instanceId: string;
	readonly #namespace: string;
	readonly #staleAfterMs: number;
	readonly #clock: () => number;
	readonly #onPolicySetBuilt: ((set: PolicySet, scope: PolicyScopeId) => void) | undefined;
	readonly #entries: LruCache<PolicyScopeId, MutableEntry>;
	readonly #flight = new SingleFlight<PolicyScopeId, PolicySetHandle>();
	readonly #owned = new Set<string>();
	readonly #watching: boolean;

	#unsubscribe: Unsubscribe | undefined;
	#disposed = false;
	#hits = 0;
	#misses = 0;
	#evictions = 0;
	#preparses = 0;
	#loads = 0;
	#revalidations = 0;
	#failures = 0;

	constructor(options: PolicySetCacheOptions) {
		this.#binding = options.binding;
		this.#store = options.store;
		this.#instanceId = options.instanceId;
		this.#namespace = options.namespace ?? "";
		this.#staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
		this.#clock = options.clock ?? Date.now;
		this.#onPolicySetBuilt = options.onPolicySetBuilt;
		this.#entries = new LruCache<PolicyScopeId, MutableEntry>({
			max: options.maxScopes ?? DEFAULT_MAX_SCOPES,
			// Capacity pressure and explicit deletes both land here, so the
			// evict-by-empty-overwrite happens exactly once per released id.
			onEvict: (scope) => {
				this.#release(scope);
			},
		});

		// D1: subscribing is what buys the right to stop probing `currentVersion`.
		this.#watching = typeof this.#store.watch === "function";
		if (this.#store.watch !== undefined) {
			this.#unsubscribe = this.#store.watch((event) => {
				this.#onChange(event);
			});
		}
	}

	/** Whether freshness is event-driven (**D1**). */
	get watching(): boolean {
		return this.#watching;
	}

	/** Whether {@link dispose} has run. */
	get disposed(): boolean {
		return this.#disposed;
	}

	/**
	 * The WASM policy-set id for `scope`.
	 *
	 * Stable for the lifetime of the process: never suffixed with a version, and
	 * reused verbatim across reloads (fact 2/3 above).
	 */
	psetIdFor(scope: PolicyScopeId): string {
		return `${this.#instanceId}${PSET_ID_SEPARATOR}${scope}`;
	}

	/**
	 * Guarantees a current policy set is preparsed for `scope` and returns its id.
	 *
	 * The hit path does no I/O and — with a watching store — no version probe at
	 * all. A miss or a stale entry goes through a per-scope single flight, so N
	 * concurrent callers on a cold scope produce exactly one `store.load` and one
	 * `preparsePolicySet`.
	 */
	async ensure(scope: PolicyScopeId): Promise<PolicySetHandle> {
		this.#assertActive();

		const entry = this.#entries.get(scope);

		if (entry !== undefined && !entry.stale) {
			const now = this.#clock();

			if (!this.#watching && now - entry.preparedAt >= this.#staleAfterMs) {
				return this.#revalidate(scope);
			}

			entry.lastUsedAt = now;
			this.#hits += 1;
			return { psetId: this.psetIdFor(scope), version: entry.version, cache: "hit" };
		}

		this.#misses += 1;
		return this.#flight.run(scope, async () => this.#load(scope));
	}

	/**
	 * Preloads `scope`, probing `currentVersion` first even when watching.
	 *
	 * This is the explicit freshness flow **D1** carves out: use it at boot or
	 * after an out-of-band write, never per check.
	 */
	async warm(scope: PolicyScopeId): Promise<PolicySetHandle> {
		this.#assertActive();
		return this.#flight.run(scope, async () => this.#probeThenLoad(scope));
	}

	/**
	 * Marks `scope` — or every scope, for `'*'` — as stale.
	 *
	 * Nothing is unloaded: the resident policy set keeps serving until a reload
	 * succeeds, and the next `ensure` performs that reload.
	 */
	// oxlint-disable-next-line typescript/no-redundant-type-constituents -- `PolicyScopeId` widens to `string`, but spelling the sentinel out is the contract
	invalidate(scope: PolicyScopeId | "*"): void {
		if (scope === "*") {
			for (const entry of this.#entries.values()) {
				entry.stale = true;
			}
			return;
		}

		const entry = this.#entries.peek(scope);
		if (entry !== undefined) {
			entry.stale = true;
		}
	}

	/**
	 * Releases `scope`: overwrites its policy set with an empty one (the verified
	 * free primitive) and drops the JS entry.
	 *
	 * A later `ensure` repopulates the *same* id.
	 */
	evict(scope: PolicyScopeId): boolean {
		return this.#entries.delete(scope);
	}

	/**
	 * The compiled `PolicySet` currently prepared for `scope`, or `undefined` when
	 * nothing is resident.
	 *
	 * Exists for `isAuthorizedPartial`, which cannot use the preparse cache and
	 * therefore needs the policies inline on every call. Does not touch recency
	 * and never loads: callers `ensure(scope)` first, which is also what makes the
	 * returned set current.
	 */
	policySetFor(scope: PolicyScopeId): PolicySet | undefined {
		return this.#entries.peek(scope)?.set;
	}

	/** Diagnostic snapshot of one entry, without touching its recency. */
	peek(scope: PolicyScopeId): PolicySetEntryView | undefined {
		const entry = this.#entries.peek(scope);
		if (entry === undefined) {
			return undefined;
		}
		return Object.freeze({
			scope,
			version: entry.version,
			preparedAt: entry.preparedAt,
			lastUsedAt: entry.lastUsedAt,
			stale: entry.stale,
		});
	}

	/** Cached scopes, least-recently-used first. */
	scopes(): readonly PolicyScopeId[] {
		return [...this.#entries.keys()];
	}

	/** Counter snapshot. */
	stats(): PolicySetCacheStats {
		return Object.freeze({
			hits: this.#hits,
			misses: this.#misses,
			evictions: this.#evictions,
			scopes: this.#entries.size,
			preparses: this.#preparses,
			loads: this.#loads,
			revalidations: this.#revalidations,
			failures: this.#failures,
			inFlight: this.#flight.size,
			maxScopes: this.#entries.max,
			watching: this.#watching,
		});
	}

	/**
	 * Unsubscribes from the store and empties every policy-set id this cache
	 * owns. Terminal: a disposed cache throws from `ensure`/`warm`.
	 */
	dispose(): void {
		if (this.#disposed) {
			return;
		}
		this.#disposed = true;

		this.#unsubscribe?.();
		this.#unsubscribe = undefined;

		// `clear` fires `onEvict` per entry, which is what empties each id.
		this.#entries.clear();

		// Anything still owned lost its JS entry to LRU pressure mid-flight.
		for (const psetId of this.#owned) {
			this.#evictions += 1;
			this.#empty(psetId);
		}
		this.#owned.clear();
	}

	#assertActive(): void {
		if (this.#disposed) {
			fail(
				"POLICY_SET_NOT_PREPARED",
				`The policy-set cache for instance "${this.#instanceId}" has been disposed.`,
			);
		}
	}

	#onChange(event: PolicyChangeEvent): void {
		// D2: `'*'` is how a global write reaches every tenant's bundle.
		this.invalidate(event.scope);
	}

	async #probeThenLoad(scope: PolicyScopeId): Promise<PolicySetHandle> {
		const entry = this.#entries.peek(scope);

		if (entry === undefined || entry.stale) {
			this.#misses += 1;
			return this.#load(scope);
		}

		this.#revalidations += 1;
		const version = await this.#probe(scope);

		if (version === entry.version) {
			const now = this.#clock();
			entry.preparedAt = now;
			entry.lastUsedAt = now;
			this.#hits += 1;
			return { psetId: this.psetIdFor(scope), version, cache: "hit" };
		}

		this.#misses += 1;
		return this.#load(scope);
	}

	#revalidate(scope: PolicyScopeId): Promise<PolicySetHandle> {
		return this.#flight.run(scope, async () => this.#probeThenLoad(scope));
	}

	async #probe(scope: PolicyScopeId): Promise<string> {
		try {
			return await this.#store.currentVersion(scope);
		} catch (error) {
			this.#failures += 1;
			throw this.#storeError(error, scope, "read the current policy version for");
		}
	}

	async #load(scope: PolicyScopeId): Promise<PolicySetHandle> {
		const psetId = this.psetIdFor(scope);

		let bundle: PolicyBundle;
		try {
			this.#loads += 1;
			bundle = await this.#store.load(scope);
		} catch (error) {
			this.#failures += 1;
			// The previous entry (and the policy set resident under `psetId`) is
			// left exactly as it was: stale-but-known beats empty.
			throw this.#storeError(error, scope, "load policies for");
		}

		let set: PolicySet;
		try {
			set = buildPolicySet(bundle, { namespace: this.#namespace });
			// Admission check before anything reaches the WASM: a rejected set must
			// leave the resident one untouched, which it does precisely because
			// nothing has been preparsed yet at this point.
			this.#onPolicySetBuilt?.(set, scope);
		} catch (error) {
			this.#failures += 1;
			throw error;
		}

		try {
			this.#preparses += 1;
			unwrapCheckParse(this.#binding.preparsePolicySet(psetId, set), {
				code: "POLICY_INVALID",
				message: `Cedar rejected the policy set for scope "${scope}"`,
				scope,
			});
		} catch (error) {
			this.#failures += 1;
			throw error;
		}

		if (this.#disposed) {
			// Disposed while this load was in flight — do not leak the id.
			this.#empty(psetId);
			this.#assertActive();
		}

		this.#owned.add(psetId);
		const now = this.#clock();
		// `set` on an existing key replaces without firing `onEvict`, so this can
		// never release the id it just prepared.
		this.#entries.set(scope, {
			version: bundle.version,
			preparedAt: now,
			lastUsedAt: now,
			stale: false,
			set,
		});

		return { psetId, version: bundle.version, cache: "miss" };
	}

	#release(scope: PolicyScopeId): void {
		const psetId = this.psetIdFor(scope);
		if (!this.#owned.delete(psetId)) {
			return;
		}
		this.#evictions += 1;
		this.#empty(psetId);
	}

	#empty(psetId: string): void {
		// The verified free primitive. Failure here would leak WASM memory
		// silently, so it throws rather than being swallowed.
		unwrapCheckParse(this.#binding.preparsePolicySet(psetId, { staticPolicies: {} }), {
			code: "POLICY_INVALID",
			message: `Cedar rejected the empty policy set used to evict "${psetId}"`,
		});
	}

	#storeError(error: unknown, scope: PolicyScopeId, action: string): Error {
		if (error instanceof PermissionsError) {
			return error;
		}
		return new PermissionsError(
			"POLICY_STORE",
			`The policy store failed to ${action} scope "${scope}": ${
				error instanceof Error ? error.message : String(error)
			}`,
			{ cause: error, scope },
		);
	}
}
