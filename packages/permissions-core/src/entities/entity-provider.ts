// The entity-resolution SPI.
//
// core.md §0 measured the cost this interface exists to control: adding 500
// irrelevant entities to a request took `statefulIsAuthorized` from 0.136 ms to
// 2.79 ms — a 20x regression. An `EntityProvider` therefore does **not** hand the
// engine "the entity graph"; it hands over the principal plus its transitive
// parents, the single resource plus the parents its policies traverse, and
// nothing else.
//
// The split into three methods is what makes that affordable: `resolvePrincipal`
// is the expensive one (roles, groups, organisation) and is the only part the
// engine memoises — across a `checkMany` batch always, and across requests when
// `entityCache` is enabled.

import type { EntityJson } from "../cedar/binding.ts";
import type { EntityRef } from "../cedar/uid.ts";
import type { PolicyScopeId } from "../policy/policy-store.ts";
import type { ActionOf, AnyVocabulary, EntityNameOf } from "../vocabulary/types.ts";

/**
 * Cedar's own entity shape, re-exported so a provider never needs a direct
 * dependency on `@cedar-policy/cedar-wasm`.
 */
export type { EntityJson } from "../cedar/binding.ts";

/**
 * A slice of the entity store, in Cedar's JSON form.
 *
 * Order is irrelevant to Cedar but duplicates are not: the engine deduplicates
 * by UID before every call (see `entityGraph`).
 */
export type EntityGraph = readonly EntityJson[];

/** What the engine tells a provider about the decision it is resolving for. */
export interface EntityResolutionRequest<V extends AnyVocabulary> {
	/** Policy scope of the check — the tenant key, `''` for global. */
	readonly scope: PolicyScopeId;
	/** Principal being authorized. Types are vocabulary-local, never qualified. */
	readonly principal: EntityRef;
	/** Action being authorized. */
	readonly action: ActionOf<V>;
	/** Resource being authorized. Absent when planning over a whole type (Phase 4). */
	readonly resource?: EntityRef;
	/**
	 * Resource type being authorized or planned over. Present on query-plan
	 * resolution even though there is no single {@link resource} instance.
	 */
	readonly resourceType?: EntityNameOf<V>;
}

/**
 * Supplies the entities one authorization decision needs.
 *
 * Every method returns a *narrow* graph. Returning the whole store is not a
 * shortcut, it is a 20x latency regression (core.md §0).
 *
 * ```ts
 * const provider: EntityProvider<typeof vocabulary> = {
 *   async resolvePrincipal({ principal }) {
 *     const member = await members.findById(principal.id);
 *     return [
 *       entity(vocabulary, "Member", member.id, {
 *         attrs: { organization: { type: "Organization", id: member.orgId } },
 *         parents: member.roles.map((role) => ({ type: "Role", id: role })),
 *       }),
 *       ...member.roles.map((role) => entity(vocabulary, "Role", role, { attrs: {} })),
 *     ];
 *   },
 * };
 * ```
 */
export interface EntityProvider<V extends AnyVocabulary> {
	/**
	 * The principal and its transitive parents (roles, groups, organisation).
	 *
	 * Required: it is the one graph every decision needs. The engine caches its
	 * result per `(scope, principal)` — within a `checkMany` batch unconditionally,
	 * and across requests when `entityCache` is enabled — so it must be a pure
	 * function of the request it is given.
	 */
	resolvePrincipal(request: EntityResolutionRequest<V>): Promise<EntityGraph>;

	/**
	 * The resource and the parents its policies traverse.
	 *
	 * Omit it when resources carry no attributes and no hierarchy: Cedar treats an
	 * entity absent from the slice as having no attributes and no parents, which is
	 * exactly right for an opaque id and costs nothing to resolve.
	 */
	resolveResource?(request: EntityResolutionRequest<V>): Promise<EntityGraph>;

	/**
	 * Extra entities a particular action needs — a policy that reaches through
	 * `resource.owner`, for instance. Rare; keep it empty when in doubt.
	 */
	resolveAdditional?(request: EntityResolutionRequest<V>): Promise<EntityGraph>;
}
