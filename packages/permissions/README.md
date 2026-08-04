# @nestm/permissions

> [!CAUTION]
> Alpha. Published under the `alpha` tag; every release may break. Do not use this in production.

The NestJS 12 module of the [`@nestm/permissions`](https://github.com/nestm-dev/permissions)
family. You declare what a route enforces; a fail-closed `APP_GUARD` resolves the principal, asks
[Cedar](https://www.cedarpolicy.com/), and either lets the request through or refuses it with the
status you chose.

```ts
@Get(":runId")
@RequirePermission("run:read", { kind: "param", param: "runId", type: "Run", parseAs: runIdSchema })
find(@Param("runId") id: string) {}          // reached only if Cedar said allow
```

Three things make it different from a roles-and-guards setup:

- **Policies live in a store**, including a database, so a grant is a row — editable per tenant at
  runtime, with no deploy. Roles are Cedar templates; a grant is a template link.
- **List endpoints get a query plan**, not a loop. `{ kind: "unspecified" }` compiles "which rows may
  this principal read" into a three-state
  [`QueryPlan`](https://github.com/nestm-dev/permissions/tree/main/packages/permissions-core#query-plans)
  that `@nestm/permissions-drizzle` / `-typeorm` push into `WHERE`.
- **404-vs-403 is a first-class option.** A non-member's probe and an unknown tenant produce
  byte-identical responses, which is asserted by a test rather than hoped for.

Everything is typed against your vocabulary: `@RequirePermission("run:dispathc", …)` is a compile
error, not a `deny` discovered in production.

## Install

```sh
npm install @nestm/permissions@alpha @nestm/permissions-core@alpha
```

Node >= 22.12, ESM only. Peers: `@nestjs/common` and `@nestjs/core` `^12`, `reflect-metadata`,
`rxjs`. `@nestm/permissions-core` is a normal dependency of this package; install it directly too,
because you build your vocabulary with it.

## Quick start

### 1. Describe your domain once

```ts
// authorization/vocabulary.ts
import { defineVocabulary, t } from "@nestm/permissions-core";

export const vocabulary = defineVocabulary({
	namespace: "Station",
	entities: {
		Organization: {},
		Role: { memberOf: ["Organization"] },
		Member: { memberOf: ["Organization", "Role"], attrs: { organization: t.ref("Organization") } },
		Project: { memberOf: ["Organization"] },
		Run: { memberOf: ["Project"], attrs: { project: t.ref("Project"), status: t.string() } },
	},
	actions: {
		"run:read": { principal: ["Member"], resource: ["Run"] },
		"run:dispatch": { principal: ["Member"], resource: ["Run"] },
	},
});
```

### 2. Register the module, and augment the type registry

```ts
// app.module.ts
import { NOT_IN_SCOPE, PermissionsModule, RequestPrincipalResolver } from "@nestm/permissions";
import { vocabulary } from "./authorization/vocabulary.ts";

@Module({
	imports: [
		PermissionsModule.forRoot({
			vocabulary,
			// Omit `store` for an in-memory store seeded from `policies`/`links`;
			// pass one (TypeORM, Drizzle, your own) for runtime-editable policies.
			policies: [
				{
					id: "role:reader",
					scope: "org:acme",
					text: `permit(principal in ?principal, action == Station::Action::"run:read", resource in ?resource);`,
				},
			],
			principalResolver: new RequestPrincipalResolver<{ id: string; orgId: string }>({
				property: "user",
				map: (user, { scope }) =>
					scope === `org:${user.orgId}`
						? { ref: { type: "Member", id: user.id }, entities: [] }
						: NOT_IN_SCOPE,
			}),
			scopeResolver: ({ params }) => `org:${String(params.organizationId)}`,
			denial: { default: "forbidden" },
			routeAudit: { mode: process.env.CI ? "error" : "warn" },
		}),
	],
})
export class AppModule {}

// Augment once, anywhere in your app — every default-generic type in this
// package becomes vocabulary-aware, with no repeated generics.
declare module "@nestm/permissions" {
	interface PermissionsTypeRegistry {
		vocabulary: typeof vocabulary;
	}
}
```

`forRoot` registers `PermissionsGuard` as an `APP_GUARD` and the module as global. Pass
`disableGlobalGuard: true` to apply it with `@UseGuards()` yourself, or `isGlobal: false` to import
it per feature module.

### 3. Supply the entity graph

Cedar decides about _entities_, so something must tell it that a member belongs to an organisation
and a run belongs to a project. Either the principal resolver returns that graph, or an
`@EntityProvider()` class contributes it — the guard resolves the principal graph **once per
request** and passes it explicitly.

```ts
@EntityProvider()
@Injectable()
export class RunEntityProvider implements FeatureEntityProvider {
	constructor(private readonly runs: RunRepository) {}

	async resolveResource({ resource }: EntityResolutionRequest<typeof vocabulary>) {
		if (resource?.type !== "Run") return [];
		const run = await this.runs.findById(resource.id);
		return run
			? [
					entity(vocabulary, "Run", run.id, {
						attrs: { project: { type: "Project", id: run.projectId }, status: run.status },
						parents: [{ type: "Project", id: run.projectId }],
					}),
				]
			: [];
	}
}
```

Any class in any module's `providers` is discovered; `PermissionsModule.forFeature({ entityProviders:
[…] })` is the ergonomic shorthand.

On a query-plan route, resolver requests have no single `resource` but do include `resourceType`.
Provider failures are surfaced as `ENTITY_RESOLUTION` operational errors; the guard logs and audits
them as `engine-unavailable` and returns 503 rather than misreporting an infrastructure outage as a
policy denial.

### 4. Declare what each route enforces

```ts
@Controller("organizations/:organizationId/runs")
export class RunsController {
	/** One row. The id is validated in the guard — guards run before pipes. */
	@Get(":runId")
	@RequirePermission("run:read", {
		kind: "param",
		param: "runId",
		type: "Run",
		parseAs: runIdSchema,
	})
	find(@Param("runId") id: string) {}

	/** A list: no resource named, so the guard compiles a plan the handler pushes down. */
	@Get()
	@RequirePermission("run:read", { kind: "unspecified", type: "Run" })
	list(@QueryPlan() plan: QueryPlan) {
		if (plan.kind === "ALWAYS_DENY") return [];
		return this.runs.list(plan.kind === "CONDITIONAL" ? compilePlan(plan, runMapping) : undefined);
	}

	/** No Cedar decision, just a resolvable principal. */
	@Get("mine")
	@RequireAuthenticated()
	mine(@CurrentPrincipal() principal: ResolvedPrincipal) {}

	@Get("health")
	@Public()
	health() {}
}
```

Every route needs one of those four. A route with none is **refused with 403** — and with
`routeAudit.mode: "error"` the application refuses to boot at all.

## Options

`PermissionsModule.forRoot(options)` / `forRootAsync({ useFactory | useClass | useExisting })`.

| Option               | Default                | Notes                                                                                                                                            |
| -------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `vocabulary`         | —                      | Required. The output of `defineVocabulary`.                                                                                                      |
| `store`              | seeded in-memory store | `PolicyStore` instance or `{ useClass \| useExisting \| useFactory, inject }`. See [Provider dependencies](#provider-dependencies).              |
| `policies` `links`   | `[]`                   | Seeds for the built-in memory store. Combining them with `store` throws — this module never issues an unrequested write against a store you own. |
| `principalResolver`  | —                      | Turns a request into a principal. Same four provider shapes. See [Provider dependencies](#provider-dependencies).                                |
| `contextBuilder`     | `() => ({})`           | Builds the Cedar request context from the transport request plus the resolved action, scope, and principal.                                      |
| `scopeResolver`      | —                      | Derives the tenant scope from the request. See [Scope resolution](#scope-resolution).                                                            |
| `denial`             | see below              | How a refusal becomes a response.                                                                                                                |
| `interop`            | —                      | Another guard's metadata keys, for a route-by-route cutover. See [Migrating from another guard](#migrating-from-another-guard).                  |
| `routeAudit`         | `{ mode: "off" }`      | Boot-time route coverage. See [Route audit](#route-audit).                                                                                       |
| `warmScopes`         | `[]`                   | Scopes preloaded at `OnModuleInit`. A failure is logged, never fatal: loading is lazy per scope anyway.                                          |
| `engine`             | core defaults          | Passed straight to `createEngine` (`validateOnLoad`, `policySetCache`, `instanceId`, `onDecision`, …).                                           |
| `hooks`              | —                      | `onDenied` (own the response) and `onDecision` (audit sink).                                                                                     |
| `imports`            | `[]`                   | Extra. Modules exporting singleton providers referenced by static `store` or `principalResolver` definitions.                                    |
| `isGlobal`           | `true`                 | Extra. Registers the module globally.                                                                                                            |
| `disableGlobalGuard` | `false`                | Extra. Skips the automatic `APP_GUARD` registration.                                                                                             |

`denial`:

| Field               | Default       | Notes                                                                  |
| ------------------- | ------------- | ---------------------------------------------------------------------- |
| `default`           | `"forbidden"` | Response for an ordinary authorization denial.                         |
| `onUndeclaredRoute` | `"deny"`      | `"allow"` for incremental adoption; logged once per route.             |
| `notFoundStatus`    | `404`         | Status the not-found path uses.                                        |
| `onInvalidParam`    | —             | Replaces the `BadRequestException` a failed `parseAs` produces.        |
| `onInvalidScope`    | —             | Replaces the `BadRequestException` a failed scope resolution produces. |

### Provider dependencies

`useExisting` and every token in `useFactory.inject` are native Nest dependencies. With static
`forRoot()`, list the module that exports those singleton/default-scope providers in `imports` (a
global export also works):

```ts
@Module({
	imports: [DatabaseModule],
	providers: [SessionPrincipalResolver],
	exports: [SessionPrincipalResolver, DatabaseModule],
})
class AuthorizationDependenciesModule {}

PermissionsModule.forRoot({
	imports: [AuthorizationDependenciesModule],
	vocabulary,
	principalResolver: { useExisting: SessionPrincipalResolver },
	store: {
		useFactory: (database: Database) => new DatabasePolicyStore(database),
		inject: [DATABASE],
	},
});
```

This creates ordinary required DI edges, so Nest waits for asynchronous initialization and owns
missing-export errors and cycle detection. A provider declared only in the module that imports
`PermissionsModule` is not visible in the opposite direction; move it to an imported module and
export it. Missing imports/exports now fail at bootstrap instead of falling back to a container-wide
lookup that could observe a half-initialized singleton.

The nested provider definitions cannot create a static graph when the options themselves come from
`forRootAsync()`. Inject the dependency into the outer options factory and return the ready instance:

```ts
PermissionsModule.forRootAsync({
	imports: [AuthorizationDependenciesModule],
	inject: [SessionPrincipalResolver],
	useFactory: (principalResolver: SessionPrincipalResolver) => ({
		vocabulary,
		principalResolver,
	}),
});
```

Ready instances and `useClass` remain supported in both registration modes. A nested `useExisting`
or `useFactory` with `inject` returned from `forRootAsync()` fails with migration guidance.

## API

### Route decorators

| Decorator                                         | What it does                                                                   |
| ------------------------------------------------- | ------------------------------------------------------------------------------ |
| `@RequirePermission(action, resource?, options?)` | Declares the check. Method or controller; the handler's own declaration wins.  |
| `@RequireAuthenticated()`                         | Requires a resolvable principal, no Cedar decision.                            |
| `@Public()`                                       | No authorization at all — **unless** the handler declares its own requirement. |
| `@EntityProvider({ order? })`                     | Marks a provider class as a contributor to the entity graph.                   |

`ResourceRef`, the second argument:

| Shape                                      | When                                                                                                                                                                                                                                   |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `{ kind: "param", param, type, parseAs? }` | The id is in the URL. `parseAs` is any [Standard Schema](https://standardschema.dev) validator — a Zod branded id schema drops straight in.                                                                                            |
| `{ kind: "literal", type, id }`            | A fixed entity.                                                                                                                                                                                                                        |
| `{ kind: "unspecified", type }`            | A list. Compiles a `QueryPlan` instead of a decision.                                                                                                                                                                                  |
| `{ kind: "resolver", resolve(ctx) }`       | Anything else: a body field, a header, a lookup. Gets the principal and the scope.                                                                                                                                                     |
| _omitted_                                  | Same as `{ kind: "unspecified" }`, with the type inferred from the action's single declared resource type; an action declaring zero or several throws. The guard warns once, because allowing then only means _some_ row is reachable. |

`RoutePermissionOptions`, the third: `scope` (the membership gate — see below), `onDeny`, `context`
(per-route Cedar context), `scopeFrom`.

> [!WARNING]
> Omitting `parseAs` on a `param` reference means the raw URL segment becomes a Cedar entity id. The
> guard warns once per route. Pass the same schema your handler's pipe uses.

### Handler decorators

| Decorator                 | Yields                                                                                                                 |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `@CurrentPrincipal()`     | `ResolvedPrincipal` — the ref and the entity graph the guard resolved.                                                 |
| `@CurrentAuthorization()` | `RequestAuthorization`. Throws `ForbiddenException` when the guard did not decide; `{ optional: true }` yields `null`. |
| `@QueryPlan()`            | The plan a `{ kind: "unspecified" }` route precomputed.                                                                |

`RequestAuthorization` carries `principal`, `scope`, `context`, `entities`, `route`, `resource`,
`result` and `plan`, plus `planFor(action, resourceType, opts?)` and
`can(action, resource, opts?)`. Guard-created instances re-run the registered resource/additional
entity providers for the requested action/resource, then combine those fresh contributions with
the principal graph. Plan-time resolver requests carry the requested `resourceType`. This lets a handler re-check against rows loaded inside its own transaction
instead of reusing the guard's pre-transaction resource snapshot. Both methods accept
`{ scope?, context?, entities? }`; explicit `entities` skip re-resolution. Manually constructed
instances without the optional resolver retain the original `authorization.entities` fallback.

### PermissionsService

A **singleton** — never `Scope.REQUEST`, which would rebuild the injector subtree per request and buy
nothing, since every request-specific value is an argument.

| Member                  | What it does                                            |
| ----------------------- | ------------------------------------------------------- |
| `check(request)`        | One decision, typed against the registered vocabulary.  |
| `checkOrThrow(request)` | The same, throwing `ForbiddenException` on a deny.      |
| `checkMany(requests)`   | Many, sharing one policy-set lookup per scope.          |
| `plan(request)`         | A three-state `QueryPlan` for a resource type.          |
| `stats()`               | Engine counters. Safe after shutdown.                   |
| `reload()`              | Marks every cached scope stale; the next check reloads. |
| `invalidate(scope)`     | Marks **one** scope stale — or every scope with `'*'`.  |

Pass `entities` on every imperative call: resolve the principal graph once and reuse it. That, not
core's cross-request `entityCache`, is how a request making several checks avoids re-resolving.

**After writing a grant, invalidate the scope you wrote:**

```ts
await policyStore.linkTemplate(grant);
await permissions.invalidate(scope); // this tenant only
```

A store that implements `watch` emits that event itself and needs none of this. A store that does
not — a projection of your own tables, a composite over a read-only source, the built-in seeded
memory store — leaves the code that wrote the grant holding the only knowledge that anything
changed. `reload()` is `invalidate('*')` and drops **every** tenant's cache, so using it to publish
one tenant's grant makes every other tenant pay a cold load: a thundering herd against the policy
store, on the write path. Compiled query plans for the scope are dropped outright rather than served
stale, so either form is safe to call there.

## Scope resolution

Every decision happens in a **policy scope** — the tenant key, `''` for global. The guard must know
it _before_ it has a principal, because the principal resolver is told which scope it is being asked
about. The order, first match wins:

1. the route's `scopeFrom`:
   - `{ kind: "literal", scope }`
   - `{ kind: "param", param, prefix? }` → `` `${prefix ?? ""}${params[param]}` `` — station's
     `:organizationId` → `org:<uuid>` is `{ kind: "param", param: "organizationId", prefix: "org:" }`
   - `{ kind: "resolver" }` → explicitly defer to (2)
2. the module's `scopeResolver({ request, params, route, action, contextKind, executionContext })`
3. the resolved principal's `scopeHint` — **only if neither of the above produced one**
4. the global scope, `''`

Step 3 is deliberately last. When the URL names one tenant and the principal claims another,
honouring the principal is a cross-tenant read; an explicitly derived scope always wins, and the
resolver — which was told the requested scope — is the thing that returns `NOT_IN_SCOPE` if the
principal does not belong there.

`{ kind: "param" }` needs route parameters, so it is a configuration error on `ws`/`rpc`.

### When the scope cannot be derived

A missing or empty `scopeFrom` parameter, and **any throw** out of `scopeFrom: { kind: "resolver" }`
or the module-level `scopeResolver`, produce a **400** (`BadRequestException`) — and produce it
**before the principal is resolved**. Rejecting a malformed tenant parameter by throwing is the
natural thing to write; before `denial.onInvalidScope` it was also the thing that escaped the guard
as a 500.

The ordering is a guarantee, not an artefact. A request carrying both a malformed tenant parameter
and an unusable credential is a 400, never a 401 — otherwise a caller could tell "this tenant id is
malformed" from "this tenant id is fine but you are not in it" by watching the status change with
the credential, which is the oracle the [404 path](#denial-strategy-404-vs-403) exists to close.

```ts
denial: {
	onInvalidScope: (error, { source, param, issues }) =>
		new BadRequestException(`"${param ?? "scope"}" is not an organization id.`),
},
```

The hook receives the **raw** throw — only your application knows what its resolver throws — plus
`{ source: "scopeFrom" | "scopeResolver", param, value, issues, request, contextKind, route }`.
Return an `Error` to replace the 400; return nothing to keep it. The default response names the
parameter and never the value or the resolver's own message: a resolver throwing
`organization 8f3e… not found` would otherwise turn a 400 into an existence oracle. The full error
reaches `onInvalidScope`, `hooks.onDenied` and `hooks.onDecision`, none of which is the response.

A `RoutePermissionConfigurationError` is the one throw that stays a 500 — `scopeFrom:
{ kind: "param" }` on a transport with no route parameters is the developer's mistake, and telling
the caller to fix a request that has nothing wrong with it would be worse than useless.

## Denial strategy: 404 vs 403

A 403 on "this tenant's resource" tells the caller the tenant exists. For a multi-tenant API that is
an enumeration oracle. The strategy has four layers, coarse to fine:

1. **`denial.default`** — `"forbidden"` (default) or `"not-found"` for every ordinary denial.
2. **`@RequirePermission(..., { onDeny })`** — overrides it for one route.
3. **The `scope` gate** — `@RequirePermission(action, resource, { scope: { action, resource } })`
   runs a membership check _before_ the action check. Its denial is **always** the not-found response
   and cannot be downgraded by `onDeny`. This is the station semantic: **non-member → 404,
   member-lacking-permission → 403.** The principal resolver's `NOT_IN_SCOPE` return takes the same
   path.
4. **`hooks.onDenied(denial, context)`** — returning an `Error` owns the response entirely. Station
   returns its RFC 9457 exception here.

The not-found body is built from a single frozen constant and **never** echoes a route parameter,
because the property being protected is that two different denials are byte-identical. There is a
test that asserts exactly that, on both adapters.

Denial reasons handed to the hooks: `unauthenticated` (401) · `forbidden` (403) · `not-a-member` /
`not-in-scope` (404) · `plan-denied` (403) · `undeclared-route` (403) · `engine-unavailable` (503) ·
`invalid-resource-param` (400) · `invalid-scope` (400) · `misconfigured` (500).

A typed `PermissionsError` escaping a guard-time engine/store/entity operation is
`engine-unavailable`: it is logged with its machine code, audited through the same denial hook, and
returned as 503. It is never mislabeled as Cedar's 403 decision. Imperative `PermissionsService`
calls continue to surface the original typed error to their caller.

`hooks.onDecision(record)` fires on allow **and** deny; it is never awaited and a throw is swallowed,
because an audit sink must not be able to fail a request.

## Route audit

Enforcement is per-request; coverage is per-boot.

```ts
routeAudit: {
	mode: "error",                              // "off" (default) | "warn" | "error"
	ignoreControllers: [HealthController, /^Internal/, "MetricsController"],
	ignoreRoutes: [/^DebugController\./],
	additionalMetadataKeys: [ROUTE_PERMISSION], // your own decorator, during a migration
}
```

`mode: "error"` throws from `onApplicationBootstrap`, so any pipeline step that boots the app
(including OpenAPI generation) fails on an undeclared route. The report names the endpoint:

```
GET /organizations/:id → OrganizationsController.find
POST /organizations → OrganizationsController.create
```

`findUndeclaredRoutes()` is public, so an application can assert the list in its own test instead of
parsing a log line. `additionalMetadataKeys` is the migration seam: during a cutover both decorator
families count as declared.

## Query plans in handlers

A `{ kind: "unspecified" }` route asks Cedar "which rows of this type may this principal act on" and
leaves the resource unknown. The three-state answer is never collapsed by this package:

```ts
@Get()
@RequirePermission("run:read", { kind: "unspecified", type: "Run" })
async list(@QueryPlan() plan: QueryPlan) {
	if (plan.kind === "ALWAYS_DENY") return [];             // the guard already refused if it must
	if (plan.kind === "ALWAYS_ALLOW") return this.runs.all();
	return this.runs.where(compilePlan(plan, runMapping)); // from a driver package
}
```

The guard refuses the request outright when the plan is `ALWAYS_DENY` — there is no filter that would
return a row, so 403 is more honest than an empty list. `ALWAYS_ALLOW` and `CONDITIONAL` are allowed
and stashed.

`plan.condition` is a neutral AST, never a rendered string, and its values are typed rather than
interpolated — there is deliberately no shape in it that invites string concatenation.
`plan.approximations` is empty for an exact plan, and every entry is a recorded, directional
departure. `plan.postFilter`, when present, **must** be applied to the returned rows.

## Interop

This package never imports an authentication library. `RequestPrincipalResolver` reads one property
off the request, which is what every auth guard in the ecosystem already writes:

```ts
// @nestm/better-auth — BetterAuthGuard sets request.session
new RequestPrincipalResolver<{ user: { id: string; orgId: string } }>({
	property: "session",
	map: (session, { scope }) =>
		scope === `org:${session.user.orgId}`
			? { ref: { type: "Member", id: session.user.id }, entities: [] }
			: NOT_IN_SCOPE,
});

// A plain JWT guard — request.user
new RequestPrincipalResolver<{ sub: string }>({
	property: "user",
	map: (user) => ({ ref: { type: "Member", id: user.sub }, entities: [] }),
});

// station — request.identity
new RequestPrincipalResolver<{ identitySubject: string; organizationId: string }>({
	property: "identity",
	map: (identity, { scope }) =>
		scope === `org:${identity.organizationId}`
			? { ref: { type: "Member", id: identity.identitySubject }, entities: [] }
			: NOT_IN_SCOPE,
});
```

Return `null` for "not authenticated" (401) and `NOT_IN_SCOPE` for "authenticated but not a member of
this scope" (404). That distinction is the whole reason the resolver returns a union.

> [!WARNING]
> **Guard ordering matters.** Two `APP_GUARD` providers execute in registration order, so the module
> that populates `request.session` / `request.user` must be imported **before** `PermissionsModule`.
> Register it later and the principal resolver reads an absent property, and every route is a 401.

For anything the property shape does not cover, implement `PrincipalResolver` yourself — it is one
method.

### Migrating from another guard

An application that already has route authorization has its own decorator and its own guard. Without
help, adopting this package means dual-decorating **every** route — including every `@Public()` — in
one commit, because `PermissionsGuard` denies anything it does not recognise.

`interop` makes it a route-at-a-time cutover. Register **both** guards, legacy first:

```ts
@Module({
	imports: [
		PermissionsModule.forRoot({
			vocabulary,
			principalResolver: new RequestPrincipalResolver({ property: "user", map }),
			interop: {
				// Foreign @Public()-equivalents → ALLOW, exactly like our own @Public().
				publicKeys: [IS_PUBLIC_KEY],
				// Foreign permission decorators → ABSTAIN. The legacy guard decides.
				declaredKeys: [ROLES_KEY, PERMISSIONS_KEY],
			},
			// The same keys also satisfy the boot-time coverage check.
			routeAudit: { mode: "warn", additionalMetadataKeys: [ROLES_KEY, PERMISSIONS_KEY] },
		}),
	],
	// Registration order is execution order. The legacy guard runs first and keeps
	// enforcing every route it declares.
	providers: [{ provide: APP_GUARD, useClass: LegacyRolesGuard }],
})
export class AppModule {}
```

The two lists mean genuinely different things, and the difference is the design:

| List           | Foreign decorator      | `PermissionsGuard` does                                                       |
| -------------- | ---------------------- | ----------------------------------------------------------------------------- |
| `publicKeys`   | `@Public()`-equivalent | **Allows.** The route was already unauthenticated under the legacy guard.     |
| `declaredKeys` | a permission decorator | **Abstains** — returns `true` without deciding, and the legacy guard answers. |

When several public keys are configured, metadata level takes precedence over key order: any
handler-level public marker wins first; otherwise a handler-level
`@RequirePermission()`/`@RequireAuthenticated()` overrides inherited public markers; otherwise an
inherited public marker allows the route.

**Abstaining is not allowing.** A `CanActivate` returning `true` is not a grant; it is this guard
declining to be the one that answers. On an abstained route it resolves no principal, checks
nothing, and stashes no `RequestAuthorization` — so `@AuthorizedPrincipal()` on an unmigrated route
cannot silently produce a principal nobody resolved. Denying instead would 403 every unmigrated
endpoint the moment this guard is registered; allowing would be a hole. Abstaining leaves each route
exactly as protected as it was.

Then migrate one route at a time. A route that gains `@RequirePermission()`/`@RequireAuthenticated()`
is decided **here** — an own declaration is read before the foreign keys are consulted — so the two
decorators can coexist on it while you verify, and the legacy one comes off afterwards. A route with
**no** key from either family is still undeclared and still follows `denial.onUndeclaredRoute`. The
cutover is complete when `interop` can be deleted and nothing changes.

## Limitations

- **Transports.** `http` and `graphql` are fully supported. `ws` and `rpc` get the correct exception
  types (`WsException`, a plain `Error`), but they have no route parameters, so `{ kind: "param" }`
  references and `scopeFrom: { kind: "param" }` are configuration errors there. Use `literal` or
  `resolver`.
- **Guards run before pipes.** That is why `parseAs` exists. A route parameter reaching the guard has
  been validated by nothing; without `parseAs` its raw text becomes a Cedar entity id.
- **A query plan breaks database-side pagination when it carries a `postFilter`.** The post-filter
  re-checks each returned row, so `LIMIT`/`OFFSET` applied before it returns the wrong page. Core's
  default (`unsupportedResidual: 'error'`) refuses to produce such a plan at all; enabling
  `'post-filter'` is a migration aid, not a steady state.
- **Neither the guard nor `PermissionsService` is request-scoped**, by design: a request-scoped
  provider rebuilds the injector subtree per request. Anything per-request travels as an argument, or
  on `RequestAuthorization`.
- **`@EntityProvider()` classes must be singletons.** The registry holds the instance for the life of
  the application.
- **One engine per module registration.** Two registrations must not share an explicit
  `engine.instanceId`; they would overwrite each other's preparsed policy sets.

## Example

[`examples/station-fastify`](../../examples/station-fastify) — a runnable Fastify app with a seeded
policy store, a template-link grant, a fake auth layer, and the three route shapes (literal, param
with a hand-written Standard Schema validator, and a plan-filtered list).

## License

BSD-3-Clause © nestm. See [LICENSE](./LICENSE).

Design: [`docs/design/nestjs-module.md`](../../docs/design/nestjs-module.md), with live-verified
corrections in [`docs/design/errata.md`](../../docs/design/errata.md).
