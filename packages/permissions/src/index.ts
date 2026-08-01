// Public barrel for `@nestm/permissions`.
//
// Two rules hold here:
//   1. only **types** are re-exported from `@nestm/permissions-core` — engine
//      construction, the vocabulary builder and the policy stores stay core-only,
//      so an app never ends up with two ways to build the same object;
//   2. everything this package owns is exported from exactly one place, grouped
//      by role, `type`-prefixed where it is a type.

/** Package identity. Exported so the built barrel has real runtime output. */
export const PACKAGE_NAME = "@nestm/permissions" as const;

// ---------------------------------------------------------------------------
// Module
// ---------------------------------------------------------------------------

export { PermissionsModule, PermissionsFeatureModule } from "./permissions.module.ts";
export {
	MODULE_OPTIONS_TOKEN,
	OPTIONS_TYPE,
	ASYNC_OPTIONS_TYPE,
	type PermissionsForRootOptions,
	type PermissionsForRootAsyncOptions,
} from "./permissions.module-definition.ts";

// ---------------------------------------------------------------------------
// Tokens & constants
// ---------------------------------------------------------------------------

export {
	PERMISSIONS_MODULE_OPTIONS,
	AUTHORIZATION_ENGINE,
	POLICY_STORE,
	PRINCIPAL_RESOLVER,
} from "./permissions.tokens.ts";
export {
	AUTHORIZATION_STATE,
	METADATA_KEY,
	type PermissionsMetadataKey,
} from "./permissions.constants.ts";

// ---------------------------------------------------------------------------
// Options interfaces
// ---------------------------------------------------------------------------

export type {
	DenialOptions,
	PassthroughEngineOptions,
	PermissionsInteropOptions,
	PermissionsModuleExtras,
	PermissionsModuleOptions,
	PolicyStoreDefinition,
	PrincipalResolverDefinition,
	ProviderDefinition,
	SeedLink,
	SeedPolicy,
	SeedPolicyJson,
	SeedPolicyText,
} from "./interfaces/permissions-module-options.interface.ts";
export type { PermissionsFeatureOptions } from "./interfaces/permissions-feature-options.interface.ts";
export type { PermissionsOptionsFactory } from "./interfaces/permissions-options-factory.interface.ts";
export type {
	DenialContext,
	InvalidParamContext,
	InvalidScopeContext,
	PermissionsDenial,
	PermissionsHooks,
	RouteDecisionRecord,
} from "./interfaces/permissions-hooks.interface.ts";

// ---------------------------------------------------------------------------
// Principal resolution
// ---------------------------------------------------------------------------

export {
	NOT_IN_SCOPE,
	isNotInScope,
	isResolvedPrincipal,
	type NotInScope,
	type PrincipalContextKind,
	type PrincipalResolution,
	type PrincipalResolutionContext,
	type PrincipalResolver,
	type ResolvedPrincipal,
} from "./interfaces/principal-resolver.interface.ts";
export {
	DEFAULT_PRINCIPAL_PROPERTY,
	RequestPrincipalResolver,
	type RequestPrincipalResolverOptions,
} from "./resolvers/request-principal.resolver.ts";

// ---------------------------------------------------------------------------
// Entity providers
// ---------------------------------------------------------------------------

export {
	EntityProvider,
	type EntityProviderOptions,
} from "./decorators/entity-provider.decorator.ts";
export {
	EntityProviderRegistry,
	assertEntityProviderClass,
	type AnyFeatureEntityProvider,
	type EntityProviderRegistration,
	type FeatureEntityProvider,
	type RouteEntityRequest,
} from "./services/entity-provider.registry.ts";
export { EntityProviderDiscoveryService } from "./services/entity-provider.discovery.service.ts";

// ---------------------------------------------------------------------------
// Services & guard
// ---------------------------------------------------------------------------

export { PermissionsService } from "./services/permissions.service.ts";
export { PolicySetManager } from "./services/policy-set.manager.ts";
export {
	RequestAuthorization,
	type RequestAuthorizationInit,
	type RequestPlanOptions,
} from "./services/request-authorization.ts";
export { PermissionsGuard } from "./guards/permissions.guard.ts";
export {
	NOT_FOUND_DETAIL,
	createAuthorizationError,
	type AuthorizationErrorOptions,
	type AuthorizationErrorStatus,
} from "./guards/authz-errors.ts";
export type { AuthorizationEngine } from "./providers/engine.provider.ts";

// ---------------------------------------------------------------------------
// Boot-time route audit
// ---------------------------------------------------------------------------

export {
	FALLBACK_ROUTE_METADATA_KEYS,
	RouteAuthorizationAudit,
	loadRouteMetadataKeys,
	type RouteMetadataKeys,
} from "./audit/route-authorization.audit.ts";
export type {
	RouteAuditOptions,
	UndeclaredRoute,
} from "./interfaces/route-audit-options.interface.ts";

// ---------------------------------------------------------------------------
// Route decorators
// ---------------------------------------------------------------------------

export { Public } from "./decorators/public.decorator.ts";
export { RequireAuthenticated } from "./decorators/require-authenticated.decorator.ts";
export { RequirePermission } from "./decorators/require-permission.decorator.ts";
export type {
	ResourceRef,
	ResourceResolutionContext,
	RouteContextBuilderContext,
	RoutePermission,
	RoutePermissionOptions,
	RouteResolutionContext,
	RouteScopeGate,
	ScopeResolutionContext,
	ScopeSource,
} from "./interfaces/route-permission.interface.ts";

// ---------------------------------------------------------------------------
// Handler-side parameter decorators
//
// `QueryPlan` is exported from the decorator module rather than from the core
// block below, because that module declares **both** meanings of the name: the
// parameter decorator and the plan type a handler annotates with. Two barrel
// re-exports of one name would be a duplicate export; one specifier carrying two
// declaration spaces is not.
// ---------------------------------------------------------------------------

export {
	CurrentAuthorization,
	CurrentPrincipal,
	QueryPlan,
	readAuthorization,
	type CurrentAuthorizationOptions,
} from "./decorators/authorization.decorator.ts";

// ---------------------------------------------------------------------------
// Resource-reference resolution
// ---------------------------------------------------------------------------

export {
	ResourceParamError,
	RoutePermissionConfigurationError,
	inferResourceRef,
	parseRouteParam,
	resolveResourceRef,
	resolveScopeSource,
} from "./resolvers/resource-ref.resolver.ts";
export {
	isStandardSchema,
	type StandardSchemaFailure,
	type StandardSchemaIssue,
	type StandardSchemaProps,
	type StandardSchemaResult,
	type StandardSchemaSuccess,
	type StandardSchemaV1,
} from "./types/standard-schema.types.ts";

// ---------------------------------------------------------------------------
// Typed-action registry
// ---------------------------------------------------------------------------

export type {
	ActionName,
	PermissionsCheckRequest,
	PermissionsContext,
	PermissionsPlanRequest,
	PermissionsTypeRegistry,
	RegisteredVocabulary,
	ResourceTypeName,
	UnsafePlanRequest,
} from "./types/permissions-registry.types.ts";

// ---------------------------------------------------------------------------
// Core type re-exports
//
// Types only, so a consumer can name every shape this module's API mentions
// without adding `@nestm/permissions-core` to their own dependencies. Core's
// `EntityProvider` type is re-exported as `CoreEntityProvider` because
// `EntityProvider` is this package's discovery decorator.
// ---------------------------------------------------------------------------

export type {
	ActionOf,
	AnyVocabulary,
	CheckDecisionEvent,
	CheckRequest,
	CheckResult,
	ContextFor,
	ContextRedactor,
	DecisionEvent,
	DecisionListener,
	EngineOptions,
	EngineStats,
	EntityCacheTuning,
	EntityGraph,
	EntityJson,
	EntityNameOf,
	EntityProvider as CoreEntityProvider,
	EntityRef,
	EntityResolutionRequest,
	PermissionsErrorCode,
	PlanApproximation,
	PlanApproximationDirection,
	PlanApproximationReason,
	PlanCmp,
	PlanDiagnostics,
	PlanNode,
	PlanRequest,
	PlanValue,
	PolicyBundle,
	PolicyJson,
	PolicyRecord,
	PolicyScopeId,
	PolicySetCacheTuning,
	PolicyStore,
	PostFilter,
	PostFilterOptions,
	PrincipalTypeFor,
	ResourceTypeFor,
	TemplateLinkRecord,
	TemplateSlotId,
	UnsafeCheckRequest,
} from "@nestm/permissions-core";
