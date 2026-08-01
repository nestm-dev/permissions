import type { EntityGraph, EntityRef, PolicyScopeId } from "@nestm/permissions-core";

/**
 * Transport a principal is being resolved for.
 *
 * v1 enforces `http` and `graphql`; `ws`/`rpc` are carried so a resolver can
 * produce the right shape of failure rather than silently reading a request
 * object that does not exist (design §4, "Transport scope, honestly").
 */
export type PrincipalContextKind = "http" | "graphql" | "ws" | "rpc";

/** What the guard tells a resolver about the request it is resolving for. */
export interface PrincipalResolutionContext {
	/**
	 * The transport-native request object — an `express`/`fastify` request, a
	 * GraphQL context, ... Deliberately `unknown`: this package never assumes a
	 * request shape, and a resolver that needs one narrows it itself.
	 */
	readonly request: unknown;
	/** Transport the request arrived on. */
	readonly contextKind: PrincipalContextKind;
	/** Policy scope the decision will be made in. */
	readonly scope: PolicyScopeId;
}

/** A principal, plus the entity graph a decision about it needs. */
export interface ResolvedPrincipal {
	/** Vocabulary-local entity reference, e.g. `{ type: "Member", id: "…" }`. */
	readonly ref: EntityRef;
	/**
	 * The principal and its transitive parents, resolved **once per request**.
	 *
	 * The guard passes this straight to `check({ entities })`, which is why
	 * core's cross-request `entityCache` stays off by default: per-request reuse
	 * is the caller's job and this field is how it is done.
	 */
	readonly entities: EntityGraph;
	/**
	 * Scope this principal actually belongs to, when the resolver knows better
	 * than the caller — a member row carrying its organisation id, say.
	 */
	readonly scopeHint?: PolicyScopeId;
}

/**
 * "Authenticated, but not a member of this scope."
 *
 * Distinct from `null` on purpose (plan.md, the Nest delta): `null` is
 * *unauthenticated* and maps to 401, while this maps to the **404 path** of
 * ADR-0014 without ever asking Cedar — a non-member must not be able to tell an
 * existing resource from a missing one.
 */
export interface NotInScope {
	readonly kind: "not-in-scope";
}

/** The single shared `not-in-scope` value. */
export const NOT_IN_SCOPE: NotInScope = Object.freeze({ kind: "not-in-scope" });

/** Everything {@link PrincipalResolver.resolve} may return. */
export type PrincipalResolution = ResolvedPrincipal | null | NotInScope;

/** Turns a transport request into the principal a decision is made about. */
export interface PrincipalResolver {
	resolve(context: PrincipalResolutionContext): PrincipalResolution | Promise<PrincipalResolution>;
}

/** Whether `resolution` is the {@link NotInScope} arm. */
export function isNotInScope(resolution: PrincipalResolution): resolution is NotInScope {
	return resolution !== null && "kind" in resolution && resolution.kind === "not-in-scope";
}

/** Whether `resolution` carries an actual principal. */
export function isResolvedPrincipal(
	resolution: PrincipalResolution,
): resolution is ResolvedPrincipal {
	return resolution !== null && "ref" in resolution;
}
