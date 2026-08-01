import { entity, entityRef } from "@nestm/permissions-core";
import { NOT_IN_SCOPE, RequestPrincipalResolver } from "@nestm/permissions";
import type { EntityGraph } from "@nestm/permissions-core";

import { ORGANIZATION_ID, SCOPE, vocabulary } from "./vocabulary.ts";

/** What the (fake) auth layer writes onto `request.user`. */
export interface StationUser {
	readonly id: string;
	readonly organizationId: string;
	readonly roles: readonly string[];
}

/** The directory a real deployment would read from its own tables. */
export const USERS: Readonly<Record<string, StationUser>> = {
	alice: { id: "alice", organizationId: ORGANIZATION_ID, roles: ["reader"] },
	bob: { id: "bob", organizationId: ORGANIZATION_ID, roles: ["admin"] },
	// A member of the organisation with no roles at all: authenticated, in scope,
	// and permitted nothing.
	mallory: { id: "mallory", organizationId: ORGANIZATION_ID, roles: [] },
	// Authenticated, but belongs somewhere else entirely.
	trudy: { id: "trudy", organizationId: "other-corp", roles: ["admin"] },
};

/**
 * The principal's own graph: the member, its organisation, and its roles.
 *
 * Resolved **once per request** and handed to the guard, which passes it
 * straight to Cedar. That is why core's cross-request `entityCache` stays off by
 * default — per-request reuse is this function, not a cache.
 *
 * Keep it narrow. Adding entities a policy never traverses is measurably
 * expensive (core.md §0: 500 irrelevant entities took one check from 0.136 ms to
 * 2.79 ms).
 */
function principalGraph(user: StationUser): EntityGraph {
	const organization = entityRef("Organization", user.organizationId);
	return [
		entity(vocabulary, "Organization", user.organizationId, { attrs: {} }),
		...user.roles.map((role) =>
			entity(vocabulary, "Role", role, { attrs: {}, parents: [organization] }),
		),
		entity(vocabulary, "Member", user.id, {
			attrs: { organization },
			// Roles are *parents*, which is what makes `principal in Role::"admin"`
			// and the `role:reader` template link work.
			parents: [organization, ...user.roles.map((role) => entityRef("Role", role))],
		}),
	];
}

/**
 * Turns `request.user` into the principal Cedar decides about.
 *
 * One class covers better-auth (`property: "session"`), a plain JWT guard
 * (`"user"`) and station (`"identity"`) — it just reads a property, with zero
 * imports from any of them.
 *
 * The return union is the whole point:
 * - `null` → **401**, nobody is authenticated;
 * - `NOT_IN_SCOPE` → **404**, authenticated but not a member of this tenant, and
 *   therefore not allowed to learn that it exists;
 * - a principal → the decision proceeds.
 */
export const principalResolver = new RequestPrincipalResolver<StationUser>({
	property: "user",
	map: (user, { scope }) => {
		if (scope !== SCOPE || user.organizationId !== ORGANIZATION_ID) {
			return NOT_IN_SCOPE;
		}
		return { ref: { type: "Member", id: user.id }, entities: principalGraph(user) };
	},
});
