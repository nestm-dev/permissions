import { entityGraph } from "@nestm/permissions-core";
import type {
	CheckResult,
	EntityGraph,
	EntityRef,
	PolicyScopeId,
	QueryPlan,
} from "@nestm/permissions-core";

import type { AuthorizationEngine } from "../providers/engine.provider.ts";
import type { RouteEntityRequest } from "./entity-provider.registry.ts";
import type { ResolvedPrincipal } from "../interfaces/principal-resolver.interface.ts";
import type { RoutePermission } from "../interfaces/route-permission.interface.ts";
import type { ActionName, ResourceTypeName } from "../types/permissions-registry.types.ts";

/** Per-call overrides for {@link RequestAuthorization.planFor}. */
export interface RequestPlanOptions {
	/** Plan in a different scope. Defaults to the request's. */
	readonly scope?: PolicyScopeId;
	/** Replace the Cedar context. Defaults to the request's. */
	readonly context?: Readonly<Record<string, unknown>>;
	/** Replace the entity graph and skip entity re-resolution. */
	readonly entities?: EntityGraph;
}

/** Per-call overrides for {@link RequestAuthorization.can}. */
export interface RequestCanOptions {
	/** Check in a different scope. Defaults to the request's. */
	readonly scope?: PolicyScopeId;
	/** Replace the Cedar context. Defaults to the request's. */
	readonly context?: Readonly<Record<string, unknown>>;
	/** Replace the entity graph and skip entity re-resolution. */
	readonly entities?: EntityGraph;
}

/** Resolves fresh resource/additional contributions for an imperative question. */
export type RequestAuthorizationEntityResolver = (
	request: RouteEntityRequest,
) => EntityGraph | Promise<EntityGraph>;

/** Everything the guard hands to a {@link RequestAuthorization}. */
export interface RequestAuthorizationInit {
	readonly engine: AuthorizationEngine;
	/**
	 * Optional resource/additional entity resolver used by `planFor` and `can`.
	 * Manually constructed instances may omit it and retain the original graph.
	 */
	readonly entityResolver?: RequestAuthorizationEntityResolver;
	readonly principal: ResolvedPrincipal;
	readonly scope: PolicyScopeId;
	readonly context: Readonly<Record<string, unknown>>;
	readonly entities: EntityGraph;
	readonly route: RoutePermission | undefined;
	readonly resource: EntityRef | undefined;
	readonly result: CheckResult | undefined;
	readonly plan: QueryPlan | undefined;
}

/**
 * What the guard decided, as the handler sees it.
 *
 * Stashed at `request[AUTHORIZATION_STATE]` and read by `@CurrentPrincipal()`,
 * `@CurrentAuthorization()` and `@QueryPlan()`. Holding the engine is what makes
 * `planFor`/`can` safe for a later transaction: when the guard supplied its
 * optional entity resolver, each imperative question re-resolves the requested
 * action/resource and combines those fresh contributions with the principal
 * graph. Passing explicit `entities` skips that work. Manually constructed
 * instances with no resolver retain the original graph fallback.
 *
 * A class rather than a plain object so `RequestAuthorization` names both a type
 * and a value, and an `instanceof` check can tell a real one from something a
 * middleware happened to leave on the request.
 */
export class RequestAuthorization {
	/** The principal the decision was about, entity graph included. */
	readonly principal: ResolvedPrincipal;
	/** Scope the decision was made in. */
	readonly scope: PolicyScopeId;
	/** Cedar request context the guard built. */
	readonly context: Readonly<Record<string, unknown>>;
	/** The graph passed to Cedar — principal graph plus any provider contributions. */
	readonly entities: EntityGraph;
	/** The route's declaration, absent on a `@RequireAuthenticated()` route. */
	readonly route: RoutePermission | undefined;
	/** The resource the guard checked, absent on the plan and authenticated paths. */
	readonly resource: EntityRef | undefined;
	/** Cedar's answer, absent on the plan and authenticated paths. */
	readonly result: CheckResult | undefined;
	/** Precomputed when the route declared `resource: { kind: "unspecified" }`. */
	readonly plan: QueryPlan | undefined;

	readonly #engine: AuthorizationEngine;
	readonly #entityResolver: RequestAuthorizationEntityResolver | undefined;

	constructor(init: RequestAuthorizationInit) {
		this.#engine = init.engine;
		this.#entityResolver = init.entityResolver;
		this.principal = init.principal;
		this.scope = init.scope;
		this.context = init.context;
		this.entities = init.entities;
		this.route = init.route;
		this.resource = init.resource;
		this.result = init.result;
		this.plan = init.plan;
	}

	/**
	 * Compiles a query plan for another action/type pair on this request.
	 *
	 * The imperative twin of `resource: { kind: "unspecified" }` — for a handler
	 * that lists two kinds of thing, or filters a sub-collection.
	 */
	async planFor(
		action: ActionName,
		resourceType: ResourceTypeName,
		options: RequestPlanOptions = {},
	): Promise<QueryPlan> {
		const scope = options.scope ?? this.scope;
		return this.#engine.plan(
			// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see `widen` in permissions.service.ts: `ActionOf<AnyVocabulary>` is `never`, so the registry-typed signature above is where narrowing happens
			{
				scope,
				principal: this.principal.ref,
				action,
				resourceType,
				context: options.context ?? this.context,
				entities: await this.#entitiesFor(action, undefined, resourceType, scope, options.entities),
			} as Parameters<AuthorizationEngine["plan"]>[0],
		);
	}

	/**
	 * Asks one more yes/no question with the request's principal, scope and
	 * context, re-resolving resource entities when the guard supplied a resolver.
	 *
	 * Note the entity graph: if `resource` is not in it and no `@EntityProvider()`
	 * contributes it, Cedar sees an attribute-less, parent-less entity and the
	 * answer fails closed.
	 */
	async can(
		action: ActionName,
		resource: EntityRef<ResourceTypeName>,
		options: RequestCanOptions = {},
	): Promise<boolean> {
		const scope = options.scope ?? this.scope;
		const result = await this.#engine.checkUnsafe({
			scope,
			principal: this.principal.ref,
			action,
			resource,
			context: options.context ?? this.context,
			entities: await this.#entitiesFor(action, resource, resource.type, scope, options.entities),
		});
		return result.allowed;
	}

	async #entitiesFor(
		action: ActionName,
		resource: EntityRef | undefined,
		resourceType: ResourceTypeName,
		scope: PolicyScopeId,
		explicit: EntityGraph | undefined,
	): Promise<EntityGraph> {
		if (explicit !== undefined) {
			return explicit;
		}
		if (this.#entityResolver === undefined) {
			return this.entities;
		}

		const contributed = await this.#entityResolver({
			scope,
			principal: this.principal.ref,
			action,
			resourceType,
			...(resource === undefined ? {} : { resource }),
		});
		return entityGraph(...this.principal.entities, ...contributed);
	}
}
