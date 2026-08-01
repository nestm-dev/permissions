import { defineVocabulary, t } from "@nestm/permissions-core";

/**
 * One source, two outputs: the Cedar schema the engine validates against, and
 * the TypeScript string-literal unions every call site is checked against.
 *
 * **Roles are parent groups**, not an attribute. `Member: { memberOf: [..., "Role"] }`
 * is what makes `principal in Station::Role::"admin"` work, and it is what lets a
 * grant be one template link instead of a policy per member.
 */
export const vocabulary = defineVocabulary({
	namespace: "Station",
	entities: {
		Organization: {},
		Role: { memberOf: ["Organization"] },
		Member: {
			memberOf: ["Organization", "Role"],
			attrs: { organization: t.ref("Organization") },
		},
		Project: { memberOf: ["Organization"] },
		Run: {
			memberOf: ["Project"],
			attrs: { project: t.ref("Project"), status: t.string() },
		},
	},
	actions: {
		"run:read": { principal: ["Member"], resource: ["Run"] },
		"run:dispatch": { principal: ["Member"], resource: ["Run"] },
	},
});

export type StationVocabulary = typeof vocabulary;

/** The one tenant this example serves. Policies are stored per scope. */
export const ORGANIZATION_ID = "acme";
export const SCOPE = `org:${ORGANIZATION_ID}`;

/**
 * Makes every default-generic type in `@nestm/permissions` vocabulary-aware.
 *
 * With this in place `@RequirePermission("run:dispathc")` is a compile error,
 * and `resourceType: "Runn"` on a plan is too.
 */
declare module "@nestm/permissions" {
	interface PermissionsTypeRegistry {
		vocabulary: StationVocabulary;
	}
}
