// Row ⇄ record codecs.
//
// Kept in one file so the two directions sit next to each other: a field that is
// written one way and read another is the class of bug that only shows up as
// "the policy came back different", long after the write.

import {
	PermissionsError,
	TEMPLATE_SLOT_IDS,
	isTemplateSlotId,
	type EntityRef,
	type PolicyJson,
	type PolicyKind,
	type PolicyRecord,
	type PolicyScopeId,
	type TemplateLinkRecord,
	type TemplateSlotId,
} from "@nestm/permissions-core";

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------

/** One `${prefix}policies` row, as drizzle hands it back. */
export interface PolicyRow {
	readonly scope: unknown;
	readonly policyId: string;
	readonly kind: string;
	readonly cedarJson: PolicyJson;
	readonly cedarText: string | null;
	readonly description: string | null;
	readonly annotations: Record<string, string> | null;
	readonly enabled: boolean;
	readonly updatedAt: Date;
}

/** One `${prefix}policy_links` row, as drizzle hands it back. */
export interface LinkRow {
	readonly scope: unknown;
	readonly linkId: string;
	readonly templateId: string;
	readonly principalType: string | null;
	readonly principalId: string | null;
	readonly resourceType: string | null;
	readonly resourceId: string | null;
	readonly updatedAt: Date;
}

/** Values written for one policy record, before the scope column is added. */
export interface PolicyRowValues {
	readonly policyId: string;
	readonly kind: PolicyKind;
	readonly cedarJson: PolicyJson;
	readonly cedarText: string | null;
	readonly description: string | null;
	readonly annotations: Record<string, string>;
	readonly enabled: boolean;
	readonly updatedAt: Date;
}

/** Values written for one link record, before the scope column is added. */
export interface LinkRowValues {
	readonly linkId: string;
	readonly templateId: string;
	readonly principalType: string | null;
	readonly principalId: string | null;
	readonly resourceType: string | null;
	readonly resourceId: string | null;
	readonly updatedAt: Date;
}

// ---------------------------------------------------------------------------
// Record → row
// ---------------------------------------------------------------------------

/** Validates a record the way `MemoryPolicyStore` does, so both stores reject the same inputs. */
export function assertPolicyRecord(record: PolicyRecord): void {
	if (typeof record.id !== "string" || record.id.length === 0) {
		throw storeError("A PolicyRecord needs a non-empty id.", record.scope);
	}
	if (record.kind !== "static" && record.kind !== "template") {
		throw storeError(
			`Policy "${record.id}" has an unknown kind: ${String(record.kind)}.`,
			record.scope,
		);
	}
	if (typeof record.cedarJson !== "object" || record.cedarJson === null) {
		throw storeError(
			`Policy "${record.id}" has no cedarJson. Persist Cedar JSON, not policy text.`,
			record.scope,
		);
	}
	if (!(record.updatedAt instanceof Date) || Number.isNaN(record.updatedAt.getTime())) {
		throw storeError(`Policy "${record.id}" has an invalid updatedAt.`, record.scope);
	}
}

/** Validates a link record, including its slot ids and shapes. */
export function assertLinkRecord(link: TemplateLinkRecord): void {
	if (typeof link.id !== "string" || link.id.length === 0) {
		throw storeError("A TemplateLinkRecord needs a non-empty id.", link.scope);
	}
	if (typeof link.templateId !== "string" || link.templateId.length === 0) {
		throw storeError(`Template link "${link.id}" needs a templateId.`, link.scope);
	}
	if (!(link.updatedAt instanceof Date) || Number.isNaN(link.updatedAt.getTime())) {
		throw storeError(`Template link "${link.id}" has an invalid updatedAt.`, link.scope);
	}

	for (const [slot, reference] of Object.entries(link.values)) {
		if (!isTemplateSlotId(slot)) {
			throw storeError(
				`Template link "${link.id}" uses the slot "${slot}"; Cedar only accepts ` +
					`"?principal" and "?resource".`,
				link.scope,
			);
		}
		if (typeof reference?.type !== "string" || typeof reference.id !== "string") {
			throw storeError(
				`Template link "${link.id}" has a malformed value for "${slot}".`,
				link.scope,
			);
		}
	}
}

/** Projects a {@link PolicyRecord} onto the columns of the policies table. */
export function policyRowValues(record: PolicyRecord): PolicyRowValues {
	return {
		policyId: record.id,
		kind: record.kind,
		// Cloned: the caller keeps their object and may mutate it the moment this
		// returns, and drizzle serialises lazily.
		cedarJson: structuredClone(record.cedarJson),
		cedarText: null,
		description: record.description ?? null,
		annotations: record.annotations === undefined ? {} : { ...record.annotations },
		enabled: record.enabled,
		updatedAt: new Date(record.updatedAt.getTime()),
	};
}

/** Projects a {@link TemplateLinkRecord} onto the columns of the links table. */
export function linkRowValues(link: TemplateLinkRecord): LinkRowValues {
	const principal = link.values["?principal"];
	const resource = link.values["?resource"];

	return {
		linkId: link.id,
		templateId: link.templateId,
		principalType: principal?.type ?? null,
		principalId: principal?.id ?? null,
		resourceType: resource?.type ?? null,
		resourceId: resource?.id ?? null,
		updatedAt: new Date(link.updatedAt.getTime()),
	};
}

// ---------------------------------------------------------------------------
// Row → record
// ---------------------------------------------------------------------------

/**
 * Rebuilds a {@link PolicyRecord} from a row.
 *
 * `description` and `annotations` are **omitted** rather than nulled when the
 * columns are NULL/empty, so a record that round-trips through the database is
 * `toEqual`-identical to the one `MemoryPolicyStore` returns. Two stores that
 * disagree about `{ description: undefined }` versus `{}` fail the same
 * conformance assertion in different ways.
 */
export function toPolicyRecord(row: PolicyRow, scope: PolicyScopeId): PolicyRecord {
	const record: {
		id: string;
		scope: PolicyScopeId;
		kind: PolicyKind;
		cedarJson: PolicyJson;
		description?: string;
		annotations?: Record<string, string>;
		enabled: boolean;
		updatedAt: Date;
	} = {
		id: row.policyId,
		scope,
		kind: row.kind === "template" ? "template" : "static",
		cedarJson: row.cedarJson,
		enabled: row.enabled,
		updatedAt: row.updatedAt,
	};

	if (row.description !== null) {
		record.description = row.description;
	}
	if (row.annotations !== null && Object.keys(row.annotations).length > 0) {
		record.annotations = row.annotations;
	}

	return deepFreeze(record);
}

/** Rebuilds a {@link TemplateLinkRecord} from a row, in canonical slot order. */
export function toLinkRecord(row: LinkRow, scope: PolicyScopeId): TemplateLinkRecord {
	const values: Partial<Record<TemplateSlotId, EntityRef>> = {};

	// Canonical order, not insertion order: `Object.keys(values)` is compared
	// directly by the conformance suite and by anything hashing a bundle.
	for (const slot of TEMPLATE_SLOT_IDS) {
		const type = slot === "?principal" ? row.principalType : row.resourceType;
		const id = slot === "?principal" ? row.principalId : row.resourceId;
		if (type !== null && id !== null) {
			values[slot] = { type, id };
		}
	}

	return deepFreeze({
		id: row.linkId,
		scope,
		templateId: row.templateId,
		values,
		updatedAt: row.updatedAt,
	});
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Code-unit order, so a bundle is byte-stable across machines (it feeds a preparse cache). */
export function byId(left: { readonly id: string }, right: { readonly id: string }): number {
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

/** Every failure this store raises is core's `POLICY_STORE`, so callers branch on one code. */
export function storeError(
	message: string,
	scope?: PolicyScopeId,
	cause?: unknown,
): PermissionsError {
	return new PermissionsError("POLICY_STORE", message, {
		...(scope === undefined ? {} : { scope }),
		...(cause === undefined ? {} : { cause }),
	});
}
