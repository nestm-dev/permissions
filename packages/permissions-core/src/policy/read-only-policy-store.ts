// The read-only half of the `PolicyStore` SPI, and an adapter onto the full one.
//
// `PolicyStore` has seven members and the engine calls **two** of them on the
// authorization path: `load` and `currentVersion` (`watch` is a subscription, not
// a call). The other four exist for consumers who administer policies through
// this package.
//
// A large class of deployments does not. Station's policies and links are a
// *projection* of its own `roles`/`role_grants` tables, written by the same
// transaction that writes the source row — that is what keeps the projection and
// the source impossible to observe apart, and what preserves the advisory-lock
// protections the source rows already have. For those consumers the four write
// methods are not merely unused; a write arriving through them would be a second,
// unsynchronised write path.
//
// Before this adapter, such a consumer implemented `PolicyStore` and stubbed four
// methods by hand. Every hand-written stub is a decision — throw, or resolve? —
// and the wrong answer is invisible: a `save()` that resolves without writing
// tells its caller the grant landed, and the difference only shows up later as an
// authorization decision that should have changed and did not. This module makes
// the loud answer the default and the only one.

import { PermissionsError } from "../diagnostics/errors.ts";
import type {
	PolicyBundle,
	PolicyChangeListener,
	PolicyRecord,
	PolicyScopeId,
	PolicyStore,
	TemplateLinkRecord,
	Unsubscribe,
} from "./policy-store.ts";

/**
 * The three members a store needs to answer authorization questions.
 *
 * Structurally a `PolicyStore` minus the four write methods, so **every**
 * `PolicyStore` is already a `ReadOnlyPolicyStore` and a function accepting one
 * accepts both.
 *
 * @see {@link readOnlyPolicyStore} to adapt one into a full `PolicyStore`.
 */
export interface ReadOnlyPolicyStore {
	/**
	 * Returns the **effective** bundle for `scope`: global (`''`) ∪ `scope`
	 * (**D2**), with a composite `g<n>:s<m>` version.
	 *
	 * {@inheritDoc PolicyStore.load}
	 */
	load(scope: PolicyScopeId): Promise<PolicyBundle>;

	/**
	 * Cheap freshness probe returning the same version string {@link load} would.
	 *
	 * {@inheritDoc PolicyStore.currentVersion}
	 */
	currentVersion(scope: PolicyScopeId): Promise<string>;

	/**
	 * Subscribes to change events; returns an idempotent unsubscribe.
	 *
	 * Optional, and the D1 promise is unchanged by being read-only: implementing
	 * it means every change to the *underlying* source becomes an event. A
	 * projection written by another module still changes, so a read-only store that
	 * implements `watch` must be watching that source — polling `currentVersion` is
	 * the alternative, and leaving `watch` undefined is what asks for it.
	 *
	 * {@inheritDoc PolicyStore.watch}
	 */
	watch?(listener: PolicyChangeListener): Unsubscribe;
}

/** Options for {@link readOnlyPolicyStore}. */
export interface ReadOnlyPolicyStoreOptions {
	/**
	 * Names the store in the rejection message. Default `'This policy store'`.
	 *
	 * Worth setting: the message is what a developer sees when a write lands
	 * somewhere it was never meant to, and `'StationPolicyProjection is read-only'`
	 * says where to look in a way that `'This policy store is read-only'` does not.
	 */
	readonly name?: string;
	/**
	 * Appended to the rejection message. Say where writes *should* go.
	 *
	 * ```ts
	 * readOnlyPolicyStore(projection, {
	 *   name: "StationPolicyProjection",
	 *   hint: "Policies are a projection of roles/role_grants; write those instead.",
	 * });
	 * ```
	 */
	readonly hint?: string;
}

/**
 * Adapts a {@link ReadOnlyPolicyStore} into a full {@link PolicyStore} whose four
 * write methods reject.
 *
 * ```ts
 * const store = readOnlyPolicyStore(
 *   {
 *     load: (scope) => projection.bundleFor(scope),
 *     currentVersion: (scope) => projection.revisionOf(scope),
 *     watch: (listener) => projection.onChange(listener),
 *   },
 *   { name: "StationPolicyProjection", hint: "Write roles/role_grants instead." },
 * );
 * ```
 *
 * Three properties, each chosen against a plausible alternative:
 *
 * - **The write methods reject; they do not resolve.** A resolving no-op is
 *   indistinguishable from success at the call site and shows up much later as a
 *   decision that should have changed and did not. The error is a
 *   `PermissionsError` with code `POLICY_STORE`, so existing store-error handling
 *   catches it unchanged.
 * - **`save([])` and `delete(scope, [])` reject too.** A writable store treats an
 *   empty batch as a no-op, which would make "nothing to do" and "this store
 *   cannot write" the same observation — and a caller that batches zero records
 *   today would learn nothing about the batch of one it sends tomorrow.
 * - **`watch` is forwarded only when the source has it.** `PolicyStore.watch` is
 *   optional and implementing it is the D1 promise that every change becomes an
 *   event; synthesising a never-firing `watch` would stop the cache polling
 *   `currentVersion` and freeze every decision at its first value.
 */
export function readOnlyPolicyStore(
	store: ReadOnlyPolicyStore,
	options: ReadOnlyPolicyStoreOptions = {},
): PolicyStore {
	const subject = options.name ?? "This policy store";
	const hint = options.hint === undefined ? "" : ` ${options.hint}`;

	const reject = (operation: string, scope?: PolicyScopeId): never => {
		throw new PermissionsError(
			"POLICY_STORE",
			`${subject} is read-only; ${operation} is not supported. Its policies are managed ` +
				`outside this package, so a write accepted here would either be lost or become a ` +
				`second, unsynchronised write path.${hint}`,
			scope === undefined ? {} : { scope },
		);
	};

	const adapter: PolicyStore = {
		async load(scope: PolicyScopeId): Promise<PolicyBundle> {
			return store.load(scope);
		},
		async currentVersion(scope: PolicyScopeId): Promise<string> {
			return store.currentVersion(scope);
		},
		async save(policies: readonly PolicyRecord[]): Promise<void> {
			reject(`save(${String(policies.length)} record(s))`, policies[0]?.scope);
		},
		async delete(scope: PolicyScopeId, ids: readonly string[]): Promise<void> {
			reject(`delete(${String(ids.length)} id(s))`, scope);
		},
		async linkTemplate(link: TemplateLinkRecord): Promise<void> {
			reject(`linkTemplate("${link.id}")`, link.scope);
		},
		async unlinkTemplate(scope: PolicyScopeId, linkId: string): Promise<void> {
			reject(`unlinkTemplate("${linkId}")`, scope);
		},
	};

	// Bound once, not extracted: a `watch` that lost its `this` would subscribe to
	// nothing and report success, which is the exact failure D1 exists to prevent.
	const watch = store.watch?.bind(store);
	if (watch !== undefined) {
		adapter.watch = watch;
	}

	READ_ONLY_STORES.add(adapter);
	return adapter;
}

/**
 * Whether `store` was produced by {@link readOnlyPolicyStore}.
 *
 * For a caller deciding whether to *offer* a write — an admin UI hiding its
 * editor, a seeding routine skipping a tenant — rather than for deciding whether
 * to catch. Catching `PermissionsError` with code `POLICY_STORE` is the way to
 * handle a write that already happened.
 */
export function isReadOnlyPolicyStore(store: PolicyStore): boolean {
	return READ_ONLY_STORES.has(store);
}

const READ_ONLY_STORES = new WeakSet<PolicyStore>();
