// `PolicyBundle` -> cedar-wasm `PolicySet`.
//
// Two properties matter more than the mapping itself:
//
//   * **Determinism.** The output feeds `preparsePolicySet`, whose id is stable
//     per scope forever. Iterating a `Map` in insertion order would make the
//     prepared set depend on the order rows came back from a database. Every
//     collection here is sorted by id.
//
//   * **Fail loud.** Every structural problem — a link to a missing template, a
//     link to a *disabled* template, a slot the template does not declare — is a
//     `POLICY_INVALID` throw. Cedar catches most of them too, but a bad slot
//     *name* makes cedar-wasm throw a raw `Error` out of WASM rather than return
//     a failure answer, so the validation has to happen before the call.

import type { EntityUid, PolicyJson, PolicySet, TemplateLink } from "../cedar/binding.ts";
import { entityRefToUid } from "../cedar/uid.ts";
import { fail } from "../util/assert.ts";
import { templateSlotsOf } from "./policy-codec.ts";
import {
	TEMPLATE_SLOT_IDS,
	isTemplateSlotId,
	type PolicyBundle,
	type PolicyRecord,
	type TemplateLinkRecord,
	type TemplateSlotId,
} from "./policy-store.ts";

/** Options for {@link buildPolicySet}. */
export interface BuildPolicySetOptions {
	/**
	 * Vocabulary namespace used to qualify template-link entity refs.
	 *
	 * `TemplateLinkRecord.values` holds vocabulary-local types (`'Member'`); Cedar
	 * needs the qualified form (`'Station::Member'`). An already-qualified type is
	 * left alone, so the default (`''`) is correct for stores that persist
	 * qualified types.
	 */
	readonly namespace?: string;
}

function byId(left: { readonly id: string }, right: { readonly id: string }): number {
	if (left.id === right.id) {
		return 0;
	}
	return left.id < right.id ? -1 : 1;
}

function linkValues(
	link: TemplateLinkRecord,
	declared: readonly TemplateSlotId[],
	namespace: string,
	scope: string,
): Record<string, EntityUid> {
	const provided: TemplateSlotId[] = [];

	for (const [slot, ref] of Object.entries(link.values)) {
		if (ref === undefined) {
			continue;
		}
		if (!isTemplateSlotId(slot)) {
			fail(
				"POLICY_INVALID",
				`Template link "${link.id}" provides the slot "${slot}"; Cedar only accepts ` +
					`${TEMPLATE_SLOT_IDS.join(" and ")}.`,
				{ scope },
			);
		}
		provided.push(slot);
	}

	// D6: `values` is `Partial`, so the check is "exactly covers", in both
	// directions. Cedar reports each of these too, but only after the whole
	// policy set has been rejected — naming the offending link is worth more.
	const missing = declared.filter((slot) => !provided.includes(slot));
	if (missing.length > 0) {
		fail(
			"POLICY_INVALID",
			`Template link "${link.id}" is missing a value for ${missing.join(", ")}, ` +
				`declared by template "${link.templateId}".`,
			{ scope },
		);
	}

	const extra = provided.filter((slot) => !declared.includes(slot));
	if (extra.length > 0) {
		fail(
			"POLICY_INVALID",
			`Template link "${link.id}" provides ${extra.join(", ")}, which template ` +
				`"${link.templateId}" does not declare ` +
				`(declared: ${declared.length === 0 ? "none" : declared.join(", ")}).`,
			{ scope },
		);
	}

	const values: Record<string, EntityUid> = {};
	for (const slot of declared) {
		const ref = link.values[slot];
		if (ref !== undefined) {
			values[slot] = entityRefToUid(ref, namespace);
		}
	}
	return values;
}

/**
 * Compiles the effective bundle into the `PolicySet` shape cedar-wasm's
 * `preparsePolicySet` expects.
 *
 * Disabled records are dropped; a disabled *template* with live links is a
 * throw, because dropping it would silently revoke every grant it backs.
 *
 * @throws `PermissionsError` with code `POLICY_INVALID` for duplicate ids, a
 * link to an unknown or non-template or disabled policy, or link values that do
 * not exactly cover the template's declared slots (**D6**).
 */
export function buildPolicySet(
	bundle: PolicyBundle,
	options: BuildPolicySetOptions = {},
): PolicySet {
	const namespace = options.namespace ?? "";
	const scope = bundle.scope;

	const records = new Map<string, PolicyRecord>();
	for (const record of [...bundle.policies].toSorted(byId)) {
		if (records.has(record.id)) {
			fail("POLICY_INVALID", `Duplicate policy id "${record.id}" in the bundle.`, { scope });
		}
		records.set(record.id, record);
	}

	const staticPolicies: Record<string, PolicyJson> = {};
	const templates: Record<string, PolicyJson> = {};

	for (const record of records.values()) {
		if (!record.enabled) {
			continue;
		}
		if (record.kind === "template") {
			templates[record.id] = record.cedarJson;
		} else {
			staticPolicies[record.id] = record.cedarJson;
		}
	}

	const templateLinks: TemplateLink[] = [];
	const linkIds = new Set<string>();

	for (const link of [...bundle.links].toSorted(byId)) {
		if (linkIds.has(link.id)) {
			fail("POLICY_INVALID", `Duplicate template link id "${link.id}" in the bundle.`, { scope });
		}
		linkIds.add(link.id);

		if (Object.hasOwn(staticPolicies, link.id) || Object.hasOwn(templates, link.id)) {
			fail("POLICY_INVALID", `Template link "${link.id}" collides with a policy of the same id.`, {
				scope,
			});
		}

		const template = records.get(link.templateId);
		if (template === undefined) {
			fail(
				"POLICY_INVALID",
				`Template link "${link.id}" references the unknown template "${link.templateId}".`,
				{ scope },
			);
		}
		if (template.kind !== "template") {
			fail(
				"POLICY_INVALID",
				`Template link "${link.id}" references "${link.templateId}", which is a static policy.`,
				{ scope },
			);
		}
		if (!template.enabled) {
			fail(
				"POLICY_INVALID",
				`Template "${link.templateId}" is disabled but link "${link.id}" still references it. ` +
					`Remove the link first — dropping it silently would revoke the grant it backs.`,
				{ scope },
			);
		}

		templateLinks.push({
			templateId: link.templateId,
			newId: link.id,
			values: linkValues(link, templateSlotsOf(template.cedarJson), namespace, scope),
		});
	}

	// All three keys are always present, empty or not: a stable shape keeps the
	// prepared set (and anything hashing it) independent of which halves the
	// tenant happens to use.
	return { staticPolicies, templates, templateLinks };
}
