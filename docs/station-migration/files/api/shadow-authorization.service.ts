// ===========================================================================
// COPY-IN DESTINATION: apps/api/src/authorization/shadow-authorization.service.ts
//
// Also required (S6, mechanical) — four small edits, all shown in full at the
// bottom of this file:
//
//   A. apps/api/src/config/environment.ts   -> STATION_AUTHZ_ENGINE
//   B. apps/api/src/metrics/metrics.module.ts -> export PROMETHEUS_REGISTRY
//   C. turbo.json                            -> passThroughEnv on dev/test/openapi:generate
//   D. apps/api/src/authorization/permission.guard.ts -> the shadow call sites
//
// Style matches `apps/api/src/**`: 2-space indent, single quotes, no
// semicolons, `.js` extensions on relative imports.
// ===========================================================================
//
// PHASE 1. The legacy `PermissionGuard` still decides every request. This
// service runs the Cedar check over the *same inputs*, compares the two
// answers, and records a divergence. Zero request-path risk: it can neither
// change a decision nor fail a request.
//
// THE COMPARISON IS AWAITED, ON PURPOSE. A fire-and-forget shadow roughly
// halves the latency cost, and makes the exit gate unprovable: the blackbox
// suite would finish before the comparisons did, and "zero divergences across
// the full blackbox suite" would be measuring nothing. Phase 1 is temporary and
// a Cedar check is ~0.14 ms against a warm policy set; the doubled authorization
// latency is the price of a gate that means something.
//
// EXPECTED DIVERGENCE CLASS. Cedar's `in` is transitive and reflexive, so a
// project-scoped grant reaches entities *under* that Project. Station's literal
// `:projectId` matching cannot. Today no route guards a Run, a Gate or an
// Artifact, so this should produce **zero** observed divergences — but it is the
// reason the exit gate is "zero divergences", not "only expected divergences":
// with nothing under a Project routable yet, every divergence is a bug.

import { Inject, Injectable, Logger } from '@nestjs/common'
import { PermissionsService, type EntityGraph } from '@nestm/permissions'
import type { PermissionKey, InstancePermissionKey } from '@station/contracts'
import {
  INSTANCE_SCOPE,
  STATION_INSTANCE_ID,
  organizationScope,
} from '@station/platform'
import { Counter, type Registry } from 'prom-client'

import { PROMETHEUS_REGISTRY } from '../metrics/metrics.constants.js'

/** How the API decides. `STATION_AUTHZ_ENGINE`. */
export type AuthorizationEngineMode = 'legacy' | 'shadow' | 'cedar'

/** One comparison: everything both engines need, resolved by the caller. */
export interface ShadowComparison {
  /** `Controller.handler`, for the log line and the metric label. */
  readonly route: string
  /** The Permission the route declares. */
  readonly action: PermissionKey | InstancePermissionKey
  /** How the legacy guard scoped the check, for the metric label. */
  readonly scopeKind:
    | 'organization'
    | 'project'
    | 'any'
    | 'instance'
  /** `undefined` for instance scope. */
  readonly organizationId: string | undefined
  /** `Member` id for Organization scope, identity subject for instance scope. */
  readonly principalId: string
  /** Vocabulary-local resource type. */
  readonly resourceType: 'Organization' | 'Project' | 'Instance'
  readonly resourceId: string
  /** Entities Cedar needs — the principal graph plus the resource graph. */
  readonly entities: EntityGraph
  /** What the legacy engine decided. The reference answer during Phase 1. */
  readonly legacyAllowed: boolean
}

/**
 * Runs Cedar beside the legacy engine and counts the disagreements.
 *
 * The exit gate for Phase 1 is `station_api_authz_divergence_total == 0` across
 * the full blackbox suite plus a staging soak. Until it is, the legacy engine
 * decides and this service is the only thing Cedar touches.
 */
@Injectable()
export class ShadowAuthorizationService {
  readonly #logger = new Logger(ShadowAuthorizationService.name)
  readonly #permissions: PermissionsService
  readonly #divergences: Counter<'route' | 'action' | 'scope' | 'direction'>
  readonly #comparisons: Counter<'route' | 'action' | 'scope'>
  readonly #failures: Counter<'route' | 'action'>
  readonly #mode: AuthorizationEngineMode

  constructor(
    permissions: PermissionsService,
    @Inject(PROMETHEUS_REGISTRY) registry: Registry,
    mode: AuthorizationEngineMode,
  ) {
    this.#permissions = permissions
    this.#mode = mode

    this.#comparisons = new Counter({
      name: 'station_api_authz_shadow_comparisons_total',
      help: 'Authorization decisions compared between the legacy engine and Cedar.',
      labelNames: ['route', 'action', 'scope'],
      registers: [registry],
    })

    this.#divergences = new Counter({
      // The design calls this `station_authz_divergence_total`; the
      // `station_api_` prefix matches every other metric this process exposes
      // (`metrics.registry.ts` sets it for the default collectors too), and a
      // dashboard that has to know about two prefixes is a dashboard nobody
      // builds. `direction` is `cedar-denies` (Cedar is stricter) or
      // `cedar-allows` (Cedar is wider — the one that is a security finding).
      name: 'station_api_authz_divergence_total',
      help: 'Authorization decisions where Cedar disagreed with the legacy engine.',
      labelNames: ['route', 'action', 'scope', 'direction'],
      registers: [registry],
    })

    this.#failures = new Counter({
      name: 'station_api_authz_shadow_failures_total',
      help: 'Shadow comparisons that could not be completed.',
      labelNames: ['route', 'action'],
      registers: [registry],
    })
  }

  /** Whether Cedar should be consulted at all. */
  get mode(): AuthorizationEngineMode {
    return this.#mode
  }

  /** Whether the legacy engine is still the one that decides. */
  get shadowing(): boolean {
    return this.#mode === 'shadow'
  }

  /**
   * Compares one decision. Never throws, never changes an outcome.
   *
   * A comparison that cannot run — the policy set is unavailable, an entity is
   * missing, Cedar rejects the request — is counted as a *failure*, not as a
   * divergence, and must be driven to zero before the divergence count means
   * anything. A shadow that silently stops comparing reads exactly like a
   * shadow that agrees.
   */
  async compare(comparison: ShadowComparison): Promise<void> {
    if (!this.shadowing) {
      return
    }

    const labels = {
      route: comparison.route,
      action: comparison.action,
      scope: comparison.scopeKind,
    }

    try {
      const scope =
        comparison.organizationId === undefined
          ? INSTANCE_SCOPE
          : organizationScope(comparison.organizationId)

      const result = await this.#permissions.check({
        scope,
        principal: {
          type: comparison.resourceType === 'Instance' ? 'Identity' : 'Member',
          id: comparison.principalId,
        },
        action: comparison.action,
        resource: {
          type: comparison.resourceType,
          id: comparison.resourceId,
        },
        entities: comparison.entities,
      })

      this.#comparisons.inc(labels)

      // An errored policy is never "just a warning": an errored `forbid` is
      // DROPPED from the decision, so an `allow` carrying policy errors may be
      // wrong. Surface it whether or not the two engines agreed.
      if (result.policyErrors.length > 0) {
        this.#logger.error(
          `Cedar policy errors on ${comparison.route} (${comparison.action}): ` +
            result.policyErrors
              .map((error) => `${error.policyId}: ${error.message}`)
              .join('; '),
        )
      }

      if (result.allowed === comparison.legacyAllowed) {
        return
      }

      const direction = result.allowed ? 'cedar-allows' : 'cedar-denies'
      this.#divergences.inc({ ...labels, direction })

      this.#logger.warn(
        JSON.stringify({
          message: 'authorization divergence',
          route: comparison.route,
          action: comparison.action,
          scope: comparison.scopeKind,
          direction,
          legacyAllowed: comparison.legacyAllowed,
          cedarAllowed: result.allowed,
          organizationId: comparison.organizationId,
          principalId: comparison.principalId,
          resource: `${comparison.resourceType}::${comparison.resourceId}`,
          determiningPolicyIds: result.determiningPolicyIds,
          policySetVersion: result.policySetVersion,
        }),
      )
    } catch (error) {
      this.#failures.inc({
        route: comparison.route,
        action: comparison.action,
      })
      this.#logger.error(
        `Shadow comparison failed on ${comparison.route} (${comparison.action}): ` +
          (error instanceof Error ? error.message : String(error)),
      )
    }
  }

  /**
   * Compares a *list* decision — the `{ kind: 'any' }` routes, where the legacy
   * engine answers "does this Member hold the Permission anywhere" and Cedar
   * answers with a query plan.
   *
   * `ALWAYS_DENY` is the plan-level equivalent of `hasAnyPermission === false`;
   * anything else means at least one row is reachable. Comparing the compiled
   * SQL against the legacy id set is Phase 3's job (S8) and needs real rows —
   * this only compares the gate.
   */
  async comparePlan(
    comparison: Omit<ShadowComparison, 'resourceId'> & {
      readonly resourceType: 'Project'
    },
  ): Promise<void> {
    if (!this.shadowing) {
      return
    }

    const labels = {
      route: comparison.route,
      action: comparison.action,
      scope: comparison.scopeKind,
    }

    try {
      const organizationId = comparison.organizationId

      if (organizationId === undefined) {
        throw new Error('A plan comparison needs an Organization scope')
      }

      const plan = await this.#permissions.plan({
        scope: organizationScope(organizationId),
        principal: { type: 'Member', id: comparison.principalId },
        action: comparison.action,
        resourceType: comparison.resourceType,
        entities: comparison.entities,
      })

      this.#comparisons.inc(labels)

      const cedarAllowed = plan.kind !== 'ALWAYS_DENY'

      if (cedarAllowed === comparison.legacyAllowed) {
        return
      }

      const direction = cedarAllowed ? 'cedar-allows' : 'cedar-denies'
      this.#divergences.inc({ ...labels, direction })

      this.#logger.warn(
        JSON.stringify({
          message: 'authorization plan divergence',
          route: comparison.route,
          action: comparison.action,
          direction,
          legacyAllowed: comparison.legacyAllowed,
          cedarAllowed,
          planKind: plan.kind,
          organizationId,
          principalId: comparison.principalId,
        }),
      )
    } catch (error) {
      this.#failures.inc({
        route: comparison.route,
        action: comparison.action,
      })
      this.#logger.error(
        `Shadow plan comparison failed on ${comparison.route}: ` +
          (error instanceof Error ? error.message : String(error)),
      )
    }
  }
}

/** The instance-scope resource every `organization:create` check names. */
export const INSTANCE_RESOURCE = {
  type: 'Instance' as const,
  id: STATION_INSTANCE_ID,
}

/* ===========================================================================
 * A. apps/api/src/config/environment.ts
 * ===========================================================================
 *
 *   export const apiEnvironmentSchema = z.object({
 *     …
 *     WEB_CONSOLE_ORIGIN: z.url().default('http://localhost:3000'),
 * +
 * +   // Which engine decides. `legacy` is today. `shadow` keeps the legacy
 * +   // guard authoritative and runs Cedar beside it. `cedar` cuts over.
 * +   // The rollback for every phase before S10 is setting this back.
 * +   STATION_AUTHZ_ENGINE: z
 * +     .enum(['legacy', 'shadow', 'cedar'])
 * +     .default('legacy'),
 *   })
 *
 * ===========================================================================
 * B. apps/api/src/metrics/metrics.module.ts
 * ===========================================================================
 *
 * The registry is currently private to the module; a Counter declared anywhere
 * else needs it. One line:
 *
 *     providers: [
 *       { provide: PROMETHEUS_REGISTRY, useFactory: createPrometheusRegistry },
 *       MetricsService,
 *     ],
 * -   exports: [MetricsService],
 * +   exports: [MetricsService, PROMETHEUS_REGISTRY],
 *
 * `MetricsModule` must also be imported by whichever module provides
 * `ShadowAuthorizationService` (or marked `@Global()`); it is not global today.
 *
 * ===========================================================================
 * C. turbo.json
 * ===========================================================================
 *
 * Add `"STATION_AUTHZ_ENGINE"` to `passThroughEnv` on the `dev`, `test` and
 * `openapi:generate` tasks. Without it turbo strips the variable and every
 * environment silently runs `legacy` — including the blackbox suite that is
 * supposed to be proving the shadow is clean.
 *
 * ===========================================================================
 * D. apps/api/src/authorization/permission.guard.ts — the call sites
 * ===========================================================================
 *
 * The legacy guard is untouched as a decision maker. Three insertions, each on
 * the success path so the shadow only ever compares decisions the legacy engine
 * actually reached.
 *
 *   // instance scope, after `const operator = await …isOperator(…)`
 *   await this.#shadow.compare({
 *     route: `${context.getClass().name}.${context.getHandler().name}`,
 *     action: routePermission.permission,
 *     scopeKind: 'instance',
 *     organizationId: undefined,
 *     principalId: request.identity.identitySubject,
 *     resourceType: 'Instance',
 *     resourceId: STATION_INSTANCE_ID,
 *     entities: [...identityGraph(request.identity.identitySubject, { operator })],
 *     legacyAllowed: operator,
 *   })
 *
 *   // organization / project scope, replacing the bare `#satisfies` call:
 *   const allowed = this.#satisfies(routePermission, authorization, parameters)
 *   const graph = [
 *     ...memberGraph({
 *       id: authorization.memberId,
 *       organizationId: organizationId.data,
 *       identitySubject: request.identity.identitySubject,
 *     }),
 *   ]
 *
 *   if (routePermission.scope.kind === 'organization') {
 *     await this.#shadow.compare({
 *       route, action: routePermission.permission, scopeKind: 'organization',
 *       organizationId: organizationId.data,
 *       principalId: authorization.memberId,
 *       resourceType: 'Organization', resourceId: organizationId.data,
 *       entities: graph, legacyAllowed: allowed,
 *     })
 *   } else if (routePermission.scope.kind === 'project') {
 *     await this.#shadow.compare({
 *       route, action: routePermission.permission, scopeKind: 'project',
 *       organizationId: organizationId.data,
 *       principalId: authorization.memberId,
 *       resourceType: 'Project',
 *       resourceId: String(parameters[routePermission.scope.parameter]),
 *       entities: [
 *         ...graph,
 *         ...projectGraph({
 *           id: String(parameters[routePermission.scope.parameter]),
 *           organizationId: organizationId.data,
 *         }),
 *       ],
 *       legacyAllowed: allowed,
 *     })
 *   } else if (routePermission.scope.kind === 'any') {
 *     await this.#shadow.comparePlan({
 *       route, action: routePermission.permission, scopeKind: 'any',
 *       organizationId: organizationId.data,
 *       principalId: authorization.memberId,
 *       resourceType: 'Project',
 *       entities: graph, legacyAllowed: allowed,
 *     })
 *   }
 *
 *   if (!allowed) {
 *     throw new ForbiddenException()
 *   }
 *
 * `{ kind: 'membership' }` and `{ kind: 'authenticated' }` are deliberately not
 * compared: the guard makes no authorization decision on either, and the real
 * decision for `GET /organizations` happens in `TenancyService`. That one gets
 * its own comparison at S8, where the batched `checkMany` lands beside the
 * existing `hasAnyPermission` loop.
 *
 * ===========================================================================
 * PROVIDER WIRING
 * ===========================================================================
 *
 * In `AuthorizationModule` (or a small `ShadowAuthorizationModule` it imports),
 * so the legacy guard can inject it:
 *
 *   {
 *     provide: ShadowAuthorizationService,
 *     inject: [PermissionsService, PROMETHEUS_REGISTRY, ConfigService],
 *     useFactory: (
 *       permissions: PermissionsService,
 *       registry: Registry,
 *       config: ConfigService<ApiEnvironment, true>,
 *     ) =>
 *       new ShadowAuthorizationService(
 *         permissions,
 *         registry,
 *         config.getOrThrow('STATION_AUTHZ_ENGINE', { infer: true }),
 *       ),
 *   }
 *
 * `PermissionsService` resolves because `PermissionsModule` registers globally
 * (`isGlobal: true`, the default). VERIFY that `AuthorizationEngineModule` is
 * imported before `ApiSecurityModule` instantiates the legacy guard; if the
 * container complains, add `AuthorizationEngineModule.forRoot()` to
 * `AuthorizationModule`'s imports instead of `ApiSecurityModule`'s.
 */
