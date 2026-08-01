import type { ExecutionContext } from "@nestjs/common";
import type { EntityRef, PolicyScopeId } from "@nestm/permissions-core";

import type { PrincipalContextKind, ResolvedPrincipal } from "./principal-resolver.interface.ts";
import type { ActionName, ResourceTypeName } from "../types/permissions-registry.types.ts";
import type { StandardSchemaV1 } from "../types/standard-schema.types.ts";

/**
 * What the guard knows about a request before it has a principal.
 *
 * `params` is the transport's route parameters — `request.params` on HTTP, the
 * field arguments on GraphQL. Guards run **before pipes**, so these values are
 * whatever the router produced: strings, or `undefined`.
 */
export interface RouteResolutionContext {
	/** Transport-native request object. */
	readonly request: unknown;
	/** Transport the request arrived on. */
	readonly contextKind: PrincipalContextKind;
	/** Route parameters / GraphQL arguments, unparsed. */
	readonly params: Readonly<Record<string, unknown>>;
	/** `Controller.handler`, for diagnostics. */
	readonly route: string;
	/**
	 * Action the route declared, or `undefined` on a `@RequireAuthenticated()`
	 * route — which has a scope and a principal but no action. A `scopeResolver`
	 * that branches on the action must handle that case.
	 */
	readonly action: ActionName | undefined;
	/** The raw Nest execution context, for anything the fields above do not cover. */
	readonly executionContext: ExecutionContext;
}

/** What `PermissionsModuleOptions.scopeResolver` is told. Runs before the principal exists. */
export type ScopeResolutionContext = RouteResolutionContext;

/** What a `{ kind: "resolver" }` {@link ResourceRef} is told. Runs after the principal exists. */
export interface ResourceResolutionContext extends RouteResolutionContext {
	/** Scope the decision will be made in. */
	readonly scope: PolicyScopeId;
	/** The principal the decision is about. */
	readonly principal: ResolvedPrincipal;
	/** Narrowed: a resource is only ever resolved for a declared action. */
	readonly action: ActionName;
}

/** What a route-level `context` builder is told. Same shape as a resource resolver. */
export type RouteContextBuilderContext = ResourceResolutionContext;

/**
 * How the guard finds the resource a route acts on.
 *
 * Four shapes, and the choice is load-bearing:
 *
 * - **`param`** — the common case. The value is read from the route parameter
 *   and, because guards run before pipes, validated here with `parseAs`.
 * - **`literal`** — a fixed entity, e.g. the singleton settings row.
 * - **`unspecified`** — *no* resource is named, so the guard asks for a
 *   {@link QueryPlan} instead of a decision: `ALWAYS_DENY` refuses the request,
 *   anything else allows it and stashes the plan for the handler to push into
 *   its query. This is what a list endpoint declares.
 * - **`resolver`** — anything else: a body field, a header, a lookup.
 */
export type ResourceRef =
	| {
			readonly kind: "param";
			/** Route parameter (HTTP) or field argument (GraphQL) holding the id. */
			readonly param: string;
			/** Vocabulary-local entity type of the resource. */
			readonly type: ResourceTypeName;
			/**
			 * Standard Schema validator applied to the raw parameter.
			 *
			 * **Omitting it is a footgun** and the guard warns once per route: the raw
			 * string goes to Cedar as the entity id, so `/runs/../../etc` becomes an
			 * entity id, and a policy that would have denied a malformed id instead
			 * denies (or, with a `forbid` on an attribute, *allows*) something else.
			 * Pass the same branded schema the handler's pipe uses.
			 */
			readonly parseAs?: StandardSchemaV1;
	  }
	| { readonly kind: "literal"; readonly type: ResourceTypeName; readonly id: string }
	| { readonly kind: "unspecified"; readonly type: ResourceTypeName }
	| {
			readonly kind: "resolver";
			readonly resolve: (context: ResourceResolutionContext) => EntityRef | Promise<EntityRef>;
	  };

/**
 * How the guard derives the Cedar {@link PolicyScopeId} for a route.
 *
 * See the README's "Scope resolution" section; the short version is that the
 * winner is the **most explicit** source, and the principal's `scopeHint` is
 * consulted only when nothing else produced one.
 */
export type ScopeSource =
	| {
			readonly kind: "param";
			/** Route parameter holding the tenant key. */
			readonly param: string;
			/** Prepended to the parameter value, e.g. `"org:"` → `org:8f3e…`. */
			readonly prefix?: string;
	  }
	| { readonly kind: "literal"; readonly scope: PolicyScopeId }
	/** Delegate to the module-level `scopeResolver`. */
	| { readonly kind: "resolver" };

/** The membership gate evaluated before the action check. A denial here is a 404. */
export interface RouteScopeGate {
	readonly action: ActionName;
	readonly resource: ResourceRef;
}

/** Third argument of `@RequirePermission()`. */
export interface RoutePermissionOptions {
	/**
	 * A check evaluated **before** the action check, whose denial yields the
	 * not-found response rather than a forbidden one (ADR-0014).
	 *
	 * This is the "is the caller even a member of this tenant" gate: a
	 * non-member must not be able to tell an existing resource from a missing
	 * one, so its denial is indistinguishable from an unknown tenant's.
	 */
	readonly scope?: RouteScopeGate;
	/** Overrides `denial.default` for this route's own authorization denial. */
	readonly onDeny?: "forbidden" | "not-found";
	/** Overrides the module-level `contextBuilder` for this route. */
	readonly context?: (
		context: RouteContextBuilderContext,
	) => Record<string, unknown> | Promise<Record<string, unknown>>;
	/** Overrides how the scope is derived for this route. */
	readonly scopeFrom?: ScopeSource;
}

/** The metadata `@RequirePermission()` writes, as the guard and the audit read it. */
export interface RoutePermission {
	readonly action: ActionName;
	/**
	 * The declared resource, or `undefined` when the decorator named none — in
	 * which case the guard infers `{ kind: "unspecified" }` from the action's own
	 * declared resource type and plans instead of checking.
	 */
	readonly resource: ResourceRef | undefined;
	readonly options: RoutePermissionOptions;
}
