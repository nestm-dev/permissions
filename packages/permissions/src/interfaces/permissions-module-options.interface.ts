import type { InjectionToken, Type } from "@nestjs/common";
import type {
	AnyVocabulary,
	ContextRedactor,
	DecisionListener,
	EntityCacheTuning,
	EntityRef,
	PolicyJson,
	PolicyScopeId,
	PolicySetCacheTuning,
	PolicyStore,
	TemplateSlotId,
} from "@nestm/permissions-core";

import type {
	InvalidParamContext,
	InvalidScopeContext,
	PermissionsHooks,
} from "./permissions-hooks.interface.ts";
import type { PrincipalResolver } from "./principal-resolver.interface.ts";
import type { RouteAuditOptions } from "./route-audit-options.interface.ts";
import type {
	RouteContextBuilderContext,
	ScopeResolutionContext,
} from "./route-permission.interface.ts";

/**
 * A dependency this module resolves from the container, in the four shapes Nest
 * providers come in — plus a ready-made instance, which is the common case for
 * a `MemoryPolicyStore` built in `forRoot`.
 *
 * `useClass` is instantiated through `ModuleRef.create()`, so it participates in
 * constructor DI without being registered as a provider; `useExisting` and the
 * `inject` tokens of `useFactory` are resolved non-strictly, with an asynchronous
 * fallback when a sibling provider is registered but not instantiated yet.
 */
export type ProviderDefinition<T> =
	| T
	| { readonly useClass: Type<T> }
	| { readonly useExisting: InjectionToken }
	| {
			readonly useFactory: (...args: never[]) => T | Promise<T>;
			readonly inject?: readonly InjectionToken[];
	  };

/** How the module obtains its {@link PolicyStore}. */
export type PolicyStoreDefinition = ProviderDefinition<PolicyStore>;

/** How the module obtains its {@link PrincipalResolver}. */
export type PrincipalResolverDefinition = ProviderDefinition<PrincipalResolver>;

interface SeedPolicyCommon {
	/** Cedar policy id, unique within its scope *and* against the global scope. */
	readonly id: string;
	/** Target scope. Defaults to the global scope (`''`). */
	readonly scope?: PolicyScopeId;
	/** Free-text description for admin UIs. Never read by the engine. */
	readonly description?: string;
	/** Cedar annotations mirrored onto the record. */
	readonly annotations?: Readonly<Record<string, string>>;
	/** Defaults to `true`. */
	readonly enabled?: boolean;
}

/**
 * A seed policy written as Cedar text.
 *
 * Parsing text needs the Cedar binding, so it happens inside the asynchronous
 * store provider — never in `forRoot`, which must stay synchronous and
 * WASM-free.
 */
export interface SeedPolicyText extends SeedPolicyCommon {
	readonly text: string;
	readonly cedarJson?: never;
}

/** A seed policy already in Cedar's canonical JSON form. */
export interface SeedPolicyJson extends SeedPolicyCommon {
	readonly cedarJson: PolicyJson;
	readonly text?: never;
}

/** One policy the built-in in-memory store starts life with. */
export type SeedPolicy = SeedPolicyText | SeedPolicyJson;

/** One template link the built-in in-memory store starts life with. */
export interface SeedLink {
	/** Becomes Cedar's `newId` — the policy id the link evaluates under. */
	readonly id: string;
	/** Target scope. Defaults to the global scope (`''`). */
	readonly scope?: PolicyScopeId;
	/** Id of the seed policy with template slots being linked. */
	readonly templateId: string;
	/** Slot values, exactly covering the template's declared slots. */
	readonly values: Partial<Record<TemplateSlotId, EntityRef>>;
}

/**
 * Engine options passed through to `createEngine` verbatim.
 *
 * `vocabulary`, `policyStore` and `entityProvider` are absent on purpose: the
 * module owns all three (`options.vocabulary`, the `POLICY_STORE` provider and
 * the `EntityProviderRegistry`).
 *
 * `entityCache` stays **off** unless you enable it here. Per-request entity
 * reuse is `ResolvedPrincipal.entities`, not this cache — turning it on trades
 * freshness for latency across requests, and a membership change becomes
 * visible only after `ttlMs` or an explicit `invalidateEntity`.
 */
export interface PassthroughEngineOptions {
	/** Cross-request entity cache. Default `false`. */
	readonly entityCache?: false | EntityCacheTuning;
	/** Run Cedar's validator over every policy set as it loads. Default `true`. */
	readonly validateOnLoad?: boolean;
	/** Have Cedar type-check every request against the schema. Default `true`. */
	readonly validateRequests?: boolean;
	/** Preparse-cache tuning. */
	readonly policySetCache?: PolicySetCacheTuning;
	/**
	 * Prefix of every WASM policy-set id this engine owns. Generated when
	 * omitted; two module registrations must never share one.
	 */
	readonly instanceId?: string;
	/** Synchronous audit sink for every `check`. Never awaited; a throw is swallowed. */
	readonly onDecision?: DecisionListener;
	/** Redacts the request context before it reaches `onDecision`. Default: keys only. */
	readonly redactContext?: ContextRedactor;
}

/**
 * How a refusal becomes a response.
 *
 * The layers, coarse to fine (later wins): this object, then a route's
 * `onDeny`, then the route's `scope` gate — whose denial is **always** the
 * not-found response and cannot be downgraded, because that is the property
 * ADR-0014 exists to guarantee — then `hooks.onDenied` returning an `Error`.
 */
export interface DenialOptions {
	/**
	 * Response for an ordinary authorization denial. `"not-found"` hides the
	 * existence of everything this module guards. Default `"forbidden"`.
	 */
	readonly default?: "forbidden" | "not-found";
	/**
	 * What to do with a route that declares neither `@RequirePermission()`,
	 * `@RequireAuthenticated()` nor `@Public()`. Default `"deny"`.
	 *
	 * `"allow"` exists for incremental adoption and is logged once per route;
	 * pair it with `routeAudit.mode: "warn"` so the gap stays visible.
	 */
	readonly onUndeclaredRoute?: "deny" | "allow";
	/** Status used for the not-found response. Default `404`. */
	readonly notFoundStatus?: number;
	/**
	 * Owns the response for a route parameter that failed its `parseAs` schema.
	 * Return an `Error` to replace the default `BadRequestException`.
	 */
	readonly onInvalidParam?: (context: InvalidParamContext) => Error | void;
	/**
	 * Owns the response for a request whose **scope** could not be derived.
	 *
	 * The contract, which is a guarantee rather than a default:
	 *
	 * - A `scopeFrom: { kind: "param" }` whose parameter is missing or empty, and
	 *   **any throw** out of `scopeFrom: { kind: "resolver" }` or the module-level
	 *   `scopeResolver`, produce a `BadRequestException` (400).
	 * - That happens **before the principal is resolved**. Scope resolution runs
	 *   first by design — the principal resolver is told which scope it is being
	 *   asked about — so a request with both a malformed tenant parameter and an
	 *   unusable credential is a 400, not a 401. The alternative would let a
	 *   caller distinguish "this tenant id is malformed" from "this tenant id is
	 *   fine but you are not in it" by watching the status change with the
	 *   credential, which is the oracle the not-found path exists to close.
	 * - Returning an `Error` replaces the 400. Returning nothing keeps it.
	 *
	 * Before this existed, a resolver that wanted to reject a malformed tenant
	 * parameter could only throw and hope: an unrecognised throw escaped the guard
	 * as a 500.
	 *
	 * ```ts
	 * denial: {
	 *   onInvalidScope: (error, { param }) =>
	 *     new BadRequestException(`"${param}" is not an organization id.`),
	 * }
	 * ```
	 */
	readonly onInvalidScope?: (error: unknown, context: InvalidScopeContext) => Error | void;
}

/**
 * Metadata keys from **another** authorization guard that this guard honours.
 *
 * The incremental-cutover seam. `routeAudit.additionalMetadataKeys` already lets
 * a foreign decorator satisfy the boot-time audit, but the *guard* still required
 * this package's decorators — so migrating meant dual-decorating every route,
 * including every `@Public()`, in one commit.
 *
 * The two lists are deliberately different, and the difference is the whole
 * design:
 *
 * - **`publicKeys`** — a foreign `@Public()`-equivalent. The guard **allows**,
 *   exactly as it does for its own `@Public()`. Safe because the route was
 *   already unauthenticated under the legacy guard; nothing is being weakened.
 * - **`declaredKeys`** — a foreign *permission* decorator. The guard
 *   **abstains**: it returns `true` without resolving a principal, without
 *   checking anything and without stashing `RequestAuthorization`, and the legacy
 *   guard — which is still registered and still enforcing — decides. It does
 *   **not** mean "allow": a `CanActivate` returning `true` is not a grant, it is
 *   this guard declining to be the one that answers.
 *
 * Abstaining rather than allowing is what makes the cutover possible. Denying a
 * legacy-declared route would 403 every unmigrated endpoint the moment this guard
 * is registered; allowing it would be a hole. Abstaining leaves the route exactly
 * as protected as it was, and a route migrates when it gains this package's
 * decorators — which take precedence, since an own declaration is checked first.
 *
 * A route with **no** key from either family is still undeclared and still
 * follows `onUndeclaredRoute` (deny, by default).
 */
export interface PermissionsInteropOptions {
	/**
	 * Foreign `@Public()`-equivalent keys. A route carrying one is allowed.
	 *
	 * Subject to the same handler-level override as this package's own
	 * `@Public()`: a class-level public marker does not defeat a handler that
	 * declares `@RequirePermission()`/`@RequireAuthenticated()`.
	 */
	readonly publicKeys?: readonly (string | symbol)[];
	/**
	 * Foreign permission-decorator keys. A route carrying one is **abstained** on,
	 * not allowed — the guard returns `true` and stashes nothing, leaving the
	 * decision to whichever guard owns that key.
	 *
	 * Register both guards, legacy first. Every route it declares stays enforced by
	 * it; every route this package declares is enforced here.
	 */
	readonly declaredKeys?: readonly (string | symbol)[];
}

/** Everything `PermissionsModule.forRoot()` accepts, extras aside. */
export interface PermissionsModuleOptions {
	/**
	 * The vocabulary every request is typed and validated against — the result of
	 * core's `defineVocabulary({ namespace, entities, actions })`.
	 */
	readonly vocabulary: AnyVocabulary;
	/**
	 * Where policies come from. Omit for an in-memory store seeded from
	 * {@link policies} / {@link links}.
	 */
	readonly store?: PolicyStoreDefinition;
	/**
	 * Static seed policies. Only valid when {@link store} is omitted — seeding a
	 * store you own is a write, and this module will not perform one implicitly.
	 */
	readonly policies?: readonly SeedPolicy[];
	/** Static seed template links. Same rule as {@link policies}. */
	readonly links?: readonly SeedLink[];
	/**
	 * Turns a request into a principal.
	 *
	 * Required in practice — the guard cannot decide anything without one — but
	 * optional here, and the token is always provided, so a misconfigured module
	 * reports a clear 500 from the guard instead of an "unknown provider" DI
	 * failure at bootstrap.
	 */
	readonly principalResolver?: PrincipalResolverDefinition;
	/**
	 * Builds the Cedar request context from the transport request and the fully
	 * resolved authorization question. The second argument exposes the action,
	 * scope and principal so one module-level builder can honor action-specific
	 * Cedar context schemas without route-level empty-context overrides.
	 */
	readonly contextBuilder?: (
		request: unknown,
		context: RouteContextBuilderContext,
	) => Record<string, unknown> | Promise<Record<string, unknown>>;
	/**
	 * Derives the policy scope of a request when the route did not.
	 *
	 * Called **before** the principal is resolved (the resolver is told which
	 * scope it is being asked about), so it may only read the request. Return
	 * `undefined` to fall through to the principal's `scopeHint`, and then to the
	 * global scope.
	 */
	readonly scopeResolver?: (
		context: ScopeResolutionContext,
	) => PolicyScopeId | undefined | Promise<PolicyScopeId | undefined>;
	/** How a refusal becomes a response. */
	readonly denial?: DenialOptions;
	/**
	 * Metadata keys belonging to another authorization guard, for an incremental
	 * cutover. See {@link PermissionsInteropOptions} — `publicKeys` allow,
	 * `declaredKeys` make this guard **abstain** so the legacy guard still decides.
	 */
	readonly interop?: PermissionsInteropOptions;
	/** Boot-time route coverage audit. Default `{ mode: "off" }`. */
	readonly routeAudit?: RouteAuditOptions;
	/**
	 * Scopes to preload at boot.
	 *
	 * A warm that fails is **logged, not fatal**: the shipped engine loads policy
	 * sets lazily per scope, so a store that is briefly unavailable at boot
	 * retries on the first check rather than taking the process down.
	 */
	readonly warmScopes?: readonly PolicyScopeId[];
	/** Engine tuning passed straight to `createEngine`. */
	readonly engine?: PassthroughEngineOptions;
	/** Guard hooks: own the denial response, sink every route decision. */
	readonly hooks?: PermissionsHooks;
}

/** Extras — they shape the module graph and are never injected at runtime. */
export interface PermissionsModuleExtras {
	/** Register the module globally. Defaults to `true`. */
	isGlobal?: boolean;
	/** Skip the automatic `APP_GUARD` registration of `PermissionsGuard`. Defaults to `false`. */
	disableGlobalGuard?: boolean;
}
