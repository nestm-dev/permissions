// D4: a `PolicyStore` that routes by scope.
//
// The motivating shape is the station migration: operator policies are owned by
// code and live in a `MemoryPolicyStore` under the `'instance'` scope, while
// every tenant scope is served by the database store. Composing them here keeps
// that a wiring decision instead of a branch inside the engine.

import { fail, invariant } from "../util/assert.ts";
import type {
	PolicyBundle,
	PolicyChangeListener,
	PolicyRecord,
	PolicyScopeId,
	PolicyStore,
	TemplateLinkRecord,
	Unsubscribe,
} from "./policy-store.ts";

/** Construction options for {@link CompositePolicyStore}. */
export interface CompositePolicyStoreOptions {
	/** Exact-match routes, keyed by scope id (`''` routes the global scope). */
	readonly routes?: Readonly<Record<PolicyScopeId, PolicyStore>>;
	/** Store for every scope no route matches — the `'*'` route. */
	readonly fallback?: PolicyStore;
}

/**
 * Routes every {@link PolicyStore} operation to a child store: exact scope match
 * first, then the `fallback`.
 *
 * - reads and writes route identically, so a scope's policies always come from
 *   and go to the same store;
 * - `watch` fans in from every child that supports it, deduplicated by store
 *   identity, and the returned unsubscribe cancels all of them;
 * - `watch` is **absent** when no child supports it, which is what keeps the
 *   D1 contract honest: the cache must not trust events from a composite whose
 *   children cannot emit any;
 * - a scope matching no route and no fallback throws `POLICY_STORE`.
 *
 * Composition of the global scope into a tenant bundle (**D2**) stays the child
 * store's job — this class never merges bundles.
 */
export class CompositePolicyStore implements PolicyStore {
	readonly #routes: Map<PolicyScopeId, PolicyStore>;
	readonly #fallback: PolicyStore | undefined;

	/**
	 * {@inheritDoc PolicyStore.watch}
	 *
	 * Assigned in the constructor only when at least one child store can emit.
	 */
	declare readonly watch?: (listener: PolicyChangeListener) => Unsubscribe;

	constructor(options: CompositePolicyStoreOptions = {}) {
		this.#routes = new Map(Object.entries(options.routes ?? {}));
		this.#fallback = options.fallback;

		invariant(
			this.#routes.size > 0 || this.#fallback !== undefined,
			"POLICY_STORE",
			"CompositePolicyStore needs at least one route or a fallback store.",
		);

		if (this.#watchableStores().length > 0) {
			// Defined as an own property rather than a prototype method so that
			// `'watch' in store` and `store.watch !== undefined` both answer
			// truthfully for a composite whose children cannot emit.
			Object.defineProperty(this, "watch", {
				value: (listener: PolicyChangeListener): Unsubscribe => this.#watchAll(listener),
				enumerable: false,
				writable: false,
			});
		}
	}

	/** Scope ids with an exact route, sorted. */
	get routedScopes(): readonly PolicyScopeId[] {
		return [...this.#routes.keys()].toSorted();
	}

	/** Whether a fallback store was configured. */
	get hasFallback(): boolean {
		return this.#fallback !== undefined;
	}

	/**
	 * The store serving `scope`.
	 *
	 * @throws `PermissionsError` with code `POLICY_STORE` when nothing routes it.
	 */
	storeFor(scope: PolicyScopeId): PolicyStore {
		const routed = this.#routes.get(scope) ?? this.#fallback;
		if (routed === undefined) {
			return fail(
				"POLICY_STORE",
				`No policy store routes the scope "${scope}". Configured routes: ` +
					`[${this.routedScopes.map((entry) => `"${entry}"`).join(", ")}]; no fallback.`,
				{ scope },
			);
		}
		return routed;
	}

	/** {@inheritDoc PolicyStore.load} */
	async load(scope: PolicyScopeId): Promise<PolicyBundle> {
		return this.storeFor(scope).load(scope);
	}

	/** {@inheritDoc PolicyStore.currentVersion} */
	async currentVersion(scope: PolicyScopeId): Promise<string> {
		return this.storeFor(scope).currentVersion(scope);
	}

	/**
	 * {@inheritDoc PolicyStore.save}
	 *
	 * Records are grouped by scope and each group is routed like a read. The
	 * groups are written one after another in scope order: this is a router, not
	 * a transaction, so the ordering is at least deterministic.
	 */
	async save(policies: readonly PolicyRecord[]): Promise<void> {
		const grouped = new Map<PolicyScopeId, PolicyRecord[]>();

		for (const record of policies) {
			const bucket = grouped.get(record.scope);
			if (bucket === undefined) {
				grouped.set(record.scope, [record]);
			} else {
				bucket.push(record);
			}
		}

		for (const scope of [...grouped.keys()].toSorted()) {
			await this.storeFor(scope).save(grouped.get(scope) ?? []);
		}
	}

	/** {@inheritDoc PolicyStore.delete} */
	async delete(scope: PolicyScopeId, ids: readonly string[]): Promise<void> {
		await this.storeFor(scope).delete(scope, ids);
	}

	/** {@inheritDoc PolicyStore.linkTemplate} */
	async linkTemplate(link: TemplateLinkRecord): Promise<void> {
		await this.storeFor(link.scope).linkTemplate(link);
	}

	/** {@inheritDoc PolicyStore.unlinkTemplate} */
	async unlinkTemplate(scope: PolicyScopeId, linkId: string): Promise<void> {
		await this.storeFor(scope).unlinkTemplate(scope, linkId);
	}

	#watchableStores(): readonly PolicyStore[] {
		const seen = new Set<PolicyStore>();

		for (const store of [...this.#routes.values(), this.#fallback]) {
			// Identity dedup: the same store is routinely both a route and the
			// fallback, and a doubled subscription would double every event.
			if (store !== undefined && typeof store.watch === "function") {
				seen.add(store);
			}
		}

		return [...seen];
	}

	#watchAll(listener: PolicyChangeListener): Unsubscribe {
		const unsubscribes: Unsubscribe[] = [];

		for (const store of this.#watchableStores()) {
			if (store.watch !== undefined) {
				unsubscribes.push(store.watch(listener));
			}
		}

		let active = true;
		return () => {
			if (!active) {
				return;
			}
			active = false;
			for (const unsubscribe of unsubscribes) {
				unsubscribe();
			}
		};
	}
}
