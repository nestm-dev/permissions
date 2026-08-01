import { defineVocabulary, entity, entityRef, t } from "@nestm/permissions-core";
import type { EntityGraph } from "@nestm/permissions-core";

import type { SeedPolicy } from "../../src/index.ts";

/**
 * A deliberately small vocabulary: one hierarchy (`Member in Org`, `Run in
 * Project in Org`) and three actions, which is the least that still exercises
 * a transitive `in` and an attribute condition.
 */
export const testVocabulary = defineVocabulary({
	namespace: "Test",
	entities: {
		Organization: {},
		Project: {
			memberOf: ["Organization"],
			attrs: { organization: t.ref("Organization") },
		},
		Member: {
			memberOf: ["Organization"],
			attrs: { organization: t.ref("Organization"), role: t.string() },
		},
		Run: {
			memberOf: ["Project"],
			attrs: { project: t.ref("Project"), status: t.string() },
		},
	},
	actions: {
		"run:read": { principal: ["Member"], resource: ["Run"] },
		"run:dispatch": { principal: ["Member"], resource: ["Run"] },
		"project:manage": { principal: ["Member"], resource: ["Project"] },
	},
});

export type TestVocabulary = typeof testVocabulary;

export const TEST_SCOPE = "org:acme";

/** Ids used by every suite, so a graph built in one place is readable in another. */
export const IDS = {
	organization: "acme",
	project: "proj-1",
	run: "run-1",
	member: "member-1",
	outsider: "member-2",
} as const;

/**
 * `run:read` is granted to any member of the organisation; `run:dispatch` only
 * to members whose `role` is `"admin"`. That gives every suite one allow and one
 * deny against the same principal.
 */
export const SEED_POLICIES: readonly SeedPolicy[] = [
	{
		id: "members-may-read-runs",
		scope: TEST_SCOPE,
		text: `permit(
			principal in Test::Organization::"${IDS.organization}",
			action == Test::Action::"run:read",
			resource
		);`,
	},
	{
		id: "admins-may-dispatch-runs",
		scope: TEST_SCOPE,
		text: `permit(
			principal in Test::Organization::"${IDS.organization}",
			action == Test::Action::"run:dispatch",
			resource
		) when { principal.role == "admin" };`,
	},
];

/** The principal graph a member's entity provider would return. */
export function memberGraph(memberId: string, role: string): EntityGraph {
	return [
		entity(testVocabulary, "Organization", IDS.organization, { attrs: {} }),
		entity(testVocabulary, "Member", memberId, {
			attrs: { organization: entityRef("Organization", IDS.organization), role },
			parents: [entityRef("Organization", IDS.organization)],
		}),
	];
}

/** The resource graph for the shared run. */
export function runGraph(): EntityGraph {
	return [
		entity(testVocabulary, "Project", IDS.project, {
			attrs: { organization: entityRef("Organization", IDS.organization) },
			parents: [entityRef("Organization", IDS.organization)],
		}),
		entity(testVocabulary, "Run", IDS.run, {
			attrs: { project: entityRef("Project", IDS.project), status: "queued" },
			parents: [entityRef("Project", IDS.project)],
		}),
	];
}
