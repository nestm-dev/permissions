# Verification — per-phase gates

Companion to `RUNBOOK.md`. Every gate here is either a command with an exit code
or a named test; nothing is "eyeball it".

Three standing rules for the whole migration:

- **The contract never moves.** `pnpm contracts:generate` followed by
  `git diff --exit-code packages/api-client openapi.json` runs at every phase.
  The `Role`, `RoleGrant`, `Permission` and `ProblemDetails` schemas, and the
  generated client, are byte-identical from S1 to S10. A diff means something
  changed that was not supposed to.
- **`pnpm contracts:generate` boots the application.** It is therefore the
  boot-time route audit's CI job, for both audits, at every commit.
- **`validateRequests` is ON, from S5 to forever.** See the invariant below.
  This one is not a gate at a phase; it is a property that must hold at every
  commit from the moment the engine module lands.

---

## HARD INVARIANT — `engine.validateRequests: true`

Station writes **one Cedar template per Role**, naming every action that Role
grants even though those actions declare different resource types:

```cedar
permit(principal == ?principal,
       action in [Station::Action::"project:manage",
                  Station::Action::"run:read", …],
       resource in ?resource);
```

That shape is safe — Cedar accepts it, and links to it evaluate correctly
through the entity hierarchy — **because `validateRequests` is on**. It is the
only thing that stops a schema-invalid action/resource pairing being *allowed*.

Verified against `cedar-wasm@4.12.0`, pinned by
`packages/permissions-core/tests/integration/multi-resource-template.test.ts`
(`describe('validateRequests is the only guard against a mistyped
action/resource pair')`):

| `validateRequests` | `check({ action: 'project:manage', resource: Run::"r1" })` under an org-wide link |
|---|---|
| `false` | **allow** — the permissive scope matches and Cedar never consults the schema |
| `true` (default) | throws ``resource type `Station::Run` is not valid for `Station::Action::"project:manage"` `` |

**What turning it off actually does:** it converts every one-template-per-role
grant from "25 actions, each on its own declared resource type" into "25 actions
on **any** resource type in the Organization". An org-wide link silently widens
every action to every resource type in that org. There is no error, no log line
and no failing test — the decisions simply become more permissive, uniformly,
for every tenant at once.

That is a boot-time flag guarding a data-shape assumption, so assert it as such:

```ts
// apps/api/src/authorization/authorization-engine.test.ts
it('keeps validateRequests on — the one-template-per-role shape depends on it', () => {
  expect(moduleOptions.engine?.validateRequests).not.toBe(false)
})
```

Assert `not.toBe(false)` rather than `toBe(true)`: the library's default is
`true`, so an omitted key is correct and a test demanding the literal would fail
on a perfectly safe config and teach the next person to weaken it.

Two related constraints, from the same upstream verification, both of which the
projection must keep satisfying:

- **role templates carry no resource-attribute `when` condition.** The condition
  is typechecked against the *union* of every named action's declared resource
  type, so `when { resource.status == "queued" }` over a template naming both
  `Project` and `Run` actions is a `validationError`. The projection unit test
  (below) pins `conditions: []`, and that assertion is now load-bearing.
- **a link whose `?resource` makes every named action unreachable is rejected**,
  against the *link's* id — so the backfill's per-link error path must print the
  `role_grants.id` it came from.

---

## The suites that must pass unchanged

"Unchanged" means the assertions are not edited. Fixture and arrange blocks may
gain a line where a step explicitly says so; nothing below needs one.

### `apps/api/src/authorization/authorization.blackbox.test.ts` — all 9 cases

| Case | Why it is the gate |
|---|---|
| `denies a grant-less Member and keeps non-Members indistinguishable from missing Organizations` | ADR-0014. Proves `NOT_IN_SCOPE` → constant-detail 404, byte-identical to an unknown Organization. |
| `confines a project-scoped grant to its Project while an org-wide grant reaches all` | The reach semantics `permissionReach` encodes, now `planToSql`. |
| `filters the Organization list by organization:read` | The only thing holding `GET /organizations`' filter after the route drops to `@RequireAuthenticated()`. |
| `gates the grant management surface and never accepts project-scoped reach for org targets` | A project-scoped grant must not satisfy an Organization-resource action. Under Cedar this holds because `Organization::"o" in Project::"p"` is false — the direction Cedar's `in` does **not** go. |
| `refuses to revoke the last org-wide grant able to manage grants` | The advisory lock survived S4's diff. |
| `lists Members to member:read holders only` | Plain org-scoped `check`. |
| `grants and revokes a Role through the API and access follows` | The projection is written **and** deleted in the grant's own transaction, and the invalidation is observable within the request that follows. |
| `confines a project-scoped custom-Role grant created through the API` | The Role is inserted with raw SQL at `:136-165`, bypassing `createDefaultRoleBundles`. It passes **only** because `createRoleGrant` upserts the template (drift D-12). If this fails after S4, the self-healing upsert is missing. |
| `rejects invalid payloads and answers 404 for unknown or cross-Organization targets` | Guard-before-pipes validation and the cross-tenant 404. |

### Also unchanged

- `apps/api/src/tenancy/tenancy.blackbox.test.ts`
- `apps/api/src/tenancy/administration.blackbox.test.ts`
- `apps/api/src/audit-trail/audit-trail.blackbox.test.ts`
- `apps/api/src/auth/invitations.blackbox.test.ts` (S9's gate)
- `apps/api/src/dependency-injection.test.ts` — will need the new providers
  added, which is a legitimate edit; it is a container-shape assertion, not a
  behaviour one
- `packages/database/src/database.integration.test.ts`

### Expected to be rewritten, not ported

- `apps/api/src/authorization/permission.guard.test.ts` — 406 lines of
  legacy-guard internals. Delete at S10.
- `apps/api/src/authorization/route-authorization.audit.test.ts` — rewrite
  against `RouteAuthorizationAudit` from `@nestm/permissions`.
- `packages/platform/src/authorization.test.ts` — delete with the five
  evaluation functions.

---

## New tests to add

### 1. The transitive-`in` reach test (S2 → asserted at S7)

The one behaviour this migration deliberately changes. Cedar's `in` is transitive
and reflexive, so a project-scoped grant reaches entities *under* the Project;
station's literal `:projectId` match cannot. It must be accepted with a test, not
observed as an absence of failures.

Today **nothing below a Project is routable** — no `runs`, `boards`, `gates` or
`artifacts` tables, and no route guards one. So the assertion has to be made at
the engine, not over HTTP:

```ts
// apps/api/src/authorization/transitive-reach.blackbox.test.ts
it('a project-scoped grant reaches entities under its Project', async () => {
  // A Member with `run:dispatch` granted at { type: 'project', projectId: alpha }
  const { allowed } = await permissions.check({
    scope: organizationScope(organizationId),
    principal: { type: 'Member', id: memberId },
    action: 'run:dispatch',
    resource: { type: 'Run', id: runId },
    entities: [
      ...memberGraph({ id: memberId, organizationId, identitySubject }),
      // Run -> Project -> Organization. The chain is what makes the grant reach.
      entity(stationVocabulary, 'Run', runId, { attrs: {}, parents: [{ type: 'Project', id: alphaProjectId }] }),
      ...projectGraph({ id: alphaProjectId, organizationId }),
    ],
  })

  expect(allowed).toBe(true)
})

it('does not reach a Run under a different Project', async () => {
  // same grant, `betaProjectId` in the Run's parents → deny
})

it('does not reach upward: a project-scoped grant cannot act on the Organization', async () => {
  // `member:manage` on Station::Organization with a project-scoped grant → deny.
  // This is the direction `in` does NOT go, and it is what the blackbox case
  // 'never accepts project-scoped reach for org targets' asserts over HTTP.
})
```

The third case matters as much as the first: the widening is downward only, and
a reader who accepts "transitive reach" without seeing the upward denial has
accepted something broader than what shipped.

Add a fourth once any sub-Project route exists, over HTTP, and delete this note
then.

### 2. Projection unit test (S4)

`packages/database/src/authorization-projection.test.ts` — pins the Cedar
template JSON shape (source in `files/database/projection-writes.md`). Pure, no
database. It is what catches a change to `roleTemplateCedarJson` that the two
`.mjs` scripts' SQL did not follow.

**`conditions: []` in that assertion is load-bearing, not incidental.** A
multi-resource-type role template must carry **no** resource-attribute `when`
condition: the condition is typechecked against the *union* of every named
action's declared resource type, so `when { resource.status == "queued" }` over a
template naming both `Project` and `Run` actions is a `validationError`
(``attribute `status` on entity type `Station::Project` not found``). A Role that
genuinely needs a resource condition needs its own, narrower template — not a
condition added to the shared one. Anyone adding a condition to
`roleTemplateCedarJson` will break this test first, which is where the
explanation should be:

```ts
it('emits no resource condition — see VERIFICATION.md, constraint (a)', () => {
  expect(roleTemplateCedarJson('r1', 'admin', ['run:read']).conditions).toEqual([])
})
```

### 3. Projection integration cases (S4)

In `packages/database/src/database.integration.test.ts`, against real PostgreSQL
under `station_app`:

- creating a grant writes exactly one link, keyed by the grant's own id;
- revoking removes the link and leaves the template;
- deleting the `role_grants` row directly removes the link **by cascade** — the
  structural half of the invariant, which the explicit delete would otherwise
  mask;
- the version counter is strictly greater after each of those three;
- a grant for a Role with an empty bundle writes no template and no link;
- a cross-Organization link write is refused with SQLSTATE `42501`
  (drizzle wraps it; the text is on `error.cause`).

### 4. Vocabulary equivalence (S2)

`packages/platform/src/authorization/vocabulary.test.ts`, staged. Both the
type-level and the value-level assertion — a type-only check passes on an object
literal that drifted behind a cast.

---

## Per-phase gate commands

### S1 — ADR + SECURITY.md

```bash
pnpm lint:root
```

Human gate: a named reviewer signed off on the `permission_scope_versions`
carve-out subsection specifically. Not on the ADR as a whole; the carve-out is
the only part that weakens a standing invariant, and a blanket approval is not
an approval of it.

### S2 — vocabulary

```bash
pnpm install
pnpm --filter=@station/platform typecheck
pnpm --filter=@station/platform test
pnpm --filter=@station/platform lint
pnpm dependencies:check
```

- `actionNames` ≡ `permissionKeys ∪ instancePermissionKeys`, value and type;
- `actionGroupNames` = `['gate:*', 'run:*']` and none of them requestable;
- Cedar accepts the generated schema;
- `dependencies:check` green — this is the proof that
  `@nestm/permissions-core` is NestJS-free and drizzle-free, rather than the
  claim being taken from a README;
- **exactly one static import of the main barrel in `packages/platform`, and it
  is a `type` import.** `vocabulary.ts` and `entities.ts` import from
  `@nestm/permissions-core/vocabulary` — the schema-authoring subpath, pure
  TypeScript, no engine and no WASM. The one exception is `EntityJson`, which
  lives only on the barrel and is erased because it is imported with `type`:

  ```bash
  grep -rn "from '@nestm/permissions-core'" packages/platform/src
  # entities.ts:  import type { EntityJson } from '@nestm/permissions-core'
  # vocabulary.test.ts:  const { validateVocabulary } = await import(...)   <- dynamic, test-only
  ```

  Any other hit is a barrel import that will pull 4.1 MiB into whatever imports
  `@station/platform`;
- **VERIFY** the `packages/web` bundle did not gain 4.1 MiB. Record before/after
  if `packages/web` reaches `packages/platform` at all — the design asserts it
  does and that was not re-confirmed against this tree. This half is about
  station's graph, not about the library: the subpath is asserted WASM-free
  upstream by `tests/unit/vocabulary-entry.test.ts`, which probes
  `__cedarLoaded()` after importing the entry.

### S3 — schema and migration

```bash
docker compose up -d postgres
pnpm database:generate
pnpm database:migrate
pnpm database:drift        # exit 0: schema and migration agree
pnpm --filter=@station/database typecheck
pnpm database:test
```

Then, by hand in `psql` as `station_app` (or via an integration case):

```sql
-- no context: zero rows, not an error
SELECT count(*) FROM permission_policies;                    -- 0
SELECT count(*) FROM permission_policy_links;                -- 0
-- the carve-out: readable with no context, by design
SELECT count(*) FROM permission_scope_versions;              -- >= 0, no error

-- another tenant's context: write refused
BEGIN;
SELECT set_config('station.organization_id', '<other-org>', true);
INSERT INTO permission_policies (organization_id, policy_id, kind, cedar_json)
VALUES ('<this-org>', 'x', 'static', '{}'::jsonb);           -- SQLSTATE 42501
ROLLBACK;
```

And in `pg_catalog`, the carve-out asserted rather than assumed:

```sql
SELECT relname, relrowsecurity, relforcerowsecurity
FROM pg_class
WHERE relname LIKE 'permission_%';
-- permission_policies       t t
-- permission_policy_links   t t
-- permission_scope_versions f f     <- the ADR-0020 carve-out
```

That last query belongs in CI. It is the one thing that turns "we decided not to
enable RLS there" into "RLS is not enabled there", and it also catches the
opposite accident — someone enabling it later and silently stopping every
replica's cache invalidation.

And the companion to it — **every `extraTableConfig` entry actually reached the
migration**:

```sql
-- 2 isolation policies, on the two tenant tables and nowhere else
SELECT tablename, policyname FROM pg_policies WHERE tablename LIKE 'permission_%';
-- permission_policies      permission_policies_isolation_policy
-- permission_policy_links  permission_policy_links_isolation_policy

-- 4 foreign keys: 2 to organizations, 1 composite to permission_policies,
-- 1 composite to role_grants
SELECT conrelid::regclass AS table, conname
FROM pg_constraint
WHERE contype = 'f' AND conrelid::regclass::text LIKE 'permission_%'
ORDER BY 1, 2;
```

This is not belt-and-braces. The previous driver release invoked
`extraTableConfig` once **per table**, and the guarded workaround that fact
forced (`tables.policies === undefined ? [] : […]`) silently returned `[]` for
the `links` entries whenever drizzle serialised that table first — producing a
migration that is valid SQL, applies cleanly, and leaves `permission_policy_links`
with **no isolation policy and no foreign keys**. Nothing downstream notices: the
application works, the tests pass, and cross-tenant reads are possible. The
factory now resolves the option exactly once with all three tables populated, so
the failure is fixed at the source — but the counts above are what proves it for
*this* migration, and they cost one query each.

### S4 — projection

```bash
pnpm --filter=@station/database test
pnpm database:test
pnpm authz:backfill --dry-run
pnpm authz:backfill
pnpm authz:drift                    # "Authorization projection is exact."
pnpm --filter=@station/api test
pnpm contracts:generate && git diff --exit-code packages/api-client openapi.json
```

**Idempotence:** a second `pnpm authz:backfill` reports `+0/-0` on every
Organization. The upserts carry `WHERE … IS DISTINCT FROM` clauses precisely so
the counters are a change count.

**Drift after the blackbox suite:** run `pnpm authz:drift` against the database a
blackbox run left behind. That is the check that catches a write path with no
projection — including the raw-SQL custom Role at
`authorization.blackbox.test.ts:136-165`.

**Read the diff for the advisory lock.** `pg_advisory_xact_lock` must still be
the first statement in `revokeRoleGrant`'s transaction. A test cannot prove this
cheaply (it is a write-skew window under concurrency); reviewing the diff can.

### S5 — engine module

```bash
pnpm --filter=@station/api typecheck
pnpm --filter=@station/api test
pnpm contracts:generate
```

Five gates, in order of how likely they are to send you backwards:

1. **`validateRequests` is on.** The invariant at the top of this file. Cheapest
   gate here and the one with the worst failure mode, so it goes first now.
2. **`validatePolicies` is `ok` for a seeded Organization.**

   ```ts
   const report = await engine.validatePolicies(organizationScope(organizationId))
   expect(report.errors).toEqual([])
   expect(report.ok).toBe(true)
   ```

   This used to be the single highest risk in the migration — a Role template
   names up to 25 actions whose declared resource types differ, and the open
   question was whether Cedar's validator rejects that as unsatisfiable. **It
   does not.** Verified upstream against `cedar-wasm@4.12.0` and pinned by
   `packages/permissions-core/tests/integration/multi-resource-template.test.ts`:
   a template naming 25 actions across 5 declared resource types validates with
   zero errors and zero warnings, links included, and links evaluate correctly
   through the entity hierarchy (the scope constraint is a hierarchy test, not a
   type test).

   So the gate stays, but its meaning changed: it is no longer asking whether
   the *design* works, it is checking that station's actual generated templates
   are the shape the upstream test modelled. A failure here now means the
   projection emitted something unexpected — most likely a `when` condition,
   which is constraint (a) of the invariant above — not that the design needs
   splitting by resource-type group. **The split plan is withdrawn.**

   `validateOnLoad: false` is still not a fix for anything: it is the setting
   that lets an errored `forbid` vanish from a decision.
3. Boot succeeds with `routeAudit.mode: 'error'`,
   `additionalMetadataKeys: [ROUTE_PERMISSION, IS_PUBLIC_ROUTE]`, **and**
   `interop: { publicKeys: [IS_PUBLIC_ROUTE], declaredKeys: [ROUTE_PERMISSION] }`.
   Assert the two lists name the same keys — they answer different questions
   about the same decorator (audit coverage vs guard behaviour) and drift between
   them is the S7 failure that reaches production:

   ```ts
   it('keeps interop and the audit in step', () => {
     const audited = new Set(moduleOptions.routeAudit?.additionalMetadataKeys ?? [])
     for (const key of [
       ...(moduleOptions.interop?.publicKeys ?? []),
       ...(moduleOptions.interop?.declaredKeys ?? []),
     ]) {
       expect(audited).toContain(key)
     }
   })
   ```
4. **Poller liveness.** Bump a counter by hand and observe a reload within 5 s:

   ```sql
   UPDATE permission_scope_versions SET version = version + 1, updated_at = now()
   WHERE organization_id = '<org>';
   ```

   No reload means RLS got enabled on that table, or the poller was not started
   (`watch()` is lazy — the engine subscribes, so this also proves the engine
   wired the store).
5. Clean shutdown. `StationPolicyStore.dispose()` must stop the poller, or the
   vitest run hangs. This is how a leaked timer is found.

Also assert, once, that the store really is write-refusing — it is wrapped in
`readOnlyPolicyStore(...)` rather than hand-stubbing four methods, and the point
of that wrapper is that the rejection is loud:

```ts
await expect(store.save([policyRecord])).rejects.toThrow(/read-only/)
await expect(store.save([])).rejects.toThrow(/read-only/)   // empty batch too
```

The second line is the one worth writing. A writable store treats an empty batch
as a no-op, so a store that only rejected non-empty batches would make "nothing
to do" and "this store cannot write" the same observation — and a caller that
batches zero records today learns nothing about the batch of one it sends
tomorrow.

### S6 — shadow, the exit gate

```bash
STATION_AUTHZ_ENGINE=shadow pnpm --filter=@station/api test
curl -s localhost:3001/metrics | grep station_api_authz
```

All three must hold, over the full blackbox suite **and** the staging soak:

| Metric | Required |
|---|---|
| `station_api_authz_divergence_total` | `0` |
| `station_api_authz_shadow_failures_total` | `0` |
| `station_api_authz_shadow_comparisons_total` | `> 0`, and plausible against the number of guard decisions the suite makes |

The third is not padding. A comparison count of zero, or one an order of
magnitude below expectation, means the shadow call sites are on a branch the
tests do not reach — and a shadow that never ran reads exactly like a shadow that
always agreed.

A divergence is triaged in this order: (a) `pnpm authz:drift` — is the projection
complete? (b) is the vocabulary's action/resource pair right for that route?
(c) is it the transitive-`in` widening? In this tree (c) is unreachable, so a
divergence attributed to it is almost certainly (a) or (b) misdiagnosed.

**Rollback:** `STATION_AUTHZ_ENGINE=legacy`. No code change, no deploy of a
revert.

### S7 — cutover, per route

```bash
curl -sf localhost:3001/health          # FIRST, and after every deploy in this phase
pnpm --filter=@station/api test
STATION_AUTHZ_ENGINE=cedar pnpm --filter=@station/api test
STATION_AUTHZ_ENGINE=shadow pnpm --filter=@station/api test
pnpm contracts:generate && git diff --exit-code packages/api-client openapi.json
```

Both modes run in CI until S10: `cedar` proves the new path, `shadow` keeps the
legacy path compiled and keeps the divergence counter honest.

#### Step 0 — the abstention gate

The guard registration lands **on its own**, with zero decorator changes. This
is the commit that proves `interop` works, and it has a gate nothing else has:

**every blackbox suite passes completely unchanged.** All 15 routes still carry
station's decorators; 13 are abstained on by `declaredKeys`, 2 are allowed by
`publicKeys`. Nothing about the observable behaviour of the application may
differ. Specifically:

```bash
pnpm --filter=@station/api test         # every suite, no edits, no skips
curl -sf localhost:3001/health          # 200, not 403
curl -sf localhost:3001/metrics         # 200, not 403
```

Three failure signatures and what each means:

| Symptom | Cause |
|---|---|
| every guarded route 403s | `declaredKeys` missing or naming the wrong string — `ROUTE_PERMISSION` is the literal `'ROUTE_PERMISSION'` (`require-permission.decorator.ts:7`), not a symbol |
| `/health` and `/metrics` 403 | `publicKeys` missing `IS_PUBLIC_ROUTE` |
| boot fails, undeclared routes listed | `routeAudit.additionalMetadataKeys` out of step with `interop` — see the S5 gate |

A 403 here is a misconfiguration, never something to work around by migrating
the route early. Stop and fix `interop`.

#### Per route, thereafter

Each migrated route is one decorator replacement. The gate has two halves and
the second is the one people forget:

1. the blackbox cases touching **this** route pass under
   `STATION_AUTHZ_ENGINE=cedar`;
2. the blackbox cases touching every route that has **not** migrated still pass
   unchanged — that is the check that abstention is still holding the rest of
   the surface, and it is what catches a decorator removed from a route that did
   not gain the library's one (which would silently become undeclared → 403).

A cheap way to keep half 2 honest is to assert the shrinking legacy surface
rather than eyeballing it:

```bash
# routes still on the legacy guard — must decrease monotonically, never jump to 0
grep -rc "@RequirePermission(" apps/api/src --include=*.controller.ts
```

**Rollback is per route:** restore station's decorator, remove the library's.
The legacy guard resumes enforcing that endpoint and nothing else changes — no
deploy-wide flag flip, no revert of the guard registration.

#### Byte-identity checks, at every step

```bash
# unknown Organization vs non-Member probe — the ADR-0014 property
diff <(curl -s -H "Authorization: Bearer $T" localhost:3001/organizations/00000000-0000-4000-8000-000000000000/members) \
     <(curl -s -H "Authorization: Bearer $T" localhost:3001/organizations/$REAL_ORG_CALLER_IS_NOT_IN/members)
# must be empty apart from `requestId`

# malformed id — 400 with the station pointer, not 404 and not 500
curl -s -H "Authorization: Bearer $T" localhost:3001/organizations/not-a-uuid/members
# {"type":"/problems/validation-failed", … "errors":[{"pointer":"organizationId", …}]}
```

The second one used to be a `VERIFY` in `authorization-engine.module.ts` —
whether a throw out of `scopeResolver` propagates rather than escaping as a 500.
**It is settled:** any throw out of a `scopeResolver` becomes an `invalid-scope`
denial, and `denial.onInvalidScope(error, ctx)` owns the response. Three
properties to check here rather than one:

- the status is **400**, not 404 and not 500;
- it is 400 **without a valid credential too**. Run the same request with a
  garbage bearer token: still 400, never 401. Scope resolution runs before
  principal resolution by design, and a status that changed with the credential
  would let a caller distinguish "malformed tenant id" from "valid tenant id you
  are not in" — the exact oracle the 404 path exists to close;
- the response body **does not contain the string `not-a-uuid`**. The hook is
  given `value` and must not echo it:

  ```bash
  curl -s -H "Authorization: Bearer $T" localhost:3001/organizations/not-a-uuid/members \
    | grep -q "not-a-uuid" && echo "FAIL: response echoes the raw path segment"
  ```

### S8 — query plans

```bash
pnpm --filter=@station/api test
pnpm database:test
```

The gate is set equality, not "it returns something":

```bash
# before and after the S8 diff, same fixture, both grant shapes
GET /organizations/:id/projects  as an org-wide project:read holder    -> all projects
GET /organizations/:id/projects  as a project-scoped holder            -> exactly that project
GET /organizations/:id/projects  as a Member with no project:read      -> 403 (plan-denied)
```

The third is the one that regresses silently: `ALWAYS_DENY` must compile to the
literal `false`, never to an omitted `WHERE`. There is no library API that can
return "no filter" — `planToSql` is total — so this is really checking that the
call site did not add an `if (plan.kind === 'ALWAYS_DENY') return []` shortcut
that diverges from the compiled predicate.

Also assert a Project created **after** the grant is visible to an org-wide
holder. A materialised id list would miss it; `organization_id = $org` does not.

### S9 — Better Auth hooks

```bash
pnpm --filter=@station/api test    # invitations.blackbox.test.ts
```

The refusal is Better Auth's `APIError('FORBIDDEN')`, not station's RFC 9457
envelope — ADR-0014 keeps the mount outside the filter, and that must not change.

### S10 — deletion

```bash
pnpm check          # lint + typecheck + test + build + dependencies:check + authz:drift
pnpm contracts:generate && git diff --exit-code packages/api-client openapi.json
grep -rn "STATION_AUTHZ_ENGINE" apps packages   # only .env.example, if anywhere
grep -rn "permissionReach\|hasAnyPermission\|hasOrganizationPermission" apps packages  # empty
```

**The gate that licenses deleting `interop`.** Both keys must be gone from every
route *before* the `interop` block comes out of `authorization-engine.module.ts`:

```bash
grep -rn "@RequirePermission(\|ROUTE_PERMISSION\|IS_PUBLIC_ROUTE" apps/api/src   # empty
```

Order matters and only in one direction. Deleting `interop` while a single route
still carries `ROUTE_PERMISSION` converts that route from "enforced by the legacy
guard" to "declared by nothing" — which `onUndeclaredRoute: 'deny'` turns into a
403 on an endpoint that was working. The reverse mistake (deleting the decorators
first, leaving `interop` naming keys nothing carries) is inert: both lists are
simply never matched.

The two `@Public()` controllers are the last edit of the phase — they are the
only routes that never needed one during the cutover, because `interop.publicKeys`
carried them the whole way. They get `@CedarPublic()` in the same commit that
drops `interop` and deletes `apps/api/src/auth/public.decorator.ts`.

---

## Rollback, per phase

| Phase | Rollback | Cost |
|---|---|---|
| S1 | revert two docs | none |
| S2 | delete three files, revert two | none — nothing imports them |
| S3 | the `DOWN MIGRATION` comment block in `0004_*.sql`, then revert the schema merge and the journal/snapshot | drops three tables + one constraint; no application data |
| S4 | revert the source diffs | projection rows go inert; drop with S3 if the tables go |
| S5 | remove `AuthorizationEngineModule.forRoot()` from `ApiSecurityModule` | none — the module is inert until imported, and registers no guard |
| S6 | `STATION_AUTHZ_ENGINE=legacy` | environment change, no deploy |
| S7 | **per route**: restore station's decorator, remove the library's — the legacy guard resumes enforcing it. To back out the whole phase, remove `PermissionsGuard` from `ApiSecurityModule`; every route is then declared by station's decorator again and `interop` is inert. | one-line diff per route; no flag flip, no environment change |
| S8 | revert the `tenancy.service.ts` diff | the legacy `projectIds` branch is still there until S10 |
| S9 | revert one function body | none |
| S10 | **none** | forward only; fix forward |

The flag is the rollback for Phases 1–3, which is why the legacy path stays
compiled and CI keeps running both modes until S10 deletes it.

---

## Smoke checks that must hold at every phase from S5 on

- an unknown-Organization 404 body is byte-identical to a non-Member probe's,
  `requestId` aside;
- a malformed `organizationId` is a 400 carrying `pointer: "organizationId"`;
- `/health` and `/metrics` answer without a bearer token;
- killing the poller (stop writing `permission_scope_versions`) makes a new grant
  take up to 5 s to become effective on other replicas, and **never** widens
  access — a stale policy set is the previous one;
- revoking a grant is effective on the revoking replica within the next request.
  That requires the explicit
  `permissionsService.invalidate(organizationScope(id))` from drift D-13, called
  **after the transaction commits**; if the next request still allows, that call
  is missing or is inside the transaction. Two things to check when it fails:
  it must be `invalidate(scope)` and not `reload()` (which drops every tenant's
  cache to publish one tenant's grant — correct, but a thundering herd against
  the policy store), and it must be *after* commit (before commit it drops the
  cache and lets the next check reload the **old** bundle, leaving a stale entry
  with a fresh timestamp — strictly worse than not invalidating at all);
- **another tenant's cache survives that invalidation.** With two Organizations
  warm on one replica, granting in A must not cold-load B. Assert it on
  `engine.stats()` around the write: B's scope stays loaded. This is the
  difference between `invalidate(scope)` and `reload()` and it is invisible in
  any correctness test — both are correct, only one is affordable;
- a policy set that fails to load produces 503, never an allow. Force it: revoke
  `SELECT` on `permission_policies` from `station_app` in a scratch database and
  confirm the response is 503 and not 200.
