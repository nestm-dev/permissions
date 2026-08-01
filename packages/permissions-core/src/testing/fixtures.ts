// Fixtures published on `@nestm/permissions-core/testing`.
//
// Two audiences: this package's own property and conformance suites, and the ORM
// driver packages, which need a vocabulary and a set of policy shapes that are
// *identical* to the ones the reference interpreter was validated against. A
// driver that invented its own fixture would be differential-testing its SQL
// against a plan compiled from policies nobody had checked.
//
// Nothing here touches the Cedar WASM: `defineVocabulary` is pure TypeScript
// (delta D3) and every `PolicyJson` below is a literal, so importing this module
// costs nothing but the vocabulary object.

import type { PolicyJson } from "../cedar/binding.ts";
import type { EntityRef } from "../cedar/uid.ts";
import type {
	PolicyRecord,
	PolicyScopeId,
	TemplateLinkRecord,
	TemplateSlotId,
} from "../policy/policy-store.ts";
import { t } from "../vocabulary/attr.ts";
import { defineVocabulary } from "../vocabulary/define-vocabulary.ts";

// ---------------------------------------------------------------------------
// The vocabulary
// ---------------------------------------------------------------------------

/**
 * A compact vocabulary covering every shape the pushdown table supports.
 *
 * Deliberately small and deliberately complete: one entity (`Doc`) carrying a
 * string, a long, a bool, a set, an entity reference, and three *optional*
 * attributes, inside a two-level hierarchy (`Doc` → `Folder` → `Org`). That is
 * the minimum that exercises `cmp`, `in`, `contains`, `like`, `exists`,
 * `isEmpty`, `inHierarchy` (both rooted at the row and at an attribute) and the
 * optional-attribute path, which is where plan and `check()` are most likely to
 * disagree.
 *
 * The optional attributes are the point of the fixture, not decoration: Cedar
 * *errors* on an unguarded optional access and drops the policy, so a policy over
 * `publishedAt` must be written `resource has publishedAt && …`. `validateOnLoad`
 * enforces exactly that (errata core.md 7).
 */
export const testVocabulary = defineVocabulary({
	namespace: "Test",
	entities: {
		Org: {},
		Group: {},
		User: {
			memberOf: ["Group", "Org"],
			attrs: { org: t.ref("Org") },
		},
		Folder: {
			memberOf: ["Org"],
			attrs: { org: t.ref("Org") },
		},
		Doc: {
			memberOf: ["Folder"],
			attrs: {
				folder: t.ref("Folder"),
				owner: t.ref("User"),
				status: t.string(),
				title: t.string(),
				size: t.long(),
				archived: t.bool(),
				labels: t.set(t.string()),
				/** Optional on purpose: forces `has`-guarded policies. */
				publishedAt: t.optional(t.ext("datetime")),
				/** Optional entity reference — the `inHierarchy`-over-a-nullable-column case. */
				reviewer: t.optional(t.ref("User")),
				/** Optional long — the orderable-but-absent case. */
				score: t.optional(t.long()),
			},
		},
	},
	actions: {
		"doc:read": { principal: ["User"], resource: ["Doc"] },
		"doc:write": { principal: ["User"], resource: ["Doc"] },
	},
});

/** Type of {@link testVocabulary}, for consumers that need to name it. */
export type TestVocabulary = typeof testVocabulary;

// ---------------------------------------------------------------------------
// Policy shapes
// ---------------------------------------------------------------------------

/**
 * `permit(principal, action, resource);`
 *
 * Hand-written Cedar JSON rather than parsed text, so the fixtures stay usable in
 * suites that must not load the WASM.
 */
export const PERMIT_ALL: PolicyJson = {
	effect: "permit",
	principal: { op: "All" },
	action: { op: "All" },
	resource: { op: "All" },
	conditions: [],
};

/** `forbid(principal, action, resource);` */
export const FORBID_ALL: PolicyJson = {
	effect: "forbid",
	principal: { op: "All" },
	action: { op: "All" },
	resource: { op: "All" },
	conditions: [],
};

/** `permit(principal == ?principal, action, resource in ?resource);` — both slots. */
export const TEMPLATE_BOTH_SLOTS: PolicyJson = {
	effect: "permit",
	principal: { op: "==", slot: "?principal" },
	action: { op: "All" },
	resource: { op: "in", slot: "?resource" },
	conditions: [],
};

/** `permit(principal == ?principal, action, resource);` — the **D6** partial-slot case. */
export const TEMPLATE_PRINCIPAL_ONLY: PolicyJson = {
	effect: "permit",
	principal: { op: "==", slot: "?principal" },
	action: { op: "All" },
	resource: { op: "All" },
	conditions: [],
};

/** `permit(principal, action, resource in ?resource);` */
export const TEMPLATE_RESOURCE_ONLY: PolicyJson = {
	effect: "permit",
	principal: { op: "All" },
	action: { op: "All" },
	resource: { op: "in", slot: "?resource" },
	conditions: [],
};

/**
 * A fixed timestamp, on a whole second.
 *
 * Whole seconds because a store may persist through a column whose precision is
 * coarser than a JavaScript millisecond; the conformance suite compares
 * `updatedAt` exactly, and a fixture that depended on sub-second precision would
 * fail a perfectly conformant driver.
 */
export const FIXTURE_TIME: Date = new Date("2026-07-30T00:00:00.000Z");

/**
 * Builds a {@link PolicyRecord}, defaulting everything but the id.
 *
 * Deep-cloned on the way out, defaults included. The conformance suite's
 * defensive-copy cases mutate the record they were handed, and a builder that
 * shared {@link PERMIT_ALL} or {@link FIXTURE_TIME} between calls would let one
 * test corrupt the next one's fixture — which is the very failure the case is
 * checking for, relocated into the test harness.
 */
export function policyRecordFixture(
	overrides: Partial<PolicyRecord> & { readonly id: string },
): PolicyRecord {
	return structuredClone({
		scope: "",
		kind: "static",
		cedarJson: PERMIT_ALL,
		enabled: true,
		updatedAt: FIXTURE_TIME,
		...overrides,
	} satisfies PolicyRecord);
}

/** Builds a {@link TemplateLinkRecord}, defaulting everything but the ids. Deep-cloned, as above. */
export function templateLinkFixture(
	overrides: Partial<TemplateLinkRecord> & { readonly id: string; readonly templateId: string },
): TemplateLinkRecord {
	return structuredClone({
		scope: "",
		values: {},
		updatedAt: FIXTURE_TIME,
		...overrides,
	} satisfies TemplateLinkRecord);
}

/** Convenience for a link's `values`, so callers do not spell the slot ids out. */
export function slotValues(
	values: Partial<Record<TemplateSlotId, EntityRef>>,
): Partial<Record<TemplateSlotId, EntityRef>> {
	return { ...values };
}

/** Scope ids the conformance suite writes to. Exported so a driver can pre-provision them. */
export const CONFORMANCE_SCOPES: {
	readonly a: PolicyScopeId;
	readonly b: PolicyScopeId;
} = Object.freeze({ a: "conformance:a", b: "conformance:b" });
