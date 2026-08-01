import type { SeedLink, SeedPolicy } from "@nestm/permissions";

import { ORGANIZATION_ID, SCOPE } from "./vocabulary.ts";
import { PROJECTS } from "../runs/runs.repository.ts";

/**
 * The policy set, seeded into the built-in in-memory store.
 *
 * A real deployment swaps the seeds for `store: { useClass: DrizzlePolicyStore }`
 * and edits rows; nothing else here changes. The shapes below are the three that
 * matter:
 *
 * 1. a **template** — the role-grant primitive. One template, one link per grant,
 *    revoked by deleting the link.
 * 2. a **static permit on a role group** — `principal in Station::Role::"admin"`,
 *    which works because `Member.memberOf` includes `Role`.
 * 3. a **forbid with a condition** — always beats a permit, and is what makes the
 *    query plan interesting rather than trivial.
 */
export const POLICIES: readonly SeedPolicy[] = [
	{
		id: "role:reader",
		scope: SCOPE,
		description: "Members of the linked role may read runs of the linked project.",
		text: `permit(
			principal in ?principal,
			action == Station::Action::"run:read",
			resource in ?resource
		);`,
	},
	{
		id: "role:dispatcher",
		scope: SCOPE,
		description: "Admins may dispatch any run in the organization.",
		text: `permit(
			principal in Station::Role::"admin",
			action == Station::Action::"run:dispatch",
			resource
		);`,
	},
	{
		id: "forbid:archived",
		scope: SCOPE,
		description: "Nobody reads an archived run, whatever else grants it.",
		text: `forbid(
			principal,
			action == Station::Action::"run:read",
			resource
		) when { resource.status == "archived" };`,
	},
];

/**
 * One grant: the `reader` role, on the `nightly` project.
 *
 * This is the row an admin UI would insert. Note that it names a *role*, not a
 * member — membership is the entity graph's job, so granting the role to a new
 * person is a change to your own tables, not to the policy store.
 */
export const LINKS: readonly SeedLink[] = [
	{
		id: "grant:reader-nightly",
		scope: SCOPE,
		templateId: "role:reader",
		values: {
			"?principal": { type: "Role", id: "reader" },
			"?resource": { type: "Project", id: PROJECTS.nightly },
		},
	},
];

export const ORGANIZATION = { type: "Organization", id: ORGANIZATION_ID } as const;
