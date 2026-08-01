// The policy-store SPI.
//
// Two contracts here are load-bearing and are stated on every member they touch,
// because getting either wrong is a production incident rather than a bug:
//
//   D1 — when a store implements `watch`, freshness is *event-driven*. The
//        engine trusts its cached policy set until an event arrives and never
//        calls `currentVersion` on the check path: a database round-trip per
//        check would erase the 0.136 ms `statefulIsAuthorized` number that the
//        whole preparse cache exists to buy. `currentVersion` is for cold loads
//        and for the explicit `warm()` / `invalidate()` flows only.
//
//   D2 — `load(scope)` returns the *effective* bundle: the global scope (`''`)
//        unioned with `scope`. Composition happens in the store, at load time,
//        so a check never pays for two policy sets. A policy id present in both
//        halves is ambiguous and **throws** (`POLICY_STORE`) rather than letting
//        one half silently win.

import type { PolicyJson } from "../cedar/binding.ts";
import type { EntityRef } from "../cedar/uid.ts";

/**
 * Identifies a policy partition.
 *
 * `''` is the **global** scope: policies every tenant gets. Any other value is
 * an opaque tenant key chosen by the host application — `'org:8f3e…'`,
 * `'instance'`, a bare UUID. It is used verbatim as the suffix of the Cedar WASM
 * policy-set id, so it must be stable for the lifetime of the tenant.
 */
export type PolicyScopeId = string;

/** The global scope: policies composed into every other scope's bundle. */
export const GLOBAL_POLICY_SCOPE: PolicyScopeId = "";

/** Whether `scope` is the global scope. */
export function isGlobalScope(scope: PolicyScopeId): boolean {
	return scope === GLOBAL_POLICY_SCOPE;
}

/** A stored policy is either a static policy or a template that links instantiate. */
export type PolicyKind = "static" | "template";

/**
 * The two slots a Cedar template can declare.
 *
 * The `?` prefix is part of the identifier: cedar-wasm rejects any other spelling
 * with a hard WASM throw rather than a failure answer, which is why link values
 * are validated in this package before they reach it.
 */
export type TemplateSlotId = "?principal" | "?resource";

/** Canonical slot order. Used wherever slot output has to be deterministic. */
export const TEMPLATE_SLOT_IDS: readonly TemplateSlotId[] = ["?principal", "?resource"];

/** Whether `value` is a slot identifier Cedar accepts. */
export function isTemplateSlotId(value: string): value is TemplateSlotId {
	return value === "?principal" || value === "?resource";
}

/**
 * One persisted policy or template.
 *
 * The canonical persisted form is `cedarJson`, not policy text: JSON is
 * `jsonb`-queryable ("which policies reference `Run`?") and round-trips through
 * Cedar losslessly. Use `policy-codec.ts` to move between the two.
 */
export interface PolicyRecord {
	/** Cedar policy id, unique within its scope *and* against the global scope (D2). */
	readonly id: string;
	/** Partition this record belongs to; `''` for global. */
	readonly scope: PolicyScopeId;
	/** `'template'` iff `cedarJson` declares `?principal`/`?resource` slots. */
	readonly kind: PolicyKind;
	/** Canonical Cedar JSON. Never policy text — see `policy-codec.ts`. */
	readonly cedarJson: PolicyJson;
	/** Free-text description for admin UIs. Never read by the engine. */
	readonly description?: string;
	/** Cedar policy annotations, mirrored here so a store can index them. */
	readonly annotations?: Readonly<Record<string, string>>;
	/** Disabled records are dropped from the compiled policy set entirely. */
	readonly enabled: boolean;
	/** Last write time. Stores may use it to derive a version. */
	readonly updatedAt: Date;
}

/**
 * One instantiation of a template — the role-grant primitive.
 *
 * `values` is `Partial` on purpose (**D6**): a template that only declares
 * `?principal` must be linkable without inventing a `?resource`. The values are
 * checked against the slots the template actually declares when the policy set
 * is built, and a mismatch in either direction is a `POLICY_INVALID` throw.
 */
export interface TemplateLinkRecord {
	/** Becomes Cedar's `newId` — the policy id the link evaluates under. */
	readonly id: string;
	/** Partition this link belongs to; `''` for global. */
	readonly scope: PolicyScopeId;
	/** Id of the {@link PolicyRecord} with `kind: 'template'` being linked. */
	readonly templateId: string;
	/** Slot values, exactly covering the template's declared slots (D6). */
	readonly values: Partial<Record<TemplateSlotId, EntityRef>>;
	/** Last write time. */
	readonly updatedAt: Date;
}

/**
 * The effective policy set for one scope.
 *
 * Per **D2** this is already `global ∪ scope`: consumers must not union anything
 * else into it.
 */
export interface PolicyBundle {
	/** Scope this bundle was loaded for (not `'*'`; not the global scope unless asked for). */
	readonly scope: PolicyScopeId;
	/**
	 * Opaque composite version, `g<n>:s<m>` (**D2**) — `n` tracks the global
	 * scope, `m` tracks `scope`. It must change when *either* half changes, which
	 * is what makes a global edit invalidate every tenant.
	 */
	readonly version: string;
	/** Static policies and templates, global ones included. */
	readonly policies: readonly PolicyRecord[];
	/** Template links, global ones included. */
	readonly links: readonly TemplateLinkRecord[];
}

/** Why a {@link PolicyChangeEvent} was emitted. */
export type PolicyChangeReason = "save" | "delete" | "link" | "unlink" | "external";

/**
 * Emitted when a scope's policies changed.
 *
 * `scope: '*'` means *every* cached scope is stale (**D2**) — a write to the
 * global scope is the usual cause, since global policies are composed into every
 * bundle.
 */
export interface PolicyChangeEvent {
	/** Affected scope, or `'*'` for "all scopes". */
	// oxlint-disable-next-line typescript/no-redundant-type-constituents -- `PolicyScopeId` widens to `string`, but spelling the sentinel out is the contract
	readonly scope: PolicyScopeId | "*";
	/** What produced the change, when the store knows. */
	readonly reason?: PolicyChangeReason;
}

/** Synchronous listener for {@link PolicyStore.watch}. */
export type PolicyChangeListener = (event: PolicyChangeEvent) => void;

/** Cancels a subscription. Calling it more than once must be a no-op. */
export type Unsubscribe = () => void;

/**
 * Storage SPI for policies and template links.
 *
 * Implementations ship in core (`MemoryPolicyStore`, `CompositePolicyStore`) and
 * in the ORM driver packages. The shared conformance suite is the contract.
 */
export interface PolicyStore {
	/**
	 * Returns the **effective** bundle for `scope`: global (`''`) ∪ `scope`
	 * (**D2**), with a composite `g<n>:s<m>` version.
	 *
	 * @throws `PermissionsError` with code `POLICY_STORE` when a policy id or a
	 * link id exists in both the global scope and `scope` — ambiguous precedence
	 * is a configuration error, never a silent override.
	 */
	load(scope: PolicyScopeId): Promise<PolicyBundle>;

	/**
	 * Cheap freshness probe returning the same version string {@link load} would.
	 *
	 * **D1**: never called on the check path when the store implements
	 * {@link watch}. Reserved for cold loads, `warm()` and `invalidate()`.
	 */
	currentVersion(scope: PolicyScopeId): Promise<string>;

	/**
	 * Inserts or replaces records by `(scope, id)`.
	 *
	 * Records may span scopes in one call; a store must bump the version of every
	 * scope it touched and emit one {@link PolicyChangeEvent} per touched scope.
	 */
	save(policies: readonly PolicyRecord[]): Promise<void>;

	/** Removes policies by id within `scope`. Unknown ids are ignored. */
	delete(scope: PolicyScopeId, ids: readonly string[]): Promise<void>;

	/** Inserts or replaces a template link by `(link.scope, link.id)`. */
	linkTemplate(link: TemplateLinkRecord): Promise<void>;

	/** Removes a template link by id within `scope`. An unknown id is ignored. */
	unlinkTemplate(scope: PolicyScopeId, linkId: string): Promise<void>;

	/**
	 * Subscribes to change events; returns an idempotent unsubscribe.
	 *
	 * **D1**: implementing this method *is* the promise that every write becomes an
	 * event. A store that implements `watch` and then misses an event serves stale
	 * authorization decisions indefinitely, because the cache stops polling
	 * `currentVersion` entirely. A store that cannot make that promise must leave
	 * `watch` undefined and let the cache fall back to time-based revalidation.
	 */
	watch?(listener: PolicyChangeListener): Unsubscribe;
}

/** Builds the composite `g<n>:s<m>` version string of **D2**. */
export function composePolicyVersion(globalRevision: number, scopeRevision: number): string {
	return `g${String(globalRevision)}:s${String(scopeRevision)}`;
}

/** Parses a `g<n>:s<m>` version, or returns `undefined` if it is not one. */
export function parsePolicyVersion(
	version: string,
): { readonly global: number; readonly scope: number } | undefined {
	const match = /^g(\d+):s(\d+)$/.exec(version);
	if (match === null) {
		return undefined;
	}
	return { global: Number(match[1]), scope: Number(match[2]) };
}
