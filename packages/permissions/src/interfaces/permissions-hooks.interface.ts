import type { CheckResult, EntityRef, PolicyScopeId, QueryPlan } from "@nestm/permissions-core";

import type { PrincipalContextKind } from "./principal-resolver.interface.ts";
import type { RoutePermission } from "./route-permission.interface.ts";

/**
 * Why a request was refused.
 *
 * The two "the caller cannot see this tenant" arms are kept apart on purpose —
 * they arrive from different places and an audit sink wants to tell them apart —
 * but they **must** produce the same response, and the guard guarantees that by
 * building both from one constant (see `guards/authz-errors.ts`).
 */
export type PermissionsDenial =
	/** No principal could be resolved. */
	| { readonly reason: "unauthenticated" }
	/** Cedar said deny. */
	| { readonly reason: "forbidden"; readonly result: CheckResult }
	/** The route's `scope` gate denied — the 404 path. */
	| { readonly reason: "not-a-member"; readonly gate: string }
	/** The principal resolver returned `NOT_IN_SCOPE` — the same 404 path. */
	| { readonly reason: "not-in-scope" }
	/** The route declared `{ kind: "unspecified" }` and the plan was `ALWAYS_DENY`. */
	| { readonly reason: "plan-denied"; readonly plan: QueryPlan }
	/** The route declared nothing and `denial.onUndeclaredRoute` is `"deny"`. */
	| { readonly reason: "undeclared-route" }
	/** The engine is disposed or otherwise unable to decide. */
	| { readonly reason: "engine-unavailable" }
	/** A `{ kind: "param" }` reference did not parse. */
	| {
			readonly reason: "invalid-resource-param";
			readonly param: string;
			readonly issues: readonly string[];
	  }
	/**
	 * The request's **scope** could not be derived — a malformed tenant parameter,
	 * or a `scopeResolver` that refused.
	 *
	 * Distinct from `invalid-resource-param` although both are 400s: this one is
	 * raised *before* the principal is resolved, so it is the only denial that can
	 * be reported without knowing who is asking.
	 */
	| {
			readonly reason: "invalid-scope";
			/** Which layer refused. */
			readonly source: "scopeFrom" | "scopeResolver";
			/** The `scopeFrom: { kind: "param" }` name, when there was one. */
			readonly param: string | undefined;
			/** Messages, when the failure carried any. */
			readonly issues: readonly string[];
			/** Whatever was thrown. A `scopeResolver` may throw anything. */
			readonly error: unknown;
	  }
	/** The module is wired in a way that cannot produce a decision. */
	| { readonly reason: "misconfigured"; readonly detail: string };

/** What a hook is told about the request the denial happened on. */
export interface DenialContext {
	/** Transport-native request object. */
	readonly request: unknown;
	/** Transport the request arrived on. */
	readonly contextKind: PrincipalContextKind;
	/** Policy scope the decision was made in. */
	readonly scope: PolicyScopeId;
	/** `Controller.handler`, when the transport exposes one. */
	readonly route: string | undefined;
	/** The route's declaration, when it had one. */
	readonly routePermission: RoutePermission | undefined;
	/** The principal, when one was resolved before the denial. */
	readonly principal: EntityRef | undefined;
	/** The resource, when one was resolved before the denial. */
	readonly resource: EntityRef | undefined;
}

/** One route-level authorization decision, allow or deny. */
export interface RouteDecisionRecord {
	readonly contextKind: PrincipalContextKind;
	readonly scope: PolicyScopeId;
	readonly principal: EntityRef | undefined;
	readonly action: string | undefined;
	readonly resource: EntityRef | undefined;
	readonly result: CheckResult | undefined;
	readonly denial: PermissionsDenial | undefined;
	readonly route: string | undefined;
	/** Whether the request was let through. */
	readonly allowed: boolean;
	/** The plan, when the route declared `{ kind: "unspecified" }`. */
	readonly plan: QueryPlan | undefined;
	/** The route's declaration, when it had one. */
	readonly routePermission: RoutePermission | undefined;
	/** Wall time the guard spent, in milliseconds. */
	readonly durationMs: number;
}

/** What `denial.onInvalidParam` is told. */
export interface InvalidParamContext {
	/** Parameter name as declared on the `ResourceRef`. */
	readonly param: string;
	/** The raw value the router produced. */
	readonly value: unknown;
	/** Messages from the Standard Schema validator. */
	readonly issues: readonly string[];
	/** Transport the request arrived on. */
	readonly contextKind: PrincipalContextKind;
	/** `Controller.handler`. */
	readonly route: string | undefined;
}

/** What `denial.onInvalidScope` is told, alongside the raw error. */
export interface InvalidScopeContext {
	/** Which layer refused: the route's `scopeFrom`, or the module's `scopeResolver`. */
	readonly source: "scopeFrom" | "scopeResolver";
	/** The `scopeFrom: { kind: "param" }` name, when there was one. */
	readonly param: string | undefined;
	/** The raw value the router produced for {@link param}, when there was one. */
	readonly value: unknown;
	/** Messages, when the failure carried any. */
	readonly issues: readonly string[];
	/** Transport-native request object. */
	readonly request: unknown;
	/** Transport the request arrived on. */
	readonly contextKind: PrincipalContextKind;
	/** `Controller.handler`. */
	readonly route: string | undefined;
}

/** Application hooks around the guard's decision. */
export interface PermissionsHooks {
	/**
	 * Called before the guard throws. Return an `Error` to fully own the
	 * response (station returns its RFC 9457 exception here); return nothing to
	 * keep the default mapping.
	 *
	 * A throw from this hook propagates — returning an error and throwing one are
	 * both ways to own the response, and swallowing a throw would hide a bug in
	 * the hook behind a 403.
	 */
	onDenied?(
		denial: PermissionsDenial,
		context: DenialContext,
	): Error | void | Promise<Error | void>;
	/**
	 * Route-level audit sink, called on allow **and** deny. Never awaited by the
	 * guard and a throw is swallowed — an audit sink must not be able to fail a
	 * request.
	 *
	 * Distinct from `engine.onDecision`, which is core's per-`check` sink and
	 * fires for imperative `PermissionsService` calls too.
	 */
	onDecision?(record: RouteDecisionRecord): void | Promise<void>;
}
