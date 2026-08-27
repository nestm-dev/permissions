> Slice: `@nestm/permissions` (the NestJS 12 module) + the `nestm-dev/permissions` monorepo scaffolding.
> Binding template read in full: `/Users/kauan/Projects/nestm/better-auth/src/**`. Integration target read: `/Users/kauan/Projects/concepta/station/apps/api/src/authorization/**`.

## 0. Decisions taken up front (the nestmLibs.md "unresolved divergences")

Any package here has constructor DI, so **better-auth wins every divergence**:

| Divergence | Call | Why |
|---|---|---|
| `verbatimModuleSyntax` | **`false`** | Mandatory — type-only import erasure breaks `design:paramtypes` (`better-auth/CONTRIBUTING`) |
| Build | **tsdown**, `fixedExtension: true`, `dts: true` | Never esbuild; CI greps `design:paramtypes` out of `dist/index.mjs` |
| Import extensions | **`.ts`** + `allowImportingTsExtensions` + `rewriteRelativeImportExtensions` | Matches tsdown |
| Prettier | better-auth's: tabs, width 100, double quotes | |
| Oxlint | better-auth's **`.oxlintrc.json`** verbatim (standard-schema's `oxlint.json` is inert) | |
| `exactOptionalPropertyTypes` | `false` | better-auth |
| Release script | **standard-schema's hardened `scripts/publish.mjs`**, adapted for multi-package | |
| License / author | **MIT © Kauan Guesser** (see open questions) | |

---

## 1. Monorepo scaffolding

```
permissions/                        github.com/nestm-dev/permissions
├─ pnpm-workspace.yaml              packages: ['packages/*','examples/*']
│                                   + allowBuilds{@nestjs/core:false} + provenance:true
├─ package.json                     private:true; scripts delegate `pnpm -r --filter …`
├─ tsconfig.base.json               shared compilerOptions (better-auth's, verbatimModuleSyntax:false)
├─ tsconfig.json                    solution-style `references` → 4 packages (`tsc -b` for typecheck)
├─ .oxlintrc.json .prettierrc.json .prettierignore .gitignore .nvmrc .npmrc
├─ .changeset/{config.json,pre.json}
├─ scripts/{publish.mjs,publish-state.mjs,clean.mjs,assert-core-framework-free.mjs}
├─ .github/workflows/{ci,release,preview}.yml + dependabot.yml
├─ references/                      vendored prior art (cerbos/query-plan-adapters, @ucast/sql) — gitignored
├─ examples/station-fastify/
└─ packages/{permissions-core,permissions,permissions-typeorm,permissions-drizzle}/
```

**Changesets in `fixed` mode**, not `linked`:
```jsonc
"fixed": [["@nestm/permissions-core","@nestm/permissions","@nestm/permissions-typeorm","@nestm/permissions-drizzle"]]
```
`.changeset/pre.json` → `{ mode:"pre", tag:"alpha" }`; consumed prerelease changesets live in `.changeset/pre/`.
Rationale: the `QueryPlan` AST lives in core; every driver is pinned to it. Lockstep versions also guarantee pnpm/npm dedupes to **one physical copy of core** — critical, because Cedar's WASM caches preparsed policy sets by string ID *per module instance*.

**Cross-package deps:** all three consumers take `@nestm/permissions-core` as a plain **`dependency`** (`workspace:^`, rewritten on publish). Do *not* use peers — with `fixed` versioning a single range resolves to one copy, and peers on a sibling are user-hostile.
**Constraint handed to the core slice:** core's WASM import must be **lazy** (`await import("@cedar-policy/cedar-wasm/nodejs")` inside `createAuthorizationEngine`) so the ORM drivers, which only need `QueryPlan`/`PlanExpression` types + a pure AST walker, never instantiate 4.1 MiB of WASM. (Verified in the shipped tarball: `nodejs/cedar_wasm.js` is CJS, `type:"commonjs"`, uses `exports.foo = foo` — so ESM named imports work via cjs-module-lexer — and it instantiates WASM **synchronously** at module top level with `require('fs').readFileSync`. No async WASM init is needed anywhere.)

**Enforcing "core stays Nest-free"** — two mechanisms, no new dependency (skip dependency-cruiser):
1. `scripts/assert-core-framework-free.mjs` — static: fails if `packages/permissions-core/src/**` matches `@nestjs/`, or if its `package.json` declares any `@nestjs/*` dep/peer.
2. CI job `core-framework-free`: `pnpm pack` core → install the tarball into a bare temp dir with **zero** `@nestjs` packages → `node -e "import('@nestm/permissions-core').then(m=>m.createAuthorizationEngine)"`. Black-box, catches transitive leaks.

**CI matrix** (`ci.yml`, adapted from `better-auth/.github/workflows/ci.yml`):
- `check` (node 24): root lint, format check and `tsc -b`, then the registry-augmenting example's typecheck and build
- `build` → matrix over the 4 packages: `publint --strict` + `attw --pack packages/$P --profile esm-only`; the `design:paramtypes` grep runs on the Nest package and both drivers' `./nestjs` entries (core has no DI)
- `test` matrix `node:[22,24] × adapter:[express,fastify]` → `@nestm/permissions`; `node:[22,24]` → core
- `test-drivers` — `services: postgres:16-alpine`, runs the two ORM packages' integration suites
- `core-framework-free` (above)
- `canary` (non-blocking): `pnpm up "@nestjs/*@next"` **and** `pnpm up @cedar-policy/cedar-wasm@latest` — the cedar canary is load-bearing because `isAuthorizedPartial` is experimental

**`release.yml`** = better-auth's, with Changesets action v2 `publish-script: pnpm run release` → the hardened `scripts/publish.mjs` and `version-script: pnpm run version-packages`. Three adaptations: (a) `publish-state.mjs` gains `assertFixedVersions(versions[], preState)` that reads all four `package.json`s and refuses to publish if they diverge or mismatch the pre-tag; (b) the "reconcile git tag with npm" step loops over all four names; (c) `pr-title`/`commit-message` → `chore: release @nestm/permissions`.

---

## 2. `packages/permissions` — file layout

```
src/
  index.ts                                   barrel, comment-sectioned, `type`-prefixed type exports
  permissions.module.ts                      @Module + ConfigurableModuleClass + forFeature
  permissions.module-definition.ts           ConfigurableModuleBuilder
  permissions.tokens.ts                      Symbol DI tokens
  permissions.constants.ts                   METADATA_KEY, AUTHORIZATION_STATE
  interfaces/{permissions-module-options,permissions-options-factory,permissions-feature-options,
              principal-resolver,route-audit-options}.interface.ts
  decorators/{require-permission,authorization,inject-permissions,entity-provider}.decorator.ts
  guards/{permissions.guard.ts, authz-errors.ts}
  services/{permissions.service.ts, policy-set.manager.ts,
            entity-provider.registry.ts, entity-provider.discovery.service.ts,
            request-authorization.ts}
  providers/{engine.provider.ts, policy-store.provider.ts, principal-resolver.provider.ts}
  resolvers/{request-principal.resolver.ts, resource-ref.resolver.ts}
  audit/route-authorization.audit.ts
  types/{permissions-registry.types.ts, request.types.ts}
  utils/execution-context.util.ts            adapted from better-auth (copy, do not depend)
tests/{setup.ts, shared/*, unit/*, e2e/*}
```

---

## 3. Module definition

`permissions.tokens.ts`:
```ts
export const PERMISSIONS_MODULE_OPTIONS = Symbol("PERMISSIONS_MODULE_OPTIONS");
export const AUTHORIZATION_ENGINE       = Symbol("AUTHORIZATION_ENGINE");
export const POLICY_STORE               = Symbol("POLICY_STORE");
export const PRINCIPAL_RESOLVER         = Symbol("PRINCIPAL_RESOLVER");
export const PERMISSIONS_SCHEMA         = Symbol("PERMISSIONS_SCHEMA");
```
`permissions.constants.ts`:
```ts
export const AUTHORIZATION_STATE = Symbol("permissions:authorization_state"); // ← mirrors SESSION_RESOLVED
export const METADATA_KEY = {
  requirePermission:    "permissions:require_permission",
  public:               "permissions:public",
  requireAuthenticated: "permissions:require_authenticated",
  entityProvider:       "permissions:entity_provider",
} as const;
```
`permissions.module-definition.ts` — 1:1 with `better-auth/src/better-auth.module-definition.ts:10-27`:
```ts
new ConfigurableModuleBuilder<PermissionsModuleOptions>({ optionsInjectionToken: PERMISSIONS_MODULE_OPTIONS })
  .setClassMethodName("forRoot")
  .setFactoryMethodName("createPermissionsOptions")
  .setExtras<PermissionsModuleExtras>({ isGlobal: true, disableGlobalGuard: false },
    (definition, extras) => ({ ...definition, global: extras.isGlobal !== false,
      providers: [...(definition.providers ?? []),
                  ...(extras.disableGlobalGuard ? [] : [{ provide: APP_GUARD, useClass: PermissionsGuard }])] }))
  .build();
```

Options interface:
```ts
export interface PermissionsModuleOptions {
  schema: CedarSchemaSource;                       // text | json | CompiledSchema (from core)
  store?: PolicyStoreDefinition;                   // {useClass|useExisting|useFactory,inject} | PolicyStore
  policies?: readonly PolicySource[];              // static seed → in-memory store when `store` omitted
  principalResolver?: PrincipalResolverDefinition; // default RequestPrincipalResolver
  context?: (ctx: RequestContext) => CedarContext | Promise<CedarContext>;
  denial?: DenialOptions;
  routeAudit?: RouteAuditOptions;                  // default { mode: 'off' }
  validation?: { mode?: "strict" | "permissive" | "off" };  // cedar validate() at load, default "strict"
  reload?: { intervalMs?: number } | false;
  queryPlan?: { fallback?: "deny" | "throw" };     // when isAuthorizedPartial is unavailable/errors
  hooks?: PermissionsHooks;
}
export interface PermissionsModuleExtras { isGlobal?: boolean; disableGlobalGuard?: boolean }
```

**Engine construction — two phases (deliberate):**
- **Phase A** `providers/engine.provider.ts`: async `useFactory` on `[PERMISSIONS_MODULE_OPTIONS]` → `createAuthorizationEngine({ schema, validation, queryPlan })`. Compiles + `preparseSchema`. No I/O.
- **Phase B** `PolicySetManager implements OnModuleInit`: `await store.load()` → `engine.loadPolicies()` (which `preparsePolicySet`s under a fresh id) → sets `state='ready'`, `revision`. Also owns `reload()` and the optional interval poller, and `OnApplicationShutdown` to clear the timer.

Splitting matters because the store may live in a sibling module (TypeORM/Drizzle) whose connection is not guaranteed during factory resolution, and because runtime-editable policies need a first-class `reload()`. **The guard calls `policySet.assertReady()` and throws `ServiceUnavailableException` if not — fail closed, never "no policies ⇒ allow".**

`forFeature` — **yes, keep it**, thin, mirroring `better-auth.module.ts:120-129`: `PermissionsModule.forFeature({ entityProviders: [ProjectEntityProvider] })` with `assertEntityProviderClass()` validation, hosted on a `PermissionsFeatureModule`. Classes listed in any module's `providers` are discovered identically (`DiscoveryService.createDecorator()` + `EntityProviderDiscoveryService.scan()` in `onModuleInit`). This is genuinely needed: the Cedar entity graph is per-feature knowledge (tenancy knows Orgs, projects knows Projects).

---

## 4. Guard & decorators

```ts
export type ResourceRef =
  | { kind: "param"; param: string; type: ResourceTypeName; parseAs?: StandardSchemaV1 | "uuid" | "int" | "string" }
  | { kind: "literal"; type: ResourceTypeName; id: string }
  | { kind: "unspecified"; type: ResourceTypeName }        // ← triggers the query plan
  | { kind: "resolver"; resolve: (ctx: ResourceResolutionContext) => EntityUid | Promise<EntityUid> };

export interface RoutePermissionOptions {
  /** Evaluated BEFORE the action check. A denial here yields 404, not 403 — ADR-0014. */
  scope?: { action: ActionName; resource: ResourceRef };
  onDeny?: "forbidden" | "not-found";
}
export const RequirePermission: (action: ActionName, resource?: ResourceRef, options?: RoutePermissionOptions) => …
export const RequireAuthenticated = Reflector.createDecorator<void, true>({ key: METADATA_KEY.requireAuthenticated, transform: () => true });
export const Public               = Reflector.createDecorator<void, true>({ key: METADATA_KEY.public, transform: () => true });
```

**Typed actions** — via declaration merging, exactly like `better-auth`'s `BetterAuthTypeRegistry` (`src/types/auth.types.ts`):
```ts
export interface PermissionsTypeRegistry {}                      // app augments: { schema: typeof stationSchema }
export type RegisteredSchema = PermissionsTypeRegistry extends { schema: infer S } ? S : AnySchema;
export type ActionName       = ActionOf<RegisteredSchema>;       // falls back to `string` unaugmented
```
One exported decorator, no factory duplication. `tests/unit/type-assertions.ts` must prove both branches (augmented → typo rejected; unaugmented → `string`).

**Guard flow** (`guards/permissions.guard.ts`), fail-closed at every step:
1. `@Public` via `getAllAndOverride([handler, class])` → allow — **unless the handler itself declares `@RequirePermission`** (copy `better-auth.guard.ts:60-68` `handlerDeclaresAuthorization`).
2. Read `@RequirePermission`. **Absent → `ForbiddenException`** (station `permission.guard.ts:76-80`); configurable `denial.onUndeclaredRoute: "deny" | "allow"`, default `"deny"`.
3. `policySet.assertReady()`.
4. `principalResolver.resolve(ctx)`; `null` → `UnauthorizedException` (context-aware). One-time `logger.warn` if no auth guard ever ran (`session.decorator.ts:9-16` precedent).
5. `@RequireAuthenticated` → stash state, allow.
6. Resolve `ResourceRef`. **Guards run before pipes** — `param` refs are parsed here with `parseAs` (a Standard Schema, so station passes `organizationIdSchema` directly); failure → `BadRequestException`, overridable via `denial.onInvalidParam`.
7. Build Cedar context from `options.context(request)`.
8. Collect entities: principal entities + `EntityProviderRegistry` contributions for the resource and its ancestors.
9. If `options.scope` → `engine.isAuthorized(scope)`; deny → `Denial{reason:"not-a-member"}` → **404 path**.
10. Main check. `resource.kind === "unspecified"` → `engine.plan(...)`: `ALWAYS_DENY` → forbidden; `ALWAYS_ALLOW`/`CONDITIONAL` → allow, stash the plan.
11. Stash `RequestAuthorization` at `request[AUTHORIZATION_STATE]`.
12. `hooks.onDecision(record)` — swallowed, never throws into the request.

**Transport scope, honestly:** v1 = **http + graphql**. `resolveContextKind`/`getRequestFromContext` are copied from `better-auth/src/utils/execution-context.util.ts` so `ws`/`rpc` produce the correct exception types (`authz-errors.ts` mirrors `guards/auth-errors.ts`), but `ResourceRef{kind:"param"}` throws a clear configuration error on ws/rpc — those contexts must use `literal` or `resolver`. Documented in Limitations.

---

## 5. 404-vs-403 (ADR-0014)

Three layers, coarse→fine:
```ts
export type Denial =
  | { reason: "unauthenticated" }
  | { reason: "forbidden"; diagnostics: AuthorizationDiagnostics }
  | { reason: "not-a-member"; gate: ActionName }
  | { reason: "engine-unavailable" }
  | { reason: "invalid-resource-param"; param: string };

export interface DenialOptions {
  default?: "forbidden" | "not-found";
  onUndeclaredRoute?: "deny" | "allow";
  notFoundStatus?: number;                       // default 404
}
export interface PermissionsHooks {
  /** Return an Error to fully own the response (station returns its RFC 9457 exception). */
  onDenied?(denial: Denial, ctx: AuthorizationContext): Error | void | Promise<Error | void>;
  onDecision?(record: DecisionRecord): void | Promise<void>;
}
```
1. Module-level `denial.default`.
2. Per-route `@RequirePermission(..., { onDeny: "not-found" })`.
3. Per-route `scope` pre-check — the exact station semantic: **non-membership → 404 with a constant body; member-lacking-permission → 403**. Two `statefulIsAuthorized` calls, both in-WASM, negligible cost.
4. `hooks.onDenied` returning an `Error` overrides everything.

E2E test asserts **byte-identical bodies** for "unknown org" vs "non-member probe" — that is the real security property, and it is testable.

## 6. Boot-time route audit

`audit/route-authorization.audit.ts` — generalizes `station/apps/api/src/authorization/route-authorization.audit.ts`. `OnApplicationBootstrap`, `DiscoveryService.getControllers()` + `MetadataScanner.getAllMethodNames()` + `Reflect.getMetadata(PATH_METADATA, handler) !== undefined` to identify route handlers.
```ts
export interface RouteAuditOptions {
  mode?: "off" | "warn" | "error";                       // default "off" (opt-in)
  ignoreControllers?: readonly (string | RegExp | Type<unknown>)[];
  ignoreRoutes?: readonly RegExp[];                       // matched against `Controller.method`
  additionalMetadataKeys?: readonly (string | symbol)[];  // ← lets station keep its own ROUTE_PERMISSION key
}
```
Improvements over station's: reports `GET /organizations/:id → OrgController.find` (reads `METHOD_METADATA` + controller `PATH_METADATA`) instead of just `Class.method`; `findUndeclaredRoutes()` stays public for tests. `additionalMetadataKeys` is the station migration escape hatch — during the cutover both decorator families count as declared.
**Gotcha:** `PATH_METADATA` comes from `@nestjs/common/constants` (a deep import). Wrap in a try/catch with a `"path"` string-literal fallback and flag the Nest-internal coupling.

## 7. Request-scoped helpers

`PermissionsService` is a **singleton** (never `Scope.REQUEST` — kills Fastify throughput):
```ts
@Injectable() export class PermissionsService {
  check(input: CheckInput): Promise<AuthorizationDecision>;
  checkOrThrow(input: CheckInput): Promise<void>;
  checkAll(inputs: readonly CheckInput[]): Promise<readonly AuthorizationDecision[]>;
  plan(input: PlanInput): Promise<QueryPlan>;
  reloadPolicies(): Promise<void>;
  get revision(): string;
}
```
Param decorators (`decorators/authorization.decorator.ts`), all reading `request[AUTHORIZATION_STATE]`:
- `@CurrentPrincipal()` → `ResolvedPrincipal`
- `@CurrentAuthorization()` → `RequestAuthorization`, throws `ForbiddenException` when absent (station `current-authorization.decorator.ts:16-20`); `@CurrentAuthorization({ optional: true })` → `null`
- `@QueryPlan()` → thin alias for `auth.plan`

```ts
export interface RequestAuthorization {
  readonly principal: ResolvedPrincipal;
  readonly context: CedarContext;
  readonly route: RoutePermission | undefined;
  /** Precomputed by the guard when the route declared `resource: {kind:"unspecified"}`. */
  readonly plan: QueryPlan | undefined;
  planFor(action: ActionName, resourceType: ResourceTypeName, opts?: PlanOptions): Promise<QueryPlan>;
  can(action: ActionName, resource: EntityUidLike): Promise<boolean>;
}
```
**CONDITIONAL ergonomics:** the three-state plan is never collapsed by this package. `@nestm/permissions-drizzle` / `-typeorm` export `compilePlan(plan, mapping)` returning the same discriminated union with `where` attached, plus `applyPlan(qb|query, plan, mapping)`. Handler code:
```ts
const plan = auth.plan!;                     // declared on the route, so non-null
const rows = await this.runs.list(compilePlan(plan, runFieldMapping));
```

## 8. Interop — without hard coupling

**One** class, `resolvers/request-principal.resolver.ts`, covers better-auth, plain JWT guards, and station:
```ts
export interface RequestPrincipalResolverOptions<T = unknown> {
  property?: string;                          // "session" (better-auth) | "user" (JWT) | "identity" (station)
  map(source: T, ctx: PrincipalResolutionContext): ResolvedPrincipal | null;
}
```
Zero imports from `@nestm/better-auth`; it just reads `request.session`, which `BetterAuthGuard` sets (`better-auth.guard.ts:113-116`). README ships the three recipes. Also document guard **ordering**: two `APP_GUARD` providers execute in registration order (station relies on this, `app.module.ts:40-46`) — the auth guard must be registered first.

## 9. Testing

better-auth layout: `tests/{unit,e2e,shared}/**/*.test.ts`, `tests/setup.ts` = `import "reflect-metadata"`, vitest 4 globals, `pool:"forks"`, `TEST_HTTP_ADAPTER=express|fastify` via `tests/shared/http-adapter.ts` (copy verbatim) and `tests/shared/test-app.ts`.
- `tests/shared/test-schema.ts` — one small Cedar schema (`User`/`Group`/`Org`/`Project`/`Run` + actions) reused by every suite
- `unit/exports.test.ts` — barrel test (better-auth convention)
- `unit/type-assertions.ts` — `expectTypeOf`, augmented + unaugmented registry
- `unit/{module-definition,resource-ref,route-audit}.test.ts`
- `e2e/{module,guard,denial-strategy,principal-resolver,query-plan,route-audit,imperative-service}.e2e.test.ts` — real `Test.createTestingModule` + supertest, both adapters

## 10. Ordered task list

| # | Task | Files | Size |
|---|---|---|---|
| 1 | Repo scaffold: workspace, tsconfig.base + solution refs, oxlint/prettier, changesets fixed+pre, LICENSE/README/CONTRIBUTING/SECURITY | root | 0.5 d |
| 2 | Adapt `scripts/publish.mjs` + `publish-state.mjs` (`assertFixedVersions`) + `assert-core-framework-free.mjs` + their vitest specs | `scripts/` | 0.5 d |
| 3 | CI + release + preview + dependabot workflows | `.github/` | 0.5 d |
| 4 | Four package skeletons: package.json, tsdown.config.ts, tsconfig, vitest.config, empty barrel; green `pnpm -r build` | `packages/*` | 0.5 d |
| 5 | **Blocked on core:** pin the consumed contract (`AuthorizationEngine`, `QueryPlan`, `PolicyStore`, `EntityUid`, `CedarContext`) as a written interface doc + type-only stub so this package compiles ahead of core | `packages/permissions-core/src/index.ts` | 0.5 d |
| 6 | tokens + constants + module-definition + options/factory interfaces | `src/permissions.{tokens,constants,module-definition}.ts`, `src/interfaces/` | 0.5 d |
| 7 | `engine.provider.ts`, `policy-store.provider.ts`, `principal-resolver.provider.ts`, `PolicySetManager` (`OnModuleInit`/`reload`/`revision`/state machine) | `src/providers/`, `src/services/policy-set.manager.ts` | 1 d |
| 8 | Decorators: `@RequirePermission`/`@Public`/`@RequireAuthenticated`, `@InjectAuthorizationEngine`, registry types | `src/decorators/`, `src/types/` | 0.5 d |
| 9 | `resource-ref.resolver.ts` (Standard-Schema param codecs) + `request-principal.resolver.ts` | `src/resolvers/` | 0.5 d |
| 10 | `@EntityProvider` + discovery service + registry + `forFeature` | `src/services/entity-provider.*`, `src/permissions.module.ts` | 0.5 d |
| 11 | **`PermissionsGuard`** + `authz-errors.ts` + `execution-context.util.ts` (12-step flow, denial strategy) | `src/guards/`, `src/utils/` | 1.5 d |
| 12 | `PermissionsService`, `RequestAuthorization`, `@CurrentPrincipal`/`@CurrentAuthorization`/`@QueryPlan` | `src/services/`, `src/decorators/authorization.decorator.ts` | 1 d |
| 13 | `RouteAuthorizationAudit` | `src/audit/` | 0.5 d |
| 14 | `permissions.module.ts` wiring + barrel + exports test | `src/permissions.module.ts`, `src/index.ts` | 0.5 d |
| 15 | Test harness (`shared/*`) + unit suites | `tests/unit`, `tests/shared` | 1 d |
| 16 | E2E suites, both adapters | `tests/e2e` | 1.5 d |
| 17 | README (family shape: pitch → CAUTION → install → quick start → options → API → semantics → **Limitations** → comparison) + CHANGELOG seed + initial changeset | docs | 0.5 d |
| 18 | `examples/station-fastify` | `examples/` | 0.5 d |

**~12 days** for this slice. Steps 1–4 are unblocked and should land first; 5 is the sync point with the core slice; 11 is the single highest-risk file.

## Verification

```bash
pnpm install --frozen-lockfile
pnpm -r run lint && pnpm run format:check && pnpm exec tsc -b          # check
pnpm -r run build
pnpm dlx publint --strict --pack packages/permissions
pnpm dlx @arethetypeswrong/cli --pack packages/permissions --profile esm-only
node -e "const s=require('fs').readFileSync('packages/permissions/dist/index.mjs','utf8');
         if(!s.includes('design:paramtypes')) throw new Error('decorator metadata dropped')"
node scripts/assert-core-framework-free.mjs
pnpm --filter @nestm/permissions run test:express
pnpm --filter @nestm/permissions run test:fastify
```
Smoke checks that must pass:
- A controller with no authz decorator → **403**, and with `routeAudit.mode:"error"` the app **refuses to boot**.
- Unknown-org 404 body is **byte-identical** to non-member-probe 404 body.
- `PolicySetManager` never reaching `ready` → every guarded route returns **503**, not 200.
- `@RequirePermission("typo:action")` fails `tsc` once `PermissionsTypeRegistry` is augmented.
- `import("@nestm/permissions-core")` succeeds in a directory with zero `@nestjs` packages installed.

## Out of scope for this slice
Cedar wrapper internals, schema builder, residual→`PlanExpression` lowering (core); the two ORM compilers; the station migration PR itself (this slice only provides `routeAudit.additionalMetadataKeys` and `hooks.onDenied` as its migration seams).
