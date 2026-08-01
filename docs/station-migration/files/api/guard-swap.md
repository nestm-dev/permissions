# S7 — the guard swap

Every route in `apps/api` today, with the exact decorator that replaces its
current one. Enumerated from the working tree, not from the design: there are
**15** routes across 6 controllers, not the 15-ish the design assumed, and three
of them differ from what the design's mapping table expects. Differences are
called out inline.

Two facts that shape the whole phase:

- **Routes migrate ONE AT A TIME, and they are never double-decorated.** The
  `interop` module option is the seam. Both guards are registered, legacy first;
  every route still carrying only station's `@RequirePermission()` is one the
  library's guard **abstains** on, and station's `PermissionGuard` keeps
  enforcing it exactly as it does today. A route migrates by *replacing* its
  station decorator with the library's — a one-line diff, one route, one commit
  if you like — at which point the library's guard decides it and station's
  guard no longer sees a declaration for it.

  ```ts
  // authorization-engine.module.ts
  interop: {
    publicKeys: [IS_PUBLIC_ROUTE],     // station's @Public()  -> ALLOW
    declaredKeys: [ROUTE_PERMISSION],  // station's @RequirePermission() -> ABSTAIN
  },
  ```

  The two lists do different things and the difference is the whole design:

  | list | key | what `PermissionsGuard` does |
  |---|---|---|
  | `publicKeys` | `IS_PUBLIC_ROUTE` | **Allows**, exactly as for its own `@Public()`. Safe: the route was already unauthenticated under the legacy guard, so nothing is weakened. |
  | `declaredKeys` | `ROUTE_PERMISSION` | **Abstains** — returns `true` without resolving a principal, without checking anything, without stashing `RequestAuthorization`. The legacy guard decides. |

  Abstaining is not allowing. A `CanActivate` returning `true` is not a grant; it
  is this guard declining to be the one that answers, and the route stays exactly
  as protected as it was because the guard that owns that key is still in the
  chain. Denying instead would 403 every unmigrated endpoint the instant
  `PermissionsGuard` is registered; allowing instead would be a hole for the
  whole cutover.

  A route carrying a key from **neither** family is still undeclared and still
  follows `denial.onUndeclaredRoute: 'deny'`.

- **The decorator names collide.** `@nestm/permissions` exports
  `RequirePermission`, `RequireAuthenticated` and `Public`; station has all
  three. Alias at the import site — the alias is what makes S10 a rename rather
  than an untangling:

  ```ts
  import {
    Public as CedarPublic,
    RequireAuthenticated as CedarAuthenticated,
    RequirePermission as CedarPermission,
  } from '@nestm/permissions'
  ```

### What "Replace with" means in the tables below

It is a replacement, not an addition. Per route, the diff is:

```diff
-  @RequirePermission('member:read')
+  @CedarPermission('member:read', { kind: 'param', param: 'organizationId', type: 'Organization', parseAs: P })
```

Station's decorator comes **off** in the same edit. Leaving both on is not
harmful — an own declaration is read first, so the library's guard would simply
decide the route — but it is misleading: the route reads as though two engines
gate it when only one does, and S10's deletion of `require-permission.decorator.ts`
would then be a 15-route change instead of a no-op.

`STATION_AUTHZ_ENGINE` still exists and still selects `legacy` / `shadow` /
`cedar`, but it is no longer what decides *which guard is authoritative for a
given route* — the decorator on the route is. The flag stays the rollback for
shadow mode and for the S8 query-plan call sites.

**Rollback of a single route** is therefore the inverse one-line diff: put
station's decorator back, take the library's off, and the legacy guard resumes
enforcing it. No deploy-wide flag flip needed to un-migrate one endpoint, which
is what makes "one route family at a time" a real unit of work rather than a
description of the commit order.

---

## The mapping, route by route

`P` = `organizationIdSchema` from `@station/contracts` (Zod 4 implements
Standard Schema natively, so it drops straight into `parseAs`).

The scope for every `/organizations/:organizationId/...` route comes from the
module-level `scopeResolver` in `authorization-engine.module.ts`, which is the
direct translation of `permission.guard.ts:115-127` — including the pointer and
detail strings, so the 400 body for a malformed id is byte-identical. Routes may
still pin it explicitly with
`{ scopeFrom: { kind: 'param', param: 'organizationId', prefix: 'org:' } }`;
that is shown once below and omitted elsewhere for readability.

### TenancyController — `apps/api/src/tenancy/tenancy.controller.ts`

| Route | Today | Replace with |
|---|---|---|
| `GET /organizations` | `@RequirePermission('organization:read', { kind: 'membership' })` | `@CedarAuthenticated()` |
| `POST /organizations` | `@RequirePermission('organization:create', { kind: 'instance' })` | `@CedarPermission('organization:create', { kind: 'literal', type: 'Instance', id: 'station' }, { scopeFrom: { kind: 'literal', scope: 'instance' } })` |
| `GET /organizations/:organizationId/projects` | `@RequirePermission('project:read', { kind: 'any' })` | `@CedarPermission('project:read', { kind: 'unspecified', type: 'Project' }, { scopeFrom: { kind: 'param', param: 'organizationId', prefix: 'org:' } })` |
| `POST /organizations/:organizationId/projects` | `@RequirePermission('project:manage')` | `@CedarPermission('project:manage', { kind: 'param', param: 'organizationId', type: 'Organization', parseAs: P })` |
| `GET /organizations/:organizationId/invitations` | `@RequirePermission('member:read')` | `@CedarPermission('member:read', { kind: 'param', param: 'organizationId', type: 'Organization', parseAs: P })` |
| `GET /organizations/:organizationId/members` | `@RequirePermission('member:read')` | `@CedarPermission('member:read', { kind: 'param', param: 'organizationId', type: 'Organization', parseAs: P })` |

**`GET /organizations` — a deliberate downgrade, not a mistake.** Station's
`{ kind: 'membership' }` scope makes the guard authenticate only; the real
`organization:read` filter is `tenancy.service.ts:53-77`, one
`resolveMemberAuthorization` per candidate Organization. The design maps it to
`{ kind: 'unspecified', type: 'Organization' }`, which cannot work: a query plan
is compiled *within one scope*, and this route's whole job is to span scopes the
caller has not named. `@CedarAuthenticated()` is the honest declaration, and the
filter stays where it already is — becoming one batched `checkMany` at S8. The
cost is that the route no longer *declares* `organization:read`; the blackbox
case `'filters the Organization list by organization:read'` is what holds that
line, and VERIFICATION.md lists it as a must-pass.

**`POST /organizations` — cut over LAST.** It is the only instance-scope route,
its principal is an `Identity` rather than a `Member`, and its policy lives in
the in-memory store rather than the database. Nothing else shares that path.

### RolesController — `apps/api/src/roles/roles.controller.ts`

| Route | Today | Replace with |
|---|---|---|
| `GET /organizations/:organizationId/roles` | `@RequirePermission(ROLE_READ_PERMISSION)` (`'role:read'`) | `@CedarPermission('role:read', { kind: 'param', param: 'organizationId', type: 'Organization', parseAs: P })` |
| `GET /organizations/:organizationId/role-grants` | `@RequirePermission(ROLE_GRANT_READ_PERMISSION)` | `@CedarPermission('member:read', { kind: 'param', param: 'organizationId', type: 'Organization', parseAs: P })` |
| `POST /organizations/:organizationId/role-grants` | `@RequirePermission(ROLE_GRANT_MANAGE_PERMISSION)` | `@CedarPermission('member:manage', { kind: 'param', param: 'organizationId', type: 'Organization', parseAs: P })` |
| `DELETE /organizations/:organizationId/role-grants/:roleGrantId` | `@RequirePermission(ROLE_GRANT_MANAGE_PERMISSION)` | `@CedarPermission('member:manage', { kind: 'param', param: 'organizationId', type: 'Organization', parseAs: P })` |

`ROLE_GRANT_READ_PERMISSION` is **`'member:read'`**, not `'role:read'`
(`apps/api/src/roles/roles.constants.ts:10`) — deliberate, and the constant's
name reads like drift. Keep using the constants rather than literals so the two
decorators cannot disagree.

`:roleGrantId` stays unvalidated by the guard, exactly as today: the resource is
the Organization, and `RoleGrantParamsDto` validates the id in the pipe. Adding
it as a second `parseAs` would move a 400 earlier and change which of two
validation errors a request with two bad ids reports first.

### MeController — `apps/api/src/authorization/me.controller.ts`

| Route | Today | Replace with |
|---|---|---|
| `GET /me` | `@RequireAuthenticated()` | `@CedarAuthenticated()` |
| `GET /organizations/:organizationId/me` | `@RequireAuthenticated()` | `@CedarAuthenticated()` |

`GET /organizations/:organizationId/me` gets its 404 for free: the module
`scopeResolver` produces `org:<id>`, `StationPrincipalResolver` finds no
`members` row and returns `NOT_IN_SCOPE`, and `hooks.onDenied` maps that to
`NotFoundException`. The handler's own `if (!authorization) throw new
NotFoundException()` (`me.controller.ts:122-124`) becomes unreachable —
**leave it in place through S10**. Two identical 404s cost nothing, and removing
it in the same change that introduces the new one removes the fallback at the
exact moment it is most needed.

### AuditTrailController — `apps/api/src/audit-trail/audit-trail.controller.ts`

| Route | Today | Replace with |
|---|---|---|
| `GET /organizations/:organizationId/audit-entries` | `@RequirePermission(AUDIT_READ_PERMISSION)` (`'audit:read'`) | `@CedarPermission('audit:read', { kind: 'param', param: 'organizationId', type: 'Organization', parseAs: P })` |

### HealthController and MetricsController

| Route | Today | Replace with |
|---|---|---|
| `GET /health` | class-level `@Public()` | nothing — `interop.publicKeys` covers it |
| `GET /metrics` | class-level `@Public()` | nothing — `interop.publicKeys` covers it |

**This used to be the easiest route family to forget and the only one that
failed closed into an outage.** `@Public()` from `../auth/public.decorator.js`
writes `IS_PUBLIC_ROUTE`; before `interop` existed the library's guard did not
read it, so registering `PermissionsGuard` without dual-decorating these two
first made `/health` answer 403 and failed every liveness probe in the
deployment.

`interop.publicKeys: [IS_PUBLIC_ROUTE]` removes the trap at the root: the guard
allows on station's key, on the same terms as its own `@Public()` — including
the handler-level override, so a class-level public marker still does not defeat
a handler that declares `@CedarPermission()`. **These two controllers need no
edit at all**, at S7 or later, and `/health` cannot regress into an outage
between the guard registration and a forgotten decorator, because there is no
window in which one has landed and the other has not.

Still run `curl -sf localhost:3001/health` immediately after the commit that
registers the guard. The trap is closed, but the cost of the assumption being
wrong is the same as it always was.

At S10, when station's `@Public()` is deleted in favour of the library's, these
two controllers get `@CedarPublic()` and `interop.publicKeys` goes away with it
— one commit, and by then the guard has been authoritative for every other route
for some time.

### Outside the guard chain entirely — no change

- `/docs`, `/docs-json` — bound on the HTTP adapter by
  `SwaggerModule.setup` (`apps/api/src/openapi.ts:133-137`), so no `APP_GUARD`
  and no route audit sees them.
- `/api/auth/*` — the Better Auth mount, registered with
  `disableGlobalGuard: true` (`apps/api/src/auth/identity.module.ts:44`). Its
  only gate is `stationAuthRoutePolicy` plus the `organizationHooks` below.
  ADR-0014 keeps it outside the RFC 9457 envelope on purpose.
- `StandardSchemaTestController`
  (`apps/api/src/http/standard-schema.controller.test.ts:36`) — declares no
  authorization at all and never boots under `AppModule`, so neither audit sees
  it. If a future test boots it inside a module that imports
  `PermissionsModule`, add
  `routeAudit.ignoreControllers: [/StandardSchemaTestController/]`.

---

## `hooks.onDenied` — ADR-0014, preserved byte-for-byte

The implementation is `toStationException` at the bottom of
`authorization-engine.module.ts`. Three things make the preservation exact
rather than approximate:

1. **The 404 is not a Cedar denial.** It is `NOT_IN_SCOPE` from the principal
   resolver — "this authenticated identity has no `members` row here" — which is
   the same statement `permission.guard.ts:137-139` makes today. Cedar is never
   asked. No 26th action, no new policy.
2. **The body is constant regardless of the exception's message.**
   `apps/api/src/http/problem-details.ts:131-144` returns `shape.detail` for
   every status except 409, so an unknown Organization, a non-Member probe and
   an unmatched route are byte-identical whatever any call site passes. The hook
   returns a bare `new NotFoundException()` anyway.
3. **`not-a-member` and `not-in-scope` share one branch.** They arrive from
   different places and an audit sink wants to tell them apart, but a response
   that could distinguish them is the existence oracle ADR-0014 exists to
   prevent.

| `PermissionsDenial.reason` | Response | Matches |
|---|---|---|
| `unauthenticated` | `UnauthorizedException` → 401 | `permission.guard.ts:85` |
| `not-in-scope` | `NotFoundException` → 404, constant detail | `permission.guard.ts:137-139` |
| `not-a-member` | `NotFoundException` → 404, constant detail | same body, different origin |
| `invalid-resource-param` | `ValidationException([{ pointer, detail }])` → 400 | `permission.guard.ts:120-127`, `165-177` |
| `invalid-scope` | *not owned here* — see below | `permission.guard.ts:116-127` |
| `forbidden` | `ForbiddenException` → 403 | `permission.guard.ts:142` |
| `plan-denied` | `ForbiddenException` → 403 | `hasAnyPermission === false` today |
| `undeclared-route` | `ForbiddenException` → 403 | `permission.guard.ts:77-79` |
| `engine-unavailable` | `ServiceUnavailableException` → 503 | new; never fails open |
| `misconfigured` | `InternalServerErrorException` → 500 | new; 500 carries no detail |

### The malformed-`:organizationId` 400 — `denial.onInvalidScope`

`invalid-scope` is the one arm `toStationException` deliberately does **not**
own, and the reason is hook ordering: `hooks.onDenied` runs first, and returning
an `Error` from it fully replaces the mapping — so owning `invalid-scope` there
would mean `denial.onInvalidScope` never runs. `toStationException` returns
`undefined` for it (its return type is `Error | undefined`), and the dedicated
hook builds the 400:

```ts
denial: {
  onInvalidScope: (_error, { param }) =>
    new ValidationException([
      { pointer: param ?? 'organizationId',
        detail: 'Expected a UUID Organization identifier.' },
    ]),
}
```

Three properties of this path, all contract rather than default:

1. **It is a 400, raised BEFORE the principal is resolved.** Scope resolution
   runs first by design — the principal resolver is told which scope it is being
   asked about — so a request with both a malformed tenant id and an unusable
   credential is a 400 and not a 401. The alternative would let a caller
   distinguish "this tenant id is malformed" from "this tenant id is fine but you
   are not in it" by watching the status change with the credential, which is
   exactly the existence oracle ADR-0014's 404 path exists to close.
2. **The response never echoes the value.** `InvalidScopeContext` carries
   `value`, and it is deliberately not read: the pointer names the parameter and
   the detail is a constant string. Echoing an unvalidated path segment into a
   response body is reflected output, and station's problem-details shape has no
   field for it anyway.
3. **Any throw out of `scopeResolver` lands here** — a Zod error, an
   `HttpException`, a bare string. Nothing escapes the guard as a 500. This is
   what makes throwing the `ValidationException` from inside `scopeResolver` a
   supported path rather than a hope; before this hook existed, an unrecognised
   throw escaped as a 500 and the staged module carried a `VERIFY` about it.

`denial.onInvalidParam` covers the *resource*-parameter 400 one layer later
(`{ kind: 'param', parseAs }` on the route), so a bad `organizationId` produces
station's pointer whichever of the two paths reaches it first, with the same
body.

---

## The two audits, and how they pair with `interop`

```ts
interop: {
  publicKeys: [IS_PUBLIC_ROUTE],
  declaredKeys: [ROUTE_PERMISSION],
},
routeAudit: {
  mode: 'error',
  additionalMetadataKeys: [ROUTE_PERMISSION, IS_PUBLIC_ROUTE],
},
```

`ROUTE_PERMISSION` is the string `'ROUTE_PERMISSION'`
(`apps/api/src/authorization/require-permission.decorator.ts:7`);
`IS_PUBLIC_ROUTE` comes from `apps/api/src/auth/public.decorator.ts`.

**The two options answer different questions about the same key, and both must
list it:**

| | `interop` | `routeAudit.additionalMetadataKeys` |
|---|---|---|
| Question | what does the **guard** do at request time? | does the **boot audit** consider this route declared? |
| `ROUTE_PERMISSION` | abstain — the legacy guard decides | yes, counted |
| `IS_PUBLIC_ROUTE` | allow | yes, counted |

Drift between them is the failure to look for, and it is asymmetric:

- a key in `interop` but **not** in `additionalMetadataKeys` → the application
  refuses to boot on a route the guard would happily have abstained on. Loud,
  caught by `pnpm contracts:generate`, harmless.
- a key in `additionalMetadataKeys` but **not** in `interop` → the audit passes
  and the guard then denies (`onUndeclaredRoute: 'deny'`) or, for a public
  marker, 403s a liveness probe. This is the direction that reaches production,
  so keep the two lists edited in the same diff.

Station's `RouteAuthorizationAudit` keeps running unchanged and keeps refusing to
boot on an undeclared route. Both audits are exercised by
`pnpm contracts:generate`, which boots the application — that is the CI tripwire
for this whole phase, and it must keep passing at every commit.

As routes migrate, `ROUTE_PERMISSION` stops appearing on them one at a time.
Neither list needs editing during the cutover: a key that no route carries any
more is inert in both.

At S10: delete `route-authorization.audit.ts`, drop **both** `interop` and
`additionalMetadataKeys` in the same commit that deletes
`require-permission.decorator.ts` and station's `public.decorator.ts`, and
rewrite `route-authorization.audit.test.ts` against `RouteAuthorizationAudit`
from `@nestm/permissions`. Dropping `interop` while a single route still carries
`ROUTE_PERMISSION` turns that route from "enforced by the legacy guard" into
"undeclared, therefore 403" — so the grep in VERIFICATION.md's S10 gate is what
licenses the deletion, not the calendar.

---

## S9 — Better Auth `organizationHooks`

The non-guard authorization path (ADR-0016). Better Auth's mount is outside
Nest's guards entirely, so `canManageInvitations` is the **only** thing gating
`POST /api/auth/organization/invite-member` and `.../cancel-invitation`.

It lives at `apps/api/src/auth/identity.module.ts:67-98` — **not** at
`apps/api/src/auth/auth.module.ts:54-85` as the design says; that file was
deleted and split into `identity.module.ts` + `better-auth.factory.ts` in the
working tree. The hooks themselves are at
`apps/api/src/auth/better-auth.factory.ts:107-173`, and `requireInvitationAuthority`
(`:67-82`) throws `APIError('FORBIDDEN', …)` — Better Auth's own error contract,
which ADR-0014 deliberately leaves outside the RFC 9457 envelope. None of that
changes.

Only the predicate changes:

```diff
 invitationAuthority: {
   canManageInvitations: async (organizationId, identitySubject) => {
     const parsedOrganizationId = organizationIdSchema.safeParse(organizationId)
     const parsedIdentitySubject = identitySubjectSchema.safeParse(identitySubject)

     if (!parsedOrganizationId.success || !parsedIdentitySubject.success) {
       return false
     }

     const authorization =
       await authorizationService.resolveMemberAuthorization(
         parsedOrganizationId.data,
         parsedIdentitySubject.data,
       )

-    return (
-      authorization !== undefined &&
-      hasOrganizationPermission(authorization, INVITATION_MANAGE_PERMISSION)
-    )
+    // Non-membership is still `false`, never a Cedar question — the same
+    // separation the guard makes, and what keeps a non-Member's response
+    // indistinguishable from an unknown Organization's.
+    if (!authorization) {
+      return false
+    }
+
+    const { allowed } = await permissionsService.check({
+      scope: organizationScope(parsedOrganizationId.data),
+      principal: { type: 'Member', id: authorization.memberId },
+      action: INVITATION_MANAGE_PERMISSION,
+      resource: {
+        type: 'Organization',
+        id: parsedOrganizationId.data,
+      },
+      entities: [
+        ...memberGraph({
+          id: authorization.memberId,
+          organizationId: parsedOrganizationId.data,
+          identitySubject: parsedIdentitySubject.data,
+        }),
+      ],
+    })
+
+    return allowed
   },
 },
```

`identity.module.ts`'s `useFactory` gains `PermissionsService` in its `inject`
list. During shadow mode keep the legacy expression and compare the two —
`ShadowAuthorizationService.compare` takes exactly these inputs:

```ts
const legacyAllowed = hasOrganizationPermission(
  authorization,
  INVITATION_MANAGE_PERMISSION,
)

await shadow.compare({
  route: 'BetterAuth.canManageInvitations',
  action: INVITATION_MANAGE_PERMISSION,
  scopeKind: 'organization',
  organizationId: parsedOrganizationId.data,
  principalId: authorization.memberId,
  resourceType: 'Organization',
  resourceId: parsedOrganizationId.data,
  entities: graph,
  legacyAllowed,
})

return legacyAllowed
```

Covered end to end by `apps/api/src/auth/invitations.blackbox.test.ts`, which
must keep passing unchanged.

---

## S10 — what gets deleted, and what does not

**Delete:**

- `apps/api/src/authorization/permission.guard.ts` and its 406-line
  `permission.guard.test.ts` (rewritten, not ported — it tests legacy-guard
  internals that no longer exist);
- `apps/api/src/authorization/require-permission.decorator.ts`
  (`ROUTE_PERMISSION`, `MemberPermissionScope`, `RoutePermission`,
  `RequireAuthenticated`);
- `apps/api/src/authorization/route-authorization.audit.ts` + its test, replaced
  by the library's;
- `apps/api/src/authorization/current-authorization.decorator.ts`, replaced by
  `@CurrentPrincipal()` / `@CurrentAuthorization()` / `@QueryPlan()`;
- `buildMemberAuthorization`, `hasOrganizationPermission`,
  `hasProjectPermission`, `hasAnyPermission`, `permissionReach` and their types
  from `packages/platform/src/authorization.ts`, plus
  `packages/platform/src/authorization.test.ts`;
- `memberAuthorization` from `apps/api/src/auth/authenticated-request.ts`;
- `ShadowAuthorizationService` and the `STATION_AUTHZ_ENGINE` branch;
- the `interop` block and `routeAudit.additionalMetadataKeys` in
  `authorization-engine.module.ts` — both in the same commit as the decorators
  whose keys they name, and only once the S10 grep confirms no route carries
  either key.

**Keep, unchanged:**

- `roles`, `role_permissions`, `role_grants` and every row in them;
- the whole `Role` / `RoleGrant` / `Permission` OpenAPI contract and the
  generated `@station/api-client` — `git diff --exit-code` on both is a gate at
  every phase;
- `AuthorizationService.resolveMemberAuthorization` (the principal resolver
  needs it, and `GET /organizations/:organizationId/me` reports from it);
- `OperatorsService` and the `operators` table (ADR-0015 is untouched);
- the advisory-lock last-administrator protection;
- ADR-0004. Permissions are still the unit of authorization; Cedar is how they
  are evaluated, which is what ADR-0020 records.

Finally, in one commit: give `HealthController` and `MetricsController`
`@CedarPublic()` (the only two routes that never needed an edit during the
cutover, because `interop.publicKeys` carried them), delete
`apps/api/src/auth/public.decorator.ts`, drop `interop` and
`additionalMetadataKeys`, and rename the aliases back —
`CedarPermission` → `RequirePermission`, `CedarAuthenticated` →
`RequireAuthenticated`, `CedarPublic` → `Public` — now that the station-owned
names are gone.

Order within that commit does not matter (it is one atomic change), but the
commit itself must come **after** the grep gate: `interop` going away while any
route still carries `ROUTE_PERMISSION` or `IS_PUBLIC_ROUTE` converts that route
to undeclared, which is a 403 on a route that was working.
