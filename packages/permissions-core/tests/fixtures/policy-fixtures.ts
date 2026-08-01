import type { PolicyJson } from "../../src/cedar/binding.ts";
import type {
	PolicyBundle,
	PolicyRecord,
	PolicyScopeId,
	TemplateLinkRecord,
} from "../../src/policy/policy-store.ts";

/**
 * Hand-written Cedar JSON so the unit suites never touch the WASM.
 *
 * Every literal here was produced by `policyToJson`/`templateToJson` against
 * cedar-wasm 4.12.0 and pasted verbatim; the integration suites re-derive them
 * from text, which is what keeps them honest.
 */

/** `permit(principal, action, resource);` */
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

/** `permit(principal == ?principal, action, resource in ?resource);` */
export const TEMPLATE_BOTH_SLOTS: PolicyJson = {
	effect: "permit",
	principal: { op: "==", slot: "?principal" },
	action: { op: "All" },
	resource: { op: "in", slot: "?resource" },
	conditions: [],
};

/** `permit(principal == ?principal, action, resource);` */
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

/** Fixed timestamp so records are comparable across runs. */
export const FIXED_TIME = new Date("2026-07-30T00:00:00.000Z");

/** Builds a {@link PolicyRecord} with sane defaults. */
export function policyRecord(overrides: Partial<PolicyRecord> & { id: string }): PolicyRecord {
	return {
		scope: "",
		kind: "static",
		cedarJson: PERMIT_ALL,
		enabled: true,
		updatedAt: FIXED_TIME,
		...overrides,
	};
}

/** Builds a {@link TemplateLinkRecord} with sane defaults. */
export function linkRecord(
	overrides: Partial<TemplateLinkRecord> & { id: string; templateId: string },
): TemplateLinkRecord {
	return {
		scope: "",
		values: {},
		updatedAt: FIXED_TIME,
		...overrides,
	};
}

/** Builds a {@link PolicyBundle} with sane defaults. */
export function bundle(
	overrides: Partial<PolicyBundle> & { scope?: PolicyScopeId } = {},
): PolicyBundle {
	return {
		scope: "org:1",
		version: "g0:s0",
		policies: [],
		links: [],
		...overrides,
	};
}
