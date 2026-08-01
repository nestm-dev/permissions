// The in-memory reference implementation of `PolicyStore`.
//
// It is the v1 driver used by tests, by the quick-start, and (per the station
// migration) as the `'instance'` half of a `CompositePolicyStore`. Because it is
// the store every other implementation is conformance-tested against, it
// implements the SPI's sharp edges literally rather than conveniently:
// composition happens in `load`, id collisions throw, and everything crossing
// the boundary is copied so no caller can reach into the store's state.

import { fail, invariant } from "../util/assert.ts";
import type { EntityRef } from "../cedar/uid.ts";
import type { PolicyJson } from "../cedar/binding.ts";
import {
	GLOBAL_POLICY_SCOPE,
	composePolicyVersion,
	isGlobalScope,
	isTemplateSlotId,
	type PolicyBundle,
	type PolicyChangeEvent,
	type PolicyChangeListener,
	type PolicyChangeReason,
	type PolicyRecord,
	type PolicyScopeId,
	type PolicyStore,
	type TemplateLinkRecord,
	type TemplateSlotId,
	type Unsubscribe,
} from "./policy-store.ts";

/** Records the store starts life with. Seeding emits no change events. */
export interface MemoryPolicyStoreSeed {
	/** Static policies and templates, in any scope. */
	readonly policies?: readonly PolicyRecord[];
	/** Template links, in any scope. */
	readonly links?: readonly TemplateLinkRecord[];
}

function byId(left: { readonly id: string }, right: { readonly id: string }): number {
	// Code-unit order, not locale order: bundle output has to be byte-stable
	// across machines because it feeds a preparse cache.
	if (left.id === right.id) {
		return 0;
	}
	return left.id < right.id ? -1 : 1;
}

function deepFreeze<T>(value: T): T {
	if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
		return value;
	}
	for (const nested of Object.values(value as Record<string, unknown>)) {
		deepFreeze(nested);
	}
	return Object.freeze(value);
}

function assertRecord(record: PolicyRecord): void {
	invariant(
		typeof record.id === "string" && record.id.length > 0,
		"POLICY_STORE",
		"A PolicyRecord needs a non-empty id.",
	);
	invariant(
		record.kind === "static" || record.kind === "template",
		"POLICY_STORE",
		`Policy "${record.id}" has an unknown kind: ${record.kind}.`,
		{ scope: record.scope },
	);
	invariant(
		typeof record.cedarJson === "object" && record.cedarJson !== null,
		"POLICY_STORE",
		`Policy "${record.id}" has no cedarJson. Persist Cedar JSON, not policy text.`,
		{ scope: record.scope },
	);
	invariant(
		record.updatedAt instanceof Date && !Number.isNaN(record.updatedAt.getTime()),
		"POLICY_STORE",
		`Policy "${record.id}" has an invalid updatedAt.`,
		{ scope: record.scope },
	);
}

function assertLink(link: TemplateLinkRecord): void {
	invariant(
		typeof link.id === "string" && link.id.length > 0,
		"POLICY_STORE",
		"A TemplateLinkRecord needs a non-empty id.",
	);
	invariant(
		typeof link.templateId === "string" && link.templateId.length > 0,
		"POLICY_STORE",
		`Template link "${link.id}" needs a templateId.`,
		{ scope: link.scope },
	);
	invariant(
		link.updatedAt instanceof Date && !Number.isNaN(link.updatedAt.getTime()),
		"POLICY_STORE",
		`Template link "${link.id}" has an invalid updatedAt.`,
		{ scope: link.scope },
	);

	for (const [slot, ref] of Object.entries(link.values)) {
		invariant(
			isTemplateSlotId(slot),
			"POLICY_STORE",
			`Template link "${link.id}" uses the slot "${slot}"; Cedar only accepts ` +
				`"?principal" and "?resource".`,
			{ scope: link.scope },
		);
		invariant(
			typeof ref?.type === "string" && typeof ref.id === "string",
			"POLICY_STORE",
			`Template link "${link.id}" has a malformed value for "${slot}".`,
			{ scope: link.scope },
		);
	}
}

function copyPolicyRecord(record: PolicyRecord): PolicyRecord {
	const copy: {
		id: string;
		scope: PolicyScopeId;
		kind: PolicyRecord["kind"];
		cedarJson: PolicyJson;
		description?: string;
		annotations?: Readonly<Record<string, string>>;
		enabled: boolean;
		updatedAt: Date;
	} = {
		id: record.id,
		scope: record.scope,
		kind: record.kind,
		cedarJson: structuredClone(record.cedarJson),
		enabled: record.enabled,
		// Copied rather than frozen: `Object.freeze` does not close `setTime`.
		updatedAt: new Date(record.updatedAt.getTime()),
	};

	if (record.description !== undefined) {
		copy.description = record.description;
	}
	if (record.annotations !== undefined) {
		copy.annotations = { ...record.annotations };
	}

	return deepFreeze(copy);
}

function copyLinkRecord(link: TemplateLinkRecord): TemplateLinkRecord {
	const values: Partial<Record<TemplateSlotId, EntityRef>> = {};
	for (const [slot, ref] of Object.entries(link.values)) {
		if (ref !== undefined && isTemplateSlotId(slot)) {
			values[slot] = { type: ref.type, id: ref.id };
		}
	}

	return deepFreeze({
		id: link.id,
		scope: link.scope,
		templateId: link.templateId,
		values,
		updatedAt: new Date(link.updatedAt.getTime()),
	});
}

/**
 * `Map`-backed {@link PolicyStore} with a synchronous change emitter.
 *
 * - `load(scope)` composes global (`''`) ∪ `scope` and throws `POLICY_STORE` on
 *   an id present in both halves (**D2**).
 * - versions are per-scope monotonic counters rendered as `g<n>:s<m>`, so a
 *   global write moves every scope's version.
 * - a write to the global scope emits `{ scope: '*' }`, which invalidates every
 *   cached scope downstream.
 * - records are copied in and copied out, and every copy is deep-frozen: nothing
 *   a caller holds can mutate what the store returns next time.
 */
export class MemoryPolicyStore implements PolicyStore {
	readonly #policies = new Map<PolicyScopeId, Map<string, PolicyRecord>>();
	readonly #links = new Map<PolicyScopeId, Map<string, TemplateLinkRecord>>();
	readonly #revisions = new Map<PolicyScopeId, number>();
	readonly #listeners = new Set<PolicyChangeListener>();

	constructor(seed: MemoryPolicyStoreSeed = {}) {
		for (const record of seed.policies ?? []) {
			assertRecord(record);
			this.#policyBucket(record.scope).set(record.id, copyPolicyRecord(record));
			this.#touch(record.scope);
		}
		for (const link of seed.links ?? []) {
			assertLink(link);
			this.#linkBucket(link.scope).set(link.id, copyLinkRecord(link));
			this.#touch(link.scope);
		}
	}

	/** Scopes that hold at least one record or have ever been written to. */
	get scopes(): readonly PolicyScopeId[] {
		return [...new Set([...this.#policies.keys(), ...this.#links.keys()])].toSorted();
	}

	/** {@inheritDoc PolicyStore.load} */
	async load(scope: PolicyScopeId): Promise<PolicyBundle> {
		return this.loadSync(scope);
	}

	/**
	 * Synchronous {@link load}.
	 *
	 * Exists because this store has no I/O and tests want the bundle without a
	 * microtask; the SPI itself is async and callers must use {@link load}.
	 */
	loadSync(scope: PolicyScopeId): PolicyBundle {
		const globalPolicies = this.#policies.get(GLOBAL_POLICY_SCOPE);
		const globalLinks = this.#links.get(GLOBAL_POLICY_SCOPE);
		const scopedPolicies = isGlobalScope(scope) ? undefined : this.#policies.get(scope);
		const scopedLinks = isGlobalScope(scope) ? undefined : this.#links.get(scope);

		// D2: precedence between a global and a scoped record of the same id is
		// undefined, so it is a configuration error rather than a silent winner.
		for (const id of scopedPolicies?.keys() ?? []) {
			invariant(
				globalPolicies?.has(id) !== true,
				"POLICY_STORE",
				`Policy id "${id}" exists in both the global scope and "${scope}". ` +
					`Ids must be unique across the effective bundle.`,
				{ scope },
			);
		}
		for (const id of scopedLinks?.keys() ?? []) {
			invariant(
				globalLinks?.has(id) !== true,
				"POLICY_STORE",
				`Template link id "${id}" exists in both the global scope and "${scope}". ` +
					`Ids must be unique across the effective bundle.`,
				{ scope },
			);
		}

		const policies = [...(globalPolicies?.values() ?? []), ...(scopedPolicies?.values() ?? [])]
			.map(copyPolicyRecord)
			.toSorted(byId);
		const links = [...(globalLinks?.values() ?? []), ...(scopedLinks?.values() ?? [])]
			.map(copyLinkRecord)
			.toSorted(byId);

		return Object.freeze({
			scope,
			version: this.versionOf(scope),
			policies: Object.freeze(policies),
			links: Object.freeze(links),
		});
	}

	/** {@inheritDoc PolicyStore.currentVersion} */
	async currentVersion(scope: PolicyScopeId): Promise<string> {
		return this.versionOf(scope);
	}

	/** Synchronous {@link currentVersion}: `g<n>:s<m>` (**D2**). */
	versionOf(scope: PolicyScopeId): string {
		return composePolicyVersion(
			this.#revisions.get(GLOBAL_POLICY_SCOPE) ?? 0,
			this.#revisions.get(scope) ?? 0,
		);
	}

	/** {@inheritDoc PolicyStore.save} */
	async save(policies: readonly PolicyRecord[]): Promise<void> {
		const touched = new Set<PolicyScopeId>();

		for (const record of policies) {
			assertRecord(record);
			this.#policyBucket(record.scope).set(record.id, copyPolicyRecord(record));
			touched.add(record.scope);
		}

		this.#commit(touched, "save");
	}

	/** {@inheritDoc PolicyStore.delete} */
	async delete(scope: PolicyScopeId, ids: readonly string[]): Promise<void> {
		const bucket = this.#policies.get(scope);
		let removed = false;

		for (const id of ids) {
			removed = (bucket?.delete(id) ?? false) || removed;
		}

		this.#commit(removed ? new Set([scope]) : new Set(), "delete");
	}

	/** {@inheritDoc PolicyStore.linkTemplate} */
	async linkTemplate(link: TemplateLinkRecord): Promise<void> {
		assertLink(link);
		this.#linkBucket(link.scope).set(link.id, copyLinkRecord(link));
		this.#commit(new Set([link.scope]), "link");
	}

	/** {@inheritDoc PolicyStore.unlinkTemplate} */
	async unlinkTemplate(scope: PolicyScopeId, linkId: string): Promise<void> {
		const removed = this.#links.get(scope)?.delete(linkId) ?? false;
		this.#commit(removed ? new Set([scope]) : new Set(), "unlink");
	}

	/**
	 * {@inheritDoc PolicyStore.watch}
	 *
	 * Listeners run synchronously inside the write that caused the event, so a
	 * cache marked stale here is already stale when `save()` resolves.
	 */
	watch(listener: PolicyChangeListener): Unsubscribe {
		this.#listeners.add(listener);
		let active = true;
		return () => {
			if (active) {
				active = false;
				this.#listeners.delete(listener);
			}
		};
	}

	/**
	 * Emits a change event nothing in this store produced.
	 *
	 * The escape hatch for a host that mutates its policies out of band and needs
	 * caches invalidated anyway.
	 */
	emit(event: PolicyChangeEvent): void {
		this.#notify(event);
	}

	#policyBucket(scope: PolicyScopeId): Map<string, PolicyRecord> {
		let bucket = this.#policies.get(scope);
		if (bucket === undefined) {
			bucket = new Map();
			this.#policies.set(scope, bucket);
		}
		return bucket;
	}

	#linkBucket(scope: PolicyScopeId): Map<string, TemplateLinkRecord> {
		let bucket = this.#links.get(scope);
		if (bucket === undefined) {
			bucket = new Map();
			this.#links.set(scope, bucket);
		}
		return bucket;
	}

	#touch(scope: PolicyScopeId): void {
		this.#revisions.set(scope, (this.#revisions.get(scope) ?? 0) + 1);
	}

	#commit(scopes: ReadonlySet<PolicyScopeId>, reason: PolicyChangeReason): void {
		for (const scope of [...scopes].toSorted()) {
			this.#touch(scope);
			// A global write changes the effective bundle of every scope, so it is
			// broadcast as `'*'` (D2) rather than as a change to `''`.
			this.#notify({ scope: isGlobalScope(scope) ? "*" : scope, reason });
		}
	}

	#notify(event: PolicyChangeEvent): void {
		const failures: unknown[] = [];

		// Every listener is notified even if one throws: a half-notified set of
		// caches is worse than a loud failure after the fact. Iterating the live
		// set is deliberate — a listener that unsubscribes mid-notify must not be
		// called afterwards.
		for (const listener of this.#listeners) {
			try {
				listener(event);
			} catch (error) {
				failures.push(error);
			}
		}

		if (failures.length > 0) {
			fail(
				"POLICY_STORE",
				`${String(failures.length)} policy-change listener(s) threw for scope "${event.scope}".`,
				{ cause: failures[0] },
			);
		}
	}
}
