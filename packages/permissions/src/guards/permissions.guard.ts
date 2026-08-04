import { Inject, Injectable, Logger } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import {
	GLOBAL_POLICY_SCOPE,
	entityGraph,
	isPermissionsError,
	normalizeEntityUid,
	unqualifyEntityType,
} from "@nestm/permissions-core";
import type { CanActivate, ExecutionContext } from "@nestjs/common";
import type {
	CheckResult,
	EntityGraph,
	EntityRef,
	PolicyScopeId,
	QueryPlan,
} from "@nestm/permissions-core";

import { AUTHORIZATION_STATE, METADATA_KEY } from "../permissions.constants.ts";
import {
	AUTHORIZATION_ENGINE,
	PERMISSIONS_MODULE_OPTIONS,
	PRINCIPAL_RESOLVER,
} from "../permissions.tokens.ts";
import { EntityProviderRegistry } from "../services/entity-provider.registry.ts";
import { PolicySetManager } from "../services/policy-set.manager.ts";
import { RequestAuthorization } from "../services/request-authorization.ts";
import { isNotInScope } from "../interfaces/principal-resolver.interface.ts";
import {
	ResourceParamError,
	RoutePermissionConfigurationError,
	inferResourceRef,
	resolveResourceRef,
	resolveScopeSource,
} from "../resolvers/resource-ref.resolver.ts";
import {
	getRequestFromContext,
	getRouteParams,
	resolveContextKind,
	routeLabel,
} from "../utils/execution-context.util.ts";
import { createAuthorizationError, type AuthorizationErrorStatus } from "./authz-errors.ts";
import type { AuthorizationEngine } from "../providers/engine.provider.ts";
import type {
	DenialContext,
	PermissionsDenial,
	RouteDecisionRecord,
} from "../interfaces/permissions-hooks.interface.ts";
import type { PermissionsModuleOptions } from "../interfaces/permissions-module-options.interface.ts";
import type {
	PrincipalContextKind,
	PrincipalResolver,
	ResolvedPrincipal,
} from "../interfaces/principal-resolver.interface.ts";
import type {
	ResourceRef,
	ResourceResolutionContext,
	RoutePermission,
	RouteResolutionContext,
} from "../interfaces/route-permission.interface.ts";
import type { ActionName } from "../types/permissions-registry.types.ts";

/** Whatever `Reflector.get` accepts as a metadata target. */
type ReflectTarget = Parameters<Reflector["get"]>[1];

/** Carries a denial out of a helper. Never escapes `canActivate`. */
class DenialSignal extends Error {
	readonly denial: PermissionsDenial;

	constructor(denial: PermissionsDenial) {
		super(denial.reason);
		this.name = "DenialSignal";
		this.denial = denial;
	}
}

/** Everything the guard has learned about one request. Grows as the flow proceeds. */
interface RequestState {
	readonly executionContext: ExecutionContext;
	readonly contextKind: PrincipalContextKind;
	readonly request: unknown;
	readonly route: string;
	readonly params: Readonly<Record<string, unknown>>;
	readonly routePermission: RoutePermission | undefined;
	readonly startedAt: number;
	scope: PolicyScopeId;
	principal: ResolvedPrincipal | undefined;
	resource: EntityRef | undefined;
	cedarContext: Readonly<Record<string, unknown>>;
	entities: EntityGraph;
	result: CheckResult | undefined;
	plan: QueryPlan | undefined;
}

/**
 * Enforces each route's declared permission.
 *
 * The flow is design §4's twelve steps, and every one of them fails closed:
 *
 *  1. `@Public()` — honoured, **unless** the handler itself declares
 *     `@RequirePermission()`/`@RequireAuthenticated()`, because a class-level
 *     marker must never silently defeat an explicit route-level requirement.
 *  2. Read the route's declaration. Absent → deny (`denial.onUndeclaredRoute`).
 *  3. `PolicySetManager.assertReady()` → 503 rather than a decision made without
 *     policies.
 *  4. Resolve the principal: `null` → 401, `NOT_IN_SCOPE` → the not-found path,
 *     no resolver configured → 500 naming the missing option.
 *  5. `@RequireAuthenticated()` → stash and allow.
 *  6. Resolve the scope and the resource reference. Guards run **before pipes**,
 *     so a `param` reference is validated here with its `parseAs` schema.
 *  7. Build the Cedar context: route override, else module `contextBuilder`.
 *  8. Collect entities — the principal graph, resolved once, plus whatever the
 *     `@EntityProvider()` registry contributes for this resource.
 *  9. The optional `scope` gate: a denial here is `not-a-member`, which is the
 *     not-found path and cannot be downgraded to a 403.
 * 10. The decision: `unspecified` compiles a query plan (`ALWAYS_DENY` refuses,
 *     anything else allows and stashes it), otherwise one `check`.
 * 11. Stash `RequestAuthorization` at `request[AUTHORIZATION_STATE]`.
 * 12. `hooks.onDecision(record)`, swallowed — an audit sink must not be able to
 *     fail a request.
 *
 * Scope resolution is worth stating precisely, because the guard has to know the
 * scope *before* it has a principal (the principal resolver is told which scope
 * it is being asked about). The order is: the route's `scopeFrom`, then the
 * module's `scopeResolver`, then — only if neither produced one — the resolved
 * principal's own `scopeHint`, then the global scope. An explicitly derived
 * scope always wins over a hint: when the URL says one tenant and the principal
 * claims another, honouring the principal is a cross-tenant read.
 *
 * Transport support is `http` and `graphql`. `ws`/`rpc` get the right exception
 * types, but a `{ kind: "param" }` reference has nothing to read there and is a
 * configuration error rather than a silent miss.
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
	private readonly logger = new Logger(PermissionsGuard.name);
	private readonly warned = new Set<string>();

	constructor(
		private readonly reflector: Reflector,
		@Inject(PERMISSIONS_MODULE_OPTIONS) private readonly options: PermissionsModuleOptions,
		@Inject(AUTHORIZATION_ENGINE) private readonly engine: AuthorizationEngine,
		@Inject(PRINCIPAL_RESOLVER) private readonly principalResolver: PrincipalResolver | undefined,
		private readonly policySets: PolicySetManager,
		private readonly entityProviders: EntityProviderRegistry,
	) {}

	async canActivate(executionContext: ExecutionContext): Promise<boolean> {
		const handler = executionContext.getHandler();
		const targets = [handler, executionContext.getClass()];

		const routePermission = this.reflector.getAllAndOverride<RoutePermission | undefined>(
			METADATA_KEY.requirePermission,
			targets,
		);
		const requireAuthenticated =
			this.reflector.getAllAndOverride<true | undefined>(
				METADATA_KEY.requireAuthenticated,
				targets,
			) === true;

		// 1 — @Public, with the handler-level override. Foreign public keys
		// (`interop.publicKeys`) are honoured here, on the same terms.
		if (this.isPublic(handler, targets)) {
			return true;
		}

		// 1b — interop: a route declared by *another* guard's decorator and by none
		// of ours. Abstain — return true without deciding anything — so the guard
		// that owns that key stays the one enforcing it. Checked after the own
		// declaration is read, so a route that has migrated is decided here.
		if (
			routePermission === undefined &&
			!requireAuthenticated &&
			this.hasForeignDeclaration(targets)
		) {
			// Deliberately not `warnOnce`: an abstention is not a hole. Another guard
			// is enforcing this route, `routeAudit.additionalMetadataKeys` counts it as
			// covered, and warning per route would make a legitimate migration noisy
			// enough to be muted.
			this.debugOnce(
				`interop:${routeLabel(executionContext)}`,
				`${routeLabel(executionContext)} is declared by an \`interop.declaredKeys\` metadata ` +
					"key and by none of this package's decorators, so PermissionsGuard abstained and the " +
					"guard owning that key decides. Add @RequirePermission()/@RequireAuthenticated() to " +
					"migrate the route.",
			);
			return true;
		}

		const contextKind = resolveContextKind(executionContext);
		const request: unknown = await getRequestFromContext(executionContext);
		const state: RequestState = {
			executionContext,
			contextKind,
			request,
			route: routeLabel(executionContext),
			params: await getRouteParams(executionContext, request),
			routePermission,
			startedAt: Date.now(),
			scope: GLOBAL_POLICY_SCOPE,
			principal: undefined,
			resource: undefined,
			cedarContext: {},
			entities: [],
			result: undefined,
			plan: undefined,
		};

		try {
			return await this.decide(state, requireAuthenticated);
		} catch (error) {
			const denial = this.toDenial(error, state);
			if (denial === undefined) {
				throw error;
			}
			this.emitDecision(state, denial);
			throw await this.denialError(denial, state);
		}
	}

	// -------------------------------------------------------------------------
	// The flow
	// -------------------------------------------------------------------------

	private async decide(state: RequestState, requireAuthenticated: boolean): Promise<boolean> {
		// 2 — the route's declaration.
		if (state.routePermission === undefined && !requireAuthenticated) {
			if (this.options.denial?.onUndeclaredRoute === "allow") {
				this.warnOnce(
					`undeclared:${state.route}`,
					`${state.route} declares no @RequirePermission()/@RequireAuthenticated()/@Public(), ` +
						'and `denial.onUndeclaredRoute: "allow"` let it through. Turn on `routeAudit` so ' +
						"the gap stays visible.",
				);
				return true;
			}
			throw new DenialSignal({ reason: "undeclared-route" });
		}

		// 3 — the engine must be able to decide at all.
		try {
			this.policySets.assertReady();
		} catch {
			throw new DenialSignal({ reason: "engine-unavailable" });
		}

		// 6a — the scope. Resolved before the principal because the principal
		// resolver is told which scope it is being asked about — which is also why a
		// scope that cannot be derived is a 400 rather than a 401: the request is
		// unanswerable before there is anyone to attribute it to.
		const derivedScope = await this.resolveScope(state);
		state.scope = derivedScope ?? GLOBAL_POLICY_SCOPE;

		// 4 — the principal.
		const principal = await this.resolvePrincipal(state);
		state.principal = principal;

		// The principal may know its own tenant. Consulted only when nothing more
		// explicit produced one: a URL-derived scope always wins.
		if (derivedScope === undefined && principal.scopeHint !== undefined) {
			state.scope = principal.scopeHint;
		}

		// 5 — authenticated is enough.
		const route = state.routePermission;
		if (route === undefined) {
			this.stash(state);
			this.emitDecision(state, undefined);
			return true;
		}

		// 6b — the resource reference.
		const resourceRef = route.resource ?? this.inferResource(route.action, state);
		let resource: EntityRef | undefined;
		let planResourceType: string | undefined;
		if (resourceRef.kind === "unspecified") {
			planResourceType = resourceRef.type;
		} else {
			this.warnOnUnvalidatedParam(resourceRef, state);
			resource = await resolveResourceRef(
				resourceRef,
				this.resourceContext(state, principal, route.action),
			);
			state.resource = resource;
		}

		// 7 — the Cedar context.
		state.cedarContext = await this.buildContext(state, principal, route.action);

		// 8 — the entity graph, resolved once and passed explicitly.
		state.entities = await this.collectEntities(state, principal, route.action, planResourceType);

		// 9 — the membership gate.
		const gate = route.options.scope;
		if (gate !== undefined) {
			await this.runScopeGate(state, principal, gate.action, gate.resource);
		}

		// 10 — the decision.
		if (planResourceType !== undefined) {
			const plan = await this.engine.plan(
				// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- `ActionOf<AnyVocabulary>` is `never`; narrowing lives on the decorator's signature
				{
					scope: state.scope,
					principal: principal.ref,
					action: route.action,
					resourceType: planResourceType,
					context: state.cedarContext,
					entities: state.entities,
				} as Parameters<AuthorizationEngine["plan"]>[0],
			);
			state.plan = plan;
			if (plan.kind === "ALWAYS_DENY") {
				throw new DenialSignal({ reason: "plan-denied", plan });
			}
		} else if (resource !== undefined) {
			const result = await this.engine.checkUnsafe({
				scope: state.scope,
				principal: principal.ref,
				action: route.action,
				resource,
				context: state.cedarContext,
				entities: state.entities,
			});
			state.result = result;
			if (!result.allowed) {
				throw new DenialSignal({ reason: "forbidden", result });
			}
		} else {
			// Unreachable: every non-`unspecified` reference resolves to an entity or
			// throws. Stated rather than asserted away, because "no resource and no
			// plan" must never fall through to an allow.
			throw new RoutePermissionConfigurationError(
				`${state.route}: neither a resource nor a query plan could be produced for ` +
					`"${route.action}".`,
			);
		}

		// 11 + 12.
		this.stash(state);
		this.emitDecision(state, undefined);
		return true;
	}

	// -------------------------------------------------------------------------
	// Steps
	// -------------------------------------------------------------------------

	/**
	 * `@Public()` wins, unless the *handler* declares authorization of its own and
	 * the public marker came from the class. Copied from `BetterAuthGuard`
	 * (`better-auth.guard.ts:60-86`) because the failure it prevents — a
	 * controller-wide `@Public()` silently defeating one guarded route — is the
	 * same one.
	 */
	private isPublic(handler: ReflectTarget, targets: ReflectTarget[]): boolean {
		const keys = [METADATA_KEY.public, ...(this.options.interop?.publicKeys ?? [])];
		if (keys.some((key) => this.reflector.get<unknown>(key, handler) !== undefined)) {
			return true;
		}
		if (this.handlerDeclaresAuthorization(handler)) {
			return false;
		}
		return keys.some(
			(key) => this.reflector.getAllAndOverride<unknown>(key, targets) !== undefined,
		);
	}

	/**
	 * Whether another guard's decorator declares this route.
	 *
	 * `getAllAndOverride` rather than `get`: a legacy decorator applied to the
	 * whole controller declares every one of its handlers, which is exactly the
	 * shape a class-level `@Roles('admin')` has.
	 */
	private hasForeignDeclaration(targets: ReflectTarget[]): boolean {
		const keys = this.options.interop?.declaredKeys ?? [];
		return keys.some(
			(key) => this.reflector.getAllAndOverride<unknown>(key, targets) !== undefined,
		);
	}

	private handlerDeclaresAuthorization(handler: ReflectTarget): boolean {
		return (
			this.reflector.get<RoutePermission | undefined>(METADATA_KEY.requirePermission, handler) !==
				undefined ||
			this.reflector.get<true | undefined>(METADATA_KEY.requireAuthenticated, handler) !== undefined
		);
	}

	/**
	 * The scope, from the route's `scopeFrom` then the module's `scopeResolver`.
	 *
	 * Every failure on this path is an `invalid-scope` denial — a 400 — and none of
	 * it escapes as a 500. A `scopeResolver` may throw anything at all (a Zod
	 * error, an `HttpException`, a string): rejecting a malformed tenant parameter
	 * by throwing is the natural thing to write, and before this it was the thing
	 * that produced an unhandled 500.
	 *
	 * A `RoutePermissionConfigurationError` is the one exception, and is left to
	 * propagate to the `misconfigured` 500 it already maps to: `scopeFrom:
	 * { kind: "param" }` on a transport with no route parameters is the developer's
	 * mistake, not the caller's, and reporting it as a 400 would tell the caller to
	 * fix a request that has nothing wrong with it.
	 */
	private async resolveScope(state: RequestState): Promise<PolicyScopeId | undefined> {
		const scopeFrom = state.routePermission?.options.scopeFrom;

		let declaredScope: PolicyScopeId | undefined;
		try {
			declaredScope = await resolveScopeSource(scopeFrom, this.routeContext(state));
		} catch (error) {
			if (error instanceof RoutePermissionConfigurationError) {
				throw error;
			}
			throw new DenialSignal({
				reason: "invalid-scope",
				source: "scopeFrom",
				param: scopeFrom?.kind === "param" ? scopeFrom.param : undefined,
				issues: error instanceof ResourceParamError ? error.issues : [describe(error)],
				error,
			});
		}

		if (declaredScope !== undefined) {
			return declaredScope;
		}

		const resolver = this.options.scopeResolver;
		if (resolver === undefined) {
			return undefined;
		}
		try {
			return await resolver(this.routeContext(state));
		} catch (error) {
			if (error instanceof RoutePermissionConfigurationError) {
				throw error;
			}
			throw new DenialSignal({
				reason: "invalid-scope",
				source: "scopeResolver",
				param: undefined,
				issues: error instanceof ResourceParamError ? error.issues : [describe(error)],
				error,
			});
		}
	}

	private async resolvePrincipal(state: RequestState): Promise<ResolvedPrincipal> {
		if (this.principalResolver === undefined) {
			throw new DenialSignal({
				reason: "misconfigured",
				detail:
					"PermissionsModule was registered without `principalResolver`, so no request can be " +
					"attributed to a principal. Configure one — RequestPrincipalResolver covers " +
					"better-auth, a plain JWT guard and a custom identity — or mark the route @Public().",
			});
		}

		const resolution = await this.principalResolver.resolve({
			request: state.request,
			contextKind: state.contextKind,
			scope: state.scope,
		});

		if (resolution === null) {
			this.warnOnce(
				"unauthenticated",
				"A guarded route was reached with no principal. If an authentication guard is supposed " +
					"to run first, register it as an APP_GUARD *before* PermissionsModule — two APP_GUARD " +
					"providers execute in registration order.",
			);
			throw new DenialSignal({ reason: "unauthenticated" });
		}
		if (isNotInScope(resolution)) {
			throw new DenialSignal({ reason: "not-in-scope" });
		}
		return resolution;
	}

	private inferResource(action: string, state: RequestState): ResourceRef {
		const inferred = inferResourceRef(this.engine.vocabulary, action);
		this.warnOnce(
			`inferred:${state.route}`,
			`${state.route} declared @RequirePermission("${action}") with no resource, so the guard ` +
				`compiles a query plan over "${inferred.kind === "unspecified" ? inferred.type : "?"}" ` +
				"rather than checking one row. The handler must apply that plan (@QueryPlan()) — the " +
				"request being allowed only means *some* row is reachable.",
		);
		return inferred;
	}

	private warnOnUnvalidatedParam(ref: ResourceRef, state: RequestState): void {
		if (ref.kind !== "param" || ref.parseAs !== undefined) {
			return;
		}
		this.warnOnce(
			`parseAs:${state.route}:${ref.param}`,
			`${state.route} uses the raw value of ":${ref.param}" as a ${ref.type} id — guards run ` +
				"before pipes, so nothing has validated it yet. Pass `parseAs` (any Standard Schema " +
				"validator) so a malformed id is a 400 rather than an authorization question about an " +
				"entity that cannot exist.",
		);
	}

	private async buildContext(
		state: RequestState,
		principal: ResolvedPrincipal,
		action: ActionName,
	): Promise<Readonly<Record<string, unknown>>> {
		const routeBuilder = state.routePermission?.options.context;
		if (routeBuilder !== undefined) {
			return (await routeBuilder(this.resourceContext(state, principal, action))) ?? {};
		}
		if (this.options.contextBuilder !== undefined) {
			return (
				(await this.options.contextBuilder(
					state.request,
					this.resourceContext(state, principal, action),
				)) ?? {}
			);
		}
		return {};
	}

	/**
	 * The graph handed to Cedar.
	 *
	 * The principal's own graph is resolved **once per request**, by the principal
	 * resolver, and passed explicitly — which is why core's cross-request
	 * `entityCache` stays off by default: per-request reuse is this line, not a
	 * cache. Registered `@EntityProvider()` classes contribute the resource and
	 * any additional entities.
	 *
	 * With no provider registered, the principal graph is all Cedar sees, so a
	 * resource missing from it is attribute-less and parent-less. That denies —
	 * fail-closed — and is warned about once per route rather than silently
	 * producing a confusing 403.
	 */
	private async collectEntities(
		state: RequestState,
		principal: ResolvedPrincipal,
		action: string,
		resourceType: string | undefined,
	): Promise<EntityGraph> {
		const contributed = await this.entityProviders.resolveRouteEntities({
			scope: state.scope,
			principal: principal.ref,
			action,
			...(resourceType === undefined ? {} : { resourceType }),
			resource: state.resource,
		});

		// Deduplicated: Cedar rejects a slice listing the same UID twice, and the
		// principal graph and a resource graph routinely share an ancestor.
		const entities = entityGraph(...principal.entities, ...contributed);

		if (state.resource !== undefined && this.entityProviders.size === 0) {
			this.warnOnMissingResourceEntity(state, entities, state.resource);
		}
		return entities;
	}

	private warnOnMissingResourceEntity(
		state: RequestState,
		entities: EntityGraph,
		resource: EntityRef,
	): void {
		const namespace = this.engine.vocabulary.namespace;
		const present = entities.some((entity) => {
			const uid = normalizeEntityUid(entity.uid);
			return uid.id === resource.id && unqualifyEntityType(namespace, uid.type) === resource.type;
		});
		if (present) {
			return;
		}
		this.warnOnce(
			`entities:${state.route}`,
			`${state.route} checks ${resource.type} but neither the principal resolver nor an ` +
				"@EntityProvider() supplied that entity, so Cedar sees it with no attributes and no " +
				"parents — the decision will fail closed. Register an @EntityProvider() implementing " +
				"resolveResource(), or return the resource from the principal resolver's graph.",
		);
	}

	private async runScopeGate(
		state: RequestState,
		principal: ResolvedPrincipal,
		action: ActionName,
		ref: ResourceRef,
	): Promise<void> {
		if (ref.kind === "unspecified") {
			throw new RoutePermissionConfigurationError(
				`${state.route}: the \`scope\` gate cannot use { kind: "unspecified" } — a membership ` +
					"gate is a yes/no question about one entity, not a filter.",
			);
		}

		const resource = await resolveResourceRef(ref, this.resourceContext(state, principal, action));
		const gateEntities = entityGraph(
			...state.entities,
			...(await this.entityProviders.resolveRouteEntities({
				scope: state.scope,
				principal: principal.ref,
				action,
				resourceType: resource.type,
				resource,
			})),
		);

		const result = await this.engine.checkUnsafe({
			scope: state.scope,
			principal: principal.ref,
			action,
			resource,
			context: state.cedarContext,
			entities: gateEntities,
		});

		if (!result.allowed) {
			// Never a 403: a non-member must not be able to tell an existing tenant
			// from a missing one, which is the entire point of the gate.
			throw new DenialSignal({ reason: "not-a-member", gate: action });
		}
	}

	private stash(state: RequestState): void {
		const principal = state.principal;
		if (principal === undefined || typeof state.request !== "object" || state.request === null) {
			return;
		}
		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- writing our own symbol onto the transport request
		(state.request as Record<symbol, unknown>)[AUTHORIZATION_STATE] = new RequestAuthorization({
			engine: this.engine,
			entityResolver: (request) => this.entityProviders.resolveRouteEntities(request),
			principal,
			scope: state.scope,
			context: state.cedarContext,
			entities: state.entities,
			route: state.routePermission,
			resource: state.resource,
			result: state.result,
			plan: state.plan,
		});
	}

	// -------------------------------------------------------------------------
	// Denial
	// -------------------------------------------------------------------------

	/** Maps an escaping error onto a denial, or `undefined` to rethrow it unchanged. */
	private toDenial(error: unknown, state: RequestState): PermissionsDenial | undefined {
		if (error instanceof DenialSignal) {
			return error.denial;
		}
		if (error instanceof ResourceParamError) {
			return { reason: "invalid-resource-param", param: error.param, issues: error.issues };
		}
		if (error instanceof RoutePermissionConfigurationError) {
			this.logger.error(`${state.route}: ${error.message}`);
			return { reason: "misconfigured", detail: error.message };
		}
		if (isPermissionsError(error)) {
			// Engine/store/provider failures are operational, not policy denials. A
			// plain 500 would hide that authorization is unavailable; a 403 would be
			// worse, because it would misreport infrastructure failure as a Cedar
			// decision. The full typed failure is logged while the response stays
			// deliberately generic.
			this.logger.error(
				`${state.route}: authorization failed with ${error.code}: ${error.message}`,
			);
			return { reason: "engine-unavailable" };
		}
		return undefined;
	}

	/**
	 * The layered denial strategy (design §5), coarse to fine:
	 *
	 * 1. `denial.default` decides whether an ordinary denial is 403 or 404;
	 * 2. the route's `onDeny` overrides it;
	 * 3. `not-a-member`/`not-in-scope` are **always** the not-found response and
	 *    cannot be downgraded — that is the property the gate exists for;
	 * 4. `hooks.onDenied` returning an `Error` overrides all of it.
	 */
	private async denialError(denial: PermissionsDenial, state: RequestState): Promise<Error> {
		const denialContext: DenialContext = {
			request: state.request,
			contextKind: state.contextKind,
			scope: state.scope,
			route: state.route,
			routePermission: state.routePermission,
			principal: state.principal?.ref,
			resource: state.resource,
		};

		const owned = await this.options.hooks?.onDenied?.(denial, denialContext);
		if (owned instanceof Error) {
			return owned;
		}

		if (denial.reason === "invalid-resource-param") {
			const replacement = this.options.denial?.onInvalidParam?.({
				param: denial.param,
				value: state.params[denial.param],
				issues: denial.issues,
				contextKind: state.contextKind,
				route: state.route,
			});
			if (replacement instanceof Error) {
				return replacement;
			}
		}

		if (denial.reason === "invalid-scope") {
			const replacement = this.options.denial?.onInvalidScope?.(denial.error, {
				source: denial.source,
				param: denial.param,
				value: denial.param === undefined ? undefined : state.params[denial.param],
				issues: denial.issues,
				request: state.request,
				contextKind: state.contextKind,
				route: state.route,
			});
			if (replacement instanceof Error) {
				return replacement;
			}
		}

		return createAuthorizationError(
			state.contextKind,
			this.statusFor(denial, state),
			this.messageFor(denial),
			{ notFoundStatus: this.options.denial?.notFoundStatus },
		);
	}

	private statusFor(denial: PermissionsDenial, state: RequestState): AuthorizationErrorStatus {
		switch (denial.reason) {
			case "unauthenticated": {
				return "UNAUTHORIZED";
			}
			case "engine-unavailable": {
				return "SERVICE_UNAVAILABLE";
			}
			case "invalid-resource-param":
			case "invalid-scope": {
				return "BAD_REQUEST";
			}
			case "misconfigured": {
				return "INTERNAL";
			}
			case "not-a-member":
			case "not-in-scope": {
				return "NOT_FOUND";
			}
			case "forbidden":
			case "plan-denied":
			case "undeclared-route": {
				const preference =
					state.routePermission?.options.onDeny ?? this.options.denial?.default ?? "forbidden";
				return preference === "not-found" ? "NOT_FOUND" : "FORBIDDEN";
			}
		}
	}

	private messageFor(denial: PermissionsDenial): string | undefined {
		switch (denial.reason) {
			case "engine-unavailable": {
				return (
					"The authorization engine is not available. Requests are refused rather than decided " +
					"without policies."
				);
			}
			case "misconfigured": {
				return denial.detail;
			}
			case "invalid-resource-param": {
				return `Invalid route parameter "${denial.param}".`;
			}
			case "invalid-scope": {
				// Names the parameter, never the value and never the resolver's own
				// message: a `scopeResolver` throwing "organization 8f3e… not found" would
				// otherwise turn a 400 into an existence oracle. The full error reaches
				// `onInvalidScope` and the audit sink, which are not the response.
				return denial.param === undefined
					? "The request scope could not be determined."
					: `Invalid scope route parameter "${denial.param}".`;
			}
			default: {
				// Everything else keeps Nest's own status text. A denial message must
				// not describe *why*: that is an oracle, and the audit sink is where
				// the reason belongs.
				return undefined;
			}
		}
	}

	private emitDecision(state: RequestState, denial: PermissionsDenial | undefined): void {
		// The hooks object is held whole rather than destructured, so `this` stays
		// bound to whatever the caller defined `onDecision` on.
		const hooks = this.options.hooks;
		if (hooks?.onDecision === undefined) {
			return;
		}
		const record: RouteDecisionRecord = {
			contextKind: state.contextKind,
			scope: state.scope,
			principal: state.principal?.ref,
			action: state.routePermission?.action,
			resource: state.resource,
			result: state.result,
			denial,
			route: state.route,
			allowed: denial === undefined,
			plan: state.plan,
			routePermission: state.routePermission,
			durationMs: Date.now() - state.startedAt,
		};
		try {
			const returned = hooks.onDecision(record);
			if (returned instanceof Promise) {
				returned.catch((error: unknown) => {
					this.logger.warn(`hooks.onDecision rejected: ${describe(error)}`);
				});
			}
		} catch (error) {
			this.logger.warn(`hooks.onDecision threw: ${describe(error)}`);
		}
	}

	// -------------------------------------------------------------------------
	// Plumbing
	// -------------------------------------------------------------------------

	private routeContext(state: RequestState): RouteResolutionContext {
		return {
			request: state.request,
			contextKind: state.contextKind,
			params: state.params,
			route: state.route,
			action: state.routePermission?.action,
			executionContext: state.executionContext,
		};
	}

	/**
	 * Only ever built after the route's declaration was read, so the action is
	 * genuinely present — which is what `ResourceResolutionContext` narrows.
	 */
	private resourceContext(
		state: RequestState,
		principal: ResolvedPrincipal,
		action: ActionName,
	): ResourceResolutionContext {
		return { ...this.routeContext(state), action, scope: state.scope, principal };
	}

	private warnOnce(key: string, message: string): void {
		if (this.warned.has(key)) {
			return;
		}
		this.warned.add(key);
		this.logger.warn(message);
	}

	/** {@link warnOnce} at debug level, for a state that is intended rather than wrong. */
	private debugOnce(key: string, message: string): void {
		if (this.warned.has(key)) {
			return;
		}
		this.warned.add(key);
		this.logger.debug(message);
	}
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
