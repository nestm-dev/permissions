// ===========================================================================
// COPY-IN DESTINATION: apps/api/src/authorization/authorization-engine.module.ts
//
// Also required (S5, mechanical):
//   - apps/api/package.json -> dependencies:
//         "@nestm/permissions": "0.1.0-alpha.0",
//         "@nestm/permissions-core": "0.1.0-alpha.0",
//         "@nestm/permissions-drizzle": "0.1.0-alpha.0"
//     (`.npmrc` has strict-peer-dependencies=true; `@nestm/permissions` peers
//      @nestjs/common ^12.0.0-alpha.5, which station's
//      pnpm-workspace.yaml peerDependencyRules already pins. The drizzle driver
//      peers drizzle-orm ^0.45.0 — station is on 0.45.2 — and marks
//      @nestjs/common and drizzle-kit optional.)
//   - apps/api/src/security/api-security.module.ts -> import this module and
//     register PermissionsGuard EXPLICITLY (see the note on the module class).
//
// Style matches `apps/api/src/**`: 2-space indent, single quotes, no
// semicolons, `.js` extensions on relative imports.
// ===========================================================================

import {
  ForbiddenException,
  InternalServerErrorException,
  Injectable,
  Logger,
  Module,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
  type DynamicModule,
  type OnApplicationShutdown,
} from '@nestjs/common'
import {
  CompositePolicyStore,
  MemoryPolicyStore,
  readOnlyPolicyStore,
  type PolicyBundle,
  type PolicyChangeListener,
  type PolicyRecord,
  type PolicyScopeId,
  type ReadOnlyPolicyStore,
  type Unsubscribe,
} from '@nestm/permissions-core'
import {
  EntityProvider,
  NOT_IN_SCOPE,
  PermissionsModule,
  type DenialContext,
  type EntityGraph,
  type FeatureEntityProvider,
  type PermissionsDenial,
  type PrincipalResolution,
  type PrincipalResolutionContext,
  type PrincipalResolver,
  type RouteEntityRequest,
} from '@nestm/permissions'
import {
  DrizzlePolicyStore,
  type DrizzlePolicyStoreDatabase,
} from '@nestm/permissions-drizzle'
import { organizationIdSchema, type Identity } from '@station/contracts'
import {
  permissionPolicies,
  permissionPolicyLinks,
  permissionScopeVersions,
  withOrganizationContext,
  type StationDatabase,
} from '@station/database'
import {
  INSTANCE_SCOPE,
  STATION_INSTANCE_ID,
  identityGraph,
  instanceGraph,
  memberGraph,
  organizationEntity,
  organizationIdFromScope,
  organizationScope,
  projectGraph,
  repositoryEntity,
  stationVocabulary,
} from '@station/platform'
// `getStationDatabaseToken`, not `InjectStationDatabase`: the latter returns a
// parameter decorator, and a `useFactory` provider's `inject` array wants the
// token itself.
import { getStationDatabaseToken } from '@station/nestjs-database'

import type { AuthenticatedRequest } from '../auth/authenticated-request.js'
import { IS_PUBLIC_ROUTE } from '../auth/public.decorator.js'
import { ValidationException } from '../http/validation.exception.js'
import { APPLICATION_DATABASE_CONNECTION } from '../database/api-database.module.js'
import { AuthorizationModule } from './authorization.module.js'
import { AuthorizationService } from './authorization.service.js'
import { OperatorsService } from './operators.service.js'
import { ROUTE_PERMISSION } from './require-permission.decorator.js'

const ORGANIZATION_ID_PARAMETER = 'organizationId'

// ===========================================================================
// The instance-scope policy set (ADR-0015)
// ===========================================================================

/**
 * The one code-owned policy. Operators are not a table change and not a
 * Permission grant: instance scope is a separate policy scope served by an
 * in-memory store, and Group membership comes from the entity graph, which
 * `StationPrincipalResolver` builds from the existing global `operators` table.
 *
 * Written as Cedar's canonical JSON rather than parsed from text so this module
 * never needs the Cedar binding at construction time. In text it is:
 *
 *     permit(
 *       principal in Station::Group::"operators",
 *       action == Station::Action::"organization:create",
 *       resource == Station::Instance::"station"
 *     );
 *
 * `updatedAt` is a fixed epoch on purpose: this policy is identical on every
 * replica, and a `new Date()` here would make two replicas disagree about a
 * policy-set version that never actually changes.
 */
const OPERATOR_INSTANCE_POLICY: PolicyRecord = {
  id: 'instance:operators-create-organization',
  scope: INSTANCE_SCOPE,
  kind: 'static',
  cedarJson: {
    effect: 'permit',
    principal: {
      op: 'in',
      entity: { type: 'Station::Group', id: 'operators' },
    },
    action: {
      op: '==',
      entity: { type: 'Station::Action', id: 'organization:create' },
    },
    resource: {
      op: '==',
      entity: { type: 'Station::Instance', id: STATION_INSTANCE_ID },
    },
    conditions: [],
    annotations: { station_adr: '0015' },
  },
  enabled: true,
  updatedAt: new Date(0),
}

// ===========================================================================
// The policy store
// ===========================================================================

/**
 * `DrizzlePolicyStore`, wrapped so every read happens inside an Organization
 * context.
 *
 * This wrapper is not ceremony. `permission_policies` and
 * `permission_policy_links` are FORCE ROW LEVEL SECURITY, the isolation
 * predicate reads the transaction-local `station.organization_id`, and
 * `set_config(..., true)` only applies to the transaction that set it. A store
 * holding the pool would issue its SELECTs on some other pooled connection with
 * no context set and read **zero rows** — which is not an error, it is an empty
 * policy set, which is a total deny. Fail-closed, but wrong.
 *
 * So: one transaction per cold load, built over the transaction handle. That is
 * the shape the driver's own RLS harness uses
 * (`packages/permissions-drizzle/tests/integration/rls.test.ts`), and it is why
 * `DrizzlePolicyStore.load()` issues its three reads sequentially rather than
 * with `Promise.all` — a transaction handle is one `pg` client, and overlapping
 * queries on one client are removed in `pg@9`.
 *
 * Cost: `load()` is a cold path. The engine caches per scope and `watch()`
 * invalidates, so this runs once per Organization per policy change, not per
 * request (core delta D1).
 *
 * It implements `ReadOnlyPolicyStore` — `load`, `currentVersion`, `watch` — and
 * NOT the full seven-member `PolicyStore`. Station's policies and links are a
 * projection of `roles`/`role_grants` written by `@station/database` inside the
 * transaction that writes the source row; that is what preserves the
 * advisory-lock "last administrator" protection and what makes the two
 * impossible to observe apart. A write arriving here would be a second,
 * unsynchronised write path. `readOnlyPolicyStore(...)` (below, where the store
 * is handed to the engine) supplies the four rejecting write methods, so this
 * class does not hand-stub them: a hand-written stub is a decision — throw or
 * resolve? — and a `save()` that resolves without writing tells its caller the
 * grant landed.
 */
@Injectable()
export class StationPolicyStore implements ReadOnlyPolicyStore {
  readonly #database: StationDatabase
  /**
   * A pool-backed store used for **nothing but** `watch()`.
   *
   * The poller's only query is
   * `SELECT organization_id, updated_at FROM permission_scope_versions WHERE
   * updated_at > $since` — one statement per tick regardless of tenant count,
   * against the one table in this migration that deliberately carries no RLS
   * (the approved carve-out). It therefore works over the pool, with no
   * Organization context, which is exactly what a poller that does not yet know
   * which tenants changed requires.
   */
  readonly #poller: DrizzlePolicyStore

  constructor(database: StationDatabase, onError: (error: unknown) => void) {
    this.#database = database
    // No cast. `DrizzlePolicyStoreDatabase` is
    // `PgDatabase<PgQueryResultHKT, Record<string, unknown>>` — the supertype
    // the store's own methods already read through — so both a
    // `NodePgDatabase<typeof fullSchema>` and a `transaction()` handle satisfy
    // it directly. (An earlier revision double-cast through
    // `ConstructorParameters<typeof DrizzlePolicyStore>[0]` because the
    // constructor named a narrower type than the implementation needed.)
    //
    // The annotation is the assertion: if a future drizzle or driver release
    // breaks the assignability, it fails HERE, on one line naming both types,
    // rather than at whichever call site happened to be typechecked first.
    const pool: DrizzlePolicyStoreDatabase = this.#database

    this.#poller = new DrizzlePolicyStore(
      pool,
      { permissionPolicies, permissionPolicyLinks, permissionScopeVersions },
      { poll: { intervalMs: 5_000 }, onError },
    )
  }

  async load(scope: PolicyScopeId): Promise<PolicyBundle> {
    return this.#inOrganizationContext(scope, (store) => store.load(scope))
  }

  async currentVersion(scope: PolicyScopeId): Promise<string> {
    return this.#inOrganizationContext(scope, (store) =>
      store.currentVersion(scope),
    )
  }

  watch(listener: PolicyChangeListener): Unsubscribe {
    return this.#poller.watch(listener)
  }

  /** Stops the poller. Wired to the module's shutdown. */
  async dispose(): Promise<void> {
    await this.#poller.dispose()
  }

  /** One tick of the poller, for tests. */
  async pollOnce(): Promise<void> {
    await this.#poller.pollOnce()
  }

  async #inOrganizationContext<T>(
    scope: PolicyScopeId,
    read: (store: DrizzlePolicyStore) => Promise<T>,
  ): Promise<T> {
    const organizationId = organizationIdSchema.parse(
      organizationIdFromScope(scope),
    )

    return withOrganizationContext(
      this.#database,
      organizationId,
      async (transaction) => {
        // Also no cast, and the same one-line assertion: a `transaction()`
        // handle is a `PgTransaction`, which is a `PgDatabase<...>` and
        // therefore a `DrizzlePolicyStoreDatabase`. This is the shape the
        // supertype was widened for — running the store over a transaction is
        // the REQUIRED call shape under RLS, not an exotic one.
        const executor: DrizzlePolicyStoreDatabase = transaction

        const store = new DrizzlePolicyStore(
          executor,
          { permissionPolicies, permissionPolicyLinks, permissionScopeVersions },
          // No poller on the per-transaction store: it would start a timer per
          // cold load and never be disposed.
          { poll: false },
        )

        return read(store)
      },
    )
  }
}

// ===========================================================================
// Principal resolution — where ADR-0014's 404 comes from
// ===========================================================================

/**
 * Turns a request into the principal a decision is about.
 *
 * The load-bearing line is the `NOT_IN_SCOPE` return. Station's 404 for a
 * non-Member is **not** a Cedar denial — it is "this authenticated identity has
 * no `members` row in this Organization", which is an entity-resolution
 * outcome, and today it is `permission.guard.ts:137-139` turning
 * `resolveMemberAuthorization() === undefined` into `NotFoundException`.
 * `NOT_IN_SCOPE` is the same statement to the library, and `hooks.onDenied`
 * turns it back into the same exception. No 26th action, no new policy, and the
 * e2e assertion that an unknown-Organization body is byte-identical to a
 * non-Member probe stays true by construction.
 */
@Injectable()
export class StationPrincipalResolver implements PrincipalResolver {
  readonly #authorization: AuthorizationService
  readonly #operators: OperatorsService

  constructor(
    authorization: AuthorizationService,
    operators: OperatorsService,
  ) {
    this.#authorization = authorization
    this.#operators = operators
  }

  async resolve(
    context: PrincipalResolutionContext,
  ): Promise<PrincipalResolution> {
    const request = context.request as AuthenticatedRequest
    const identity: Identity | undefined = request.identity

    // `null` is *unauthenticated* and maps to 401 — distinct from NOT_IN_SCOPE,
    // which maps to 404. AccessTokenGuard runs first (ADR-0019), so this only
    // fires if the guard order was broken.
    if (!identity) {
      return null
    }

    if (context.scope === INSTANCE_SCOPE) {
      const operator = await this.#operators.isOperator(
        identity.identitySubject,
      )

      return {
        ref: { type: 'Identity', id: identity.identitySubject },
        entities: [...identityGraph(identity.identitySubject, { operator })],
        scopeHint: INSTANCE_SCOPE,
      }
    }

    const organizationId = organizationIdSchema.parse(
      organizationIdFromScope(context.scope),
    )

    // Exactly the query today's guard runs, deliberately: shadow mode compares
    // two engines over the same inputs, and a different lookup would compare
    // two different questions. S10 can narrow it to a member-only read.
    const authorization = await this.#authorization.resolveMemberAuthorization(
      organizationId,
      identity.identitySubject,
    )

    if (!authorization) {
      return NOT_IN_SCOPE
    }

    return {
      ref: { type: 'Member', id: authorization.memberId },
      entities: [
        ...memberGraph({
          id: authorization.memberId,
          organizationId,
          identitySubject: identity.identitySubject,
        }),
      ],
      scopeHint: organizationScope(organizationId),
    }
  }
}

// ===========================================================================
// Entity resolution
// ===========================================================================

/**
 * Supplies the resource half of the entity graph.
 *
 * Every entity here is constructed, not fetched. That is not a shortcut, it is
 * parity: today's guard calls `hasProjectPermission(authorization, permission,
 * projectId)` without checking that the Project exists or belongs to the
 * Organization either — the URL is `/organizations/:organizationId/...`, the
 * handler's query runs under an Organization context, and a cross-Organization
 * or nonexistent id yields no rows and a 404 from the handler. Adding a
 * existence probe here would add a round trip to every request and change the
 * 403/404 split on a path ADR-0014 pins.
 *
 * Entity-graph size dominates Cedar latency (500 irrelevant entities is a 20x
 * regression), so each method returns the narrow slice one decision needs and
 * nothing else.
 */
@EntityProvider()
@Injectable()
export class StationEntityProvider implements FeatureEntityProvider {
  resolveResource(request: RouteEntityRequest): EntityGraph {
    const resource = request.resource

    if (resource === undefined) {
      // The query-plan path: there is no single resource, and the principal
      // graph already carries the Organization.
      return []
    }

    if (request.scope === INSTANCE_SCOPE) {
      return resource.type === 'Instance' ? [...instanceGraph()] : []
    }

    const organizationId = organizationIdFromScope(request.scope)

    switch (resource.type) {
      case 'Organization': {
        return [organizationEntity(resource.id)]
      }
      case 'Project': {
        return [...projectGraph({ id: resource.id, organizationId })]
      }
      case 'Repository': {
        // VERIFY: a Repository's Project id is not in the URL today, because no
        // route guards a Repository yet. When one lands, this needs the real
        // `repositories.project_id` — a constructed parent claiming the wrong
        // Project would widen a project-scoped grant. Until then the branch
        // returns the Organization only, which denies rather than over-grants.
        return [organizationEntity(organizationId)]
      }
      default: {
        // An unresolved resource means Cedar sees no entity for it, which is a
        // deny, not an allow. The guard warns once per route in that case.
        return []
      }
    }
  }
}

// Referenced so an unused-import lint does not drop the builder that the
// Repository branch above will need.
void repositoryEntity

// ===========================================================================
// The module
// ===========================================================================

/**
 * Wires the Cedar engine. Registers **no** global guard.
 *
 * `disableGlobalGuard: true` is a security decision, not a preference:
 * `PermissionsModule.forRoot` would otherwise append
 * `{ provide: APP_GUARD, useClass: PermissionsGuard }` at a position that
 * depends on module import order, and ADR-0019 makes
 * `AccessTokenGuard` -> permission guard an explicit ordered registration in
 * `ApiSecurityModule`. The guard is registered there, by hand, in that order.
 *
 * ```ts
 * // apps/api/src/security/api-security.module.ts  (S7)
 * import { PermissionsGuard } from '@nestm/permissions'
 * import { AuthorizationEngineModule } from '../authorization/authorization-engine.module.js'
 *
 * @Module({
 *   imports: [IdentityModule, AuthorizationModule, AuthorizationEngineModule.forRoot()],
 *   providers: [
 *     { provide: APP_GUARD, useClass: AccessTokenGuard },
 *     { provide: APP_GUARD, useClass: PermissionsGuard },
 *   ],
 * })
 * export class ApiSecurityModule {}
 * ```
 */
@Module({})
export class AuthorizationEngineModule {
  static forRoot(): DynamicModule {
    return {
      module: AuthorizationEngineModule,
      imports: [
        StationAuthorizationProvidersModule,
        PermissionsModule.forRootAsync({
          isGlobal: true,
          disableGlobalGuard: true,
          // The factory's `inject` tokens resolve from THIS dynamic module's
          // own context plus its `imports` — not from the module that imported
          // it. Listing the providers module here is what makes
          // `StationPolicyStore` and `StationPrincipalResolver` resolvable;
          // declaring them in `AuthorizationEngineModule.providers` alone would
          // not, and the failure is an "unknown provider" at bootstrap.
          imports: [StationAuthorizationProvidersModule],
          inject: [
            StationPolicyStore,
            StationPrincipalResolver,
          ],
          useFactory: (
            policyStore: StationPolicyStore,
            principalResolver: StationPrincipalResolver,
          ) => ({
            vocabulary: stationVocabulary,

            // Instance scope is code-owned and lives nowhere near a tenant
            // table; every other scope is the database. `CompositePolicyStore`
            // routes by exact scope first, then the fallback, and its `watch`
            // fans in from whichever children can emit — here, the database
            // store's poller.
            //
            // `readOnlyPolicyStore` supplies the four rejecting write methods
            // around `StationPolicyStore`'s three read ones. It forwards
            // `watch` only because the source has it (a synthesised
            // never-firing `watch` would stop the cache polling
            // `currentVersion` and freeze every decision at its first value),
            // and it rejects `save([])` too — so "nothing to do" and "this
            // store cannot write" never read the same. The rejection is a
            // `PermissionsError` with code `POLICY_STORE`.
            store: new CompositePolicyStore({
              routes: {
                [INSTANCE_SCOPE]: new MemoryPolicyStore({
                  policies: [OPERATOR_INSTANCE_POLICY],
                }),
              },
              fallback: readOnlyPolicyStore(policyStore, {
                name: 'StationPolicyStore',
                hint:
                  "Station's Cedar policies are a projection of roles/role_grants, " +
                  'written by @station/database in the same transaction as the source ' +
                  'row. Write the source row instead.',
              }),
            }),

            principalResolver,

            /**
             * Derives the policy scope BEFORE the principal is resolved, so the
             * resolver is told which tenant it is being asked about. Reads the
             * request and nothing else.
             *
             * The `safeParse` is where station's guard-before-pipes contract
             * lives: guards run before pipes, so `organizationId` here is
             * whatever the router produced. `permission.guard.ts:116-127` does
             * exactly this today, and the pointer and detail strings are copied
             * from it so the 400 body is byte-identical.
             *
             * The throw is a supported path, not a hope. ANY throw out of a
             * `scopeResolver` becomes an `invalid-scope` denial — a 400 —
             * raised BEFORE the principal is resolved; nothing escapes as a
             * 500. `denial.onInvalidScope` below owns the response. Throwing
             * the `ValidationException` here as well is belt-and-braces: if
             * `hooks.onDenied` or `onInvalidScope` is ever removed, the raw
             * error is still the right shape.
             */
            scopeResolver: ({ params }) => {
              const raw = params[ORGANIZATION_ID_PARAMETER]

              if (raw === undefined) {
                return INSTANCE_SCOPE
              }

              const organizationId = organizationIdSchema.safeParse(raw)

              if (!organizationId.success) {
                throw new ValidationException([
                  {
                    pointer: ORGANIZATION_ID_PARAMETER,
                    detail: 'Expected a UUID Organization identifier.',
                  },
                ])
              }

              return organizationScope(organizationId.data)
            },

            denial: {
              // A Member lacking the Permission gets 403; only the scope gate
              // and NOT_IN_SCOPE produce 404 (ADR-0014).
              default: 'forbidden',
              // Matches today's `permission.guard.ts:77-79`: a route with no
              // declaration is a 403, and the boot-time audit makes it
              // unreachable in a built application.
              onUndeclaredRoute: 'deny',
              onInvalidParam: ({ param }) =>
                new ValidationException([
                  {
                    pointer: param,
                    detail:
                      param === ORGANIZATION_ID_PARAMETER
                        ? 'Expected a UUID Organization identifier.'
                        : 'Expected a UUID Project identifier.',
                  },
                ]),
              /**
               * The malformed-`:organizationId` 400, with station's pointer.
               *
               * This is the first-class hook for the path the `scopeResolver`
               * above refuses on. Three properties come with it, and all three
               * are contract rather than default:
               *
               *  - it is a **400**, and it is raised **before the principal is
               *    resolved**. Scope resolution runs first by design, so a
               *    request with both a malformed tenant id and an unusable
               *    credential is a 400 and not a 401. The alternative would let
               *    a caller distinguish "this tenant id is malformed" from
               *    "this tenant id is fine but you are not in it" by watching
               *    the status change with the credential — the exact oracle
               *    ADR-0014's 404 path exists to close;
               *  - the response **never echoes the value**. `context.value` is
               *    available here and is deliberately not read: the pointer
               *    names the parameter, the detail is a constant. Echoing an
               *    unvalidated path segment into a response body is reflected
               *    output, and station's problem-details shape has no field for
               *    it anyway;
               *  - `context.source` says which layer refused (`'scopeFrom'` for
               *    a route that pinned its own scope, `'scopeResolver'` for the
               *    module-level one above). Both produce the same body.
               */
              onInvalidScope: (_error, { param }) =>
                new ValidationException([
                  {
                    pointer: param ?? ORGANIZATION_ID_PARAMETER,
                    detail: 'Expected a UUID Organization identifier.',
                  },
                ]),
            },

            hooks: {
              /**
               * Station owns every refusal response (ADR-0014). Returning an
               * `Error` here fully replaces the library's mapping, and the RFC
               * 9457 filter turns each of these into the exact body station
               * already ships — including the constant 404 detail, which
               * `problem-details.ts:131-144` applies regardless of the
               * exception's message, so a bare `NotFoundException()` and a
               * chatty one are byte-identical.
               */
              onDenied: (denial: PermissionsDenial, _context: DenialContext) =>
                toStationException(denial),
            },

            /**
             * The incremental-cutover seam. This is what makes S7 a route at a
             * time instead of one 15-route commit, and the two lists do
             * different things on purpose:
             *
             *  - **`publicKeys: [IS_PUBLIC_ROUTE]`** — station's `@Public()`
             *    writes `IS_PUBLIC_ROUTE`, and this guard **allows** on it,
             *    exactly as it does for its own `@Public()`. Safe because the
             *    route is already unauthenticated under the legacy guard;
             *    nothing is weakened. It is also what stops `/health`
             *    answering 403 the moment `PermissionsGuard` is registered,
             *    which would fail every liveness probe in the deployment.
             *  - **`declaredKeys: [ROUTE_PERMISSION]`** — station's
             *    `@RequirePermission()`. This guard **ABSTAINS**: it returns
             *    `true` without resolving a principal, without checking
             *    anything and without stashing `RequestAuthorization`, and
             *    station's `PermissionGuard` — still registered, still
             *    enforcing — decides. Returning `true` from a `CanActivate` is
             *    not a grant; it is this guard declining to be the one that
             *    answers.
             *
             * Abstention is the whole design. Denying a legacy-declared route
             * would 403 every unmigrated endpoint the instant this guard is
             * registered; allowing it would be a hole. Abstaining leaves each
             * route exactly as protected as it was, and a route migrates the
             * moment it gains `@CedarPermission()`/`@CedarAuthenticated()` —
             * which take precedence, because an own declaration is read first.
             *
             * A route with a key from NEITHER family is still undeclared and
             * still follows `denial.onUndeclaredRoute` (deny).
             *
             * At S10 both lists are deleted along with the legacy guard.
             */
            interop: {
              publicKeys: [IS_PUBLIC_ROUTE],
              declaredKeys: [ROUTE_PERMISSION],
            },

            /**
             * Both audits run during the cutover: station's own
             * `RouteAuthorizationAudit` keeps reading `ROUTE_PERMISSION` while
             * routes migrate one at a time, and this one counts either family
             * as a declaration. `pnpm contracts:generate` boots the
             * application, so a route that satisfies neither fails CI rather
             * than production.
             *
             * The keys mirror `interop` above and must stay in step with it:
             * `interop` decides what the GUARD does with a foreign key, this
             * decides what the AUDIT does. A key in one and not the other is
             * the drift to look for — `ROUTE_PERMISSION` missing here fails the
             * boot audit on a route the guard is happily abstaining on, and
             * `IS_PUBLIC_ROUTE` missing here fails `HealthController` and
             * `MetricsController` before anyone reaches the guard at all.
             */
            routeAudit: {
              mode: 'error',
              additionalMetadataKeys: [ROUTE_PERMISSION, IS_PUBLIC_ROUTE],
            },

            // The instance scope is one static policy and every request to
            // `/me` needs it; the Organization scopes stay lazy.
            warmScopes: [INSTANCE_SCOPE],

            engine: {
              instanceId: 'station-api',
              // Cedar's validator refuses a policy set whose conditions touch
              // an optional attribute unguarded — the shape that makes a
              // `forbid` error and vanish. Leave it on.
              validateOnLoad: true,
              validateRequests: true,
              // Off by default and staying off: per-request reuse is
              // `ResolvedPrincipal.entities`, and a cross-request cache would
              // make a membership change invisible for its TTL.
              entityCache: false,
            },
          }),
        }),
      ],
      // Registered here so `DiscoveryService` finds it: the library scans the
      // whole container for `@EntityProvider()` classes at `onModuleInit`, and
      // an undiscovered provider means the guard warns once per route and every
      // decision needing a resource entity fails closed.
      providers: [StationEntityProvider],
      exports: [StationAuthorizationProvidersModule],
    }
  }
}

/**
 * The store and the resolver, in a module of their own.
 *
 * Separate from `AuthorizationEngineModule` because `PermissionsModule
 * .forRootAsync` has to *import* whatever its factory injects, and a dynamic
 * module cannot import the module that is constructing it.
 *
 * Owns the store's lifetime too: `StationPolicyStore` holds a poller timer, and
 * one that outlives the application is a test run that never exits and a
 * graceful shutdown that never finishes.
 */
@Module({
  imports: [
    // `AuthorizationService` and `OperatorsService`, for the principal
    // resolver. No `StationDatabaseModule.forFeature` is needed: the root
    // registration in `ApiDatabaseModule` is `isGlobal: true` and exports the
    // connection tokens, so `getStationDatabaseToken(...)` resolves anywhere.
    AuthorizationModule,
  ],
  providers: [
    {
      provide: StationPolicyStore,
      inject: [getStationDatabaseToken(APPLICATION_DATABASE_CONNECTION)],
      useFactory: (database: StationDatabase): StationPolicyStore => {
        const logger = new Logger('AuthorizationEngine')

        return new StationPolicyStore(database, (error) => {
          // The poller must never crash the process and must never clear the
          // cache: a stale-but-known policy set beats an empty one.
          logger.error(
            `Policy invalidation poll failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          )
        })
      },
    },
    StationPrincipalResolver,
  ],
  exports: [StationPolicyStore, StationPrincipalResolver],
})
export class StationAuthorizationProvidersModule
  implements OnApplicationShutdown
{
  readonly #store: StationPolicyStore

  constructor(store: StationPolicyStore) {
    this.#store = store
  }

  async onApplicationShutdown(): Promise<void> {
    await this.#store.dispose()
  }
}

/**
 * The whole 404-vs-403 contract, in one function.
 *
 * `not-a-member` (the route's `scope` gate denied) and `not-in-scope` (the
 * resolver found no `members` row) arrive from different places and an audit
 * sink wants to tell them apart — but they MUST produce the same response, and
 * that is why they share this branch rather than each building their own.
 *
 * Returns `undefined` for `invalid-scope`, which is not an omission. Hook order
 * is `hooks.onDenied` first, then `denial.onInvalidScope`: returning an `Error`
 * here would fully own the response and `onInvalidScope` would never run.
 * Returning nothing keeps the default mapping in play and lets the dedicated
 * hook — which is told `source`, `param` and `issues` — build the 400. Every
 * other arm is owned here, so the union stays exhaustive and a new denial
 * reason in a future release is a compile error rather than a silent 403.
 */
function toStationException(denial: PermissionsDenial): Error | undefined {
  switch (denial.reason) {
    case 'unauthenticated': {
      return new UnauthorizedException()
    }
    case 'not-a-member':
    case 'not-in-scope': {
      // Bare, message-less: `problem-details.ts` uses the constant 404 detail
      // for every 404, so this cannot become a cross-tenant existence oracle
      // even if a future call site passes something helpful.
      return new NotFoundException()
    }
    case 'invalid-resource-param': {
      return new ValidationException([
        {
          pointer: denial.param,
          detail:
            denial.param === ORGANIZATION_ID_PARAMETER
              ? 'Expected a UUID Organization identifier.'
              : 'Expected a UUID Project identifier.',
        },
      ])
    }
    case 'invalid-scope': {
      // Deliberately unowned here — `denial.onInvalidScope` builds this 400.
      // See the note on this function.
      return undefined
    }
    case 'forbidden':
    case 'plan-denied':
    case 'undeclared-route': {
      return new ForbiddenException()
    }
    case 'engine-unavailable': {
      // Never fail open: an engine that cannot decide refuses the request.
      return new ServiceUnavailableException()
    }
    case 'misconfigured': {
      return new InternalServerErrorException()
    }
  }
}

/* ===========================================================================
 * OPTIONAL, AND WORTH IT: typed actions
 * ===========================================================================
 *
 * Unaugmented, `ActionName` and `ResourceTypeName` fall back to `string`, so
 * `@CedarPermission('projct:read', …)` compiles and denies at runtime. One
 * declaration turns every typo into a compile error and makes a mismatched
 * action/resource pair — `run:cancel` on an `Organization` — unwritable.
 *
 * It belongs in `apps/api`, not `packages/platform`: it augments a module
 * `packages/platform` does not depend on. Put it in its own file
 * (`apps/api/src/authorization/permissions-registry.d.ts`) so no import order
 * decides whether it is in effect.
 *
 *   import type { stationVocabulary } from '@station/platform'
 *
 *   declare module '@nestm/permissions' {
 *     interface PermissionsTypeRegistry {
 *       vocabulary: typeof stationVocabulary
 *     }
 *   }
 *
 * One consequence to know about before doing it: once the registry is
 * augmented, `FeatureEntityProvider` stops defaulting to `AnyVocabulary`, and
 * `StationEntityProvider` above must be `FeatureEntityProvider<typeof
 * stationVocabulary>`. The library's own tests do not cover that path — its
 * errata records that the variance problem was found by an example app's
 * typecheck, not by the package's tests — so expect to iterate once here.
 */
