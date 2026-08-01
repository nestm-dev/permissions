# Station migration runbook — `@nestm/permissions`

Staged artifacts for S1–S10 of the Cedar migration described in
`docs/design/drivers-and-station.md` §4 and `docs/design/plan.md`.

Nothing in this directory has been applied to
`/Users/kauan/Projects/concepta/station`. That tree is dirty with in-flight work
and was read strictly read-only. Every file under `files/` names its exact
destination in a header comment.

**Read `## 0. Drift` before applying anything.** The station tree moved after the
design was written, and the library shipped its station-readiness fixes after
these artifacts were staged. Fifteen of the design's concrete instructions are
now wrong; each is listed with what to do instead. Three of them (D-11, D-13,
D-15) are wrong because the *library* grew a better answer, not because station
moved — those are the ones where an older workaround is now actively worse than
the supported option.

```
station-migration/
├── RUNBOOK.md                      this file
├── VERIFICATION.md                 per-phase gates, tests, rollback
├── adr/
│   ├── 0020-cedar-authorization-engine.md   ADR draft (status: proposed)
│   ├── 0019-RENUMBERED-TO-0020.md           why it is not 0019
│   └── SECURITY-amendment.md                exact docs/SECURITY.md edits
└── files/
    ├── platform/authorization/vocabulary.ts        + vocabulary.test.ts
    ├── platform/authorization/entities.ts
    ├── database/schema-permissions.ts              merge into schema.ts
    ├── database/0004_cedar-policy-store.sql
    ├── database/authorization-mappings.ts
    ├── database/projection-writes.md               before/after diffs
    ├── scripts/backfill-authz-projection.mjs
    ├── scripts/assert-authz-projection.mjs
    ├── api/authorization-engine.module.ts
    ├── api/shadow-authorization.service.ts
    └── api/guard-swap.md                           all 15 routes
```

The `.ts` files are real code written against the shipped library APIs. They
cannot be compiled in place — station's workspace has no `@nestm/permissions*`
yet — so every uncertainty carries a `// VERIFY:` comment rather than a guess.
Search for `VERIFY:` across `files/` before the first `pnpm typecheck`.

**Three** remain, and all three are about *station*, not about the library:

| Where | What is unresolved |
|---|---|
| `files/api/authorization-engine.module.ts` (`StationEntityProvider`) | a Repository's Project id is not in the URL today. The branch returns the Organization only, which denies rather than over-grants. Needs the real `repositories.project_id` when a route first guards a Repository. |
| `files/database/authorization-mappings.ts` | the `Repository` hierarchy mapping needs `Organization` as well as `Project` — the compiler cannot infer a two-hop path from a one-hop mapping. Fails closed (`UnmappedHierarchyError`) rather than over-selecting, but still a bug. |
| `files/api/shadow-authorization.service.ts` | module instantiation order: `AuthorizationEngineModule` must be imported before `ApiSecurityModule` builds the legacy guard. |

The ones that used to sit in `schema-permissions.ts` (the `link_id` override
working only by spread order), in `authorization-engine.module.ts` (two database
double-casts, and whether a `scopeResolver` throw propagates), and in
`vocabulary.test.ts` are all **resolved by shipped APIs** and have been deleted
rather than left as folklore. Do not reinstate a workaround you find in an older
copy of these files without checking it against this table first.

---

## 0. Drift — design §4 versus the working tree

| # | Design says | Working tree | Do instead |
|---|---|---|---|
| D-1 | ADR-**0019** is "Cedar is the authorization engine" | `0019-framework-free-cores-concern-specific-nest-adapters.md` exists | The ADR is **0020**. See `adr/0019-RENUMBERED-TO-0020.md`. |
| D-2 | "`dependency-cruiser.config.mjs` contains **only** a `no-circular` rule" | Four rules, including `framework-free-packages-do-not-import-nest` and `platform-does-not-import-database-infrastructure` | **No config change needed.** `@nestm/permissions-core` imports no `@nestjs/*` and no `drizzle-orm`/`pg`, so it satisfies both. Stronger since the artifacts were staged: `packages/platform` imports the **`@nestm/permissions-core/vocabulary`** subpath, which is asserted pure TypeScript upstream (`tests/unit/vocabulary-entry.test.ts` probes `__cedarLoaded()`) and never reaches the engine, the plan compiler, the policy-store SPI or the 4.1 MiB WASM. Cite that subpath in the cruiser rule's comment rather than the barrel. Do **not** add the design's `platform-stays-framework-free` rule — it would duplicate an existing rule with a narrower allow-list and immediately fail on `@station/contracts`' own transitive graph. |
| D-3 | `organizationHooks` live in `apps/api/src/auth/auth.module.ts:54-85` | That file is **deleted**. Hooks are in `apps/api/src/auth/better-auth.factory.ts:107-173`; the `canManageInvitations` predicate is injected at `apps/api/src/auth/identity.module.ts:67-98` | S9 edits `identity.module.ts`. See `files/api/guard-swap.md` § S9. |
| D-4 | `PermissionGuard` is registered in the app module | `apps/api/src/security/api-security.module.ts:12-16`, as an explicit ordered `APP_GUARD` pair after `AccessTokenGuard` (ADR-0019 calls the order "a security property, not a formatting preference") | Register `PermissionsGuard` there by hand and pass `disableGlobalGuard: true` to `PermissionsModule`, or module import order silently decides guard order. |
| D-5 | `packages/database/src/authorization.ts` is the write boundary | Still true, but every consumer now goes through framework-free repository classes (`AuthorizationRepository`, `RolesRepository`, `TenancyRepository`, `OperatorsRepository`, `AuditTrailRepository`) registered by `StationDatabaseModule.forFeature` | Projection writes go in the same functions; no repository signature changes. |
| D-6 | `role_grants` needs `UNIQUE(organization_id, id)` | Confirmed — `role_grants` is the only Organization-scoped table without the `_organization_id_id_unique` constraint every sibling carries | Add it in 0004 (`files/database/0004_cedar-policy-store.sql`, first statement). |
| D-7 | Entity hierarchy includes `Run`, `Gate`, `Board`, `WorkItem`, `Workflow`, `Artifact`, `Secret`, `Approval` with attributes | **None of those tables exist.** Tables today: `organizations`, `projects`, `repositories`, `members`, `invitations`, `permissions`, `operators`, `roles`, `role_permissions`, `role_grants`, `audit_entries` | The vocabulary declares the entity types (the closed Permission enum needs them) but **no attributes**, and drops `Approval` entirely. See the DEFERRED block at the bottom of `files/platform/authorization/vocabulary.ts`. |
| D-8 | `pnpm --filter @station/api run test:blackbox` | No such script. Blackbox suites run inside `pnpm --filter=@station/api test`, which is `test:compile` (a real `nest build`) then `vitest run --config vitest.compiled.config.ts` | Use `pnpm --filter=@station/api test`; there is no separate blackbox gate to invoke. |
| D-9 | `{ kind: 'project', parameter }` routes exist | **Zero routes use it.** The branch exists only in `permission.guard.ts:164-179` and is exercised solely by `permission.guard.test.ts` | The `param`→`Project` mapping is still staged (S7 needs it the moment a Project-scoped route lands) but nothing exercises it in production traffic. Do not treat its shadow-mode silence as evidence it works. |
| D-10 | `t.policies.organizationId` in `extraTableConfig` | The factory keys the tenant column by the drizzle **property** name `scope`; `scopeColumn.name` only sets the SQL name | Use `t.policies["scope"]`. The design was wrong here and the driver README has since been corrected. The failure is silent, not loud: `.organizationId` is `undefined`, and a `pgPolicy` interpolating `undefined` is a policy over nothing — an RLS policy protecting no column, on a tenant table. Pinned by `tests/unit/schema-factory.test.ts > the scope column's property name`. |
| D-11 | `permission_policy_links.link_id` is `uuid` | The factory's **default** is `text("link_id")`, and there is now a first-class option to change it | Pass `linkIdColumn: () => uuid("link_id").notNull()`. It is a documented option on **both** drivers, called once for the `links` table, and must return a fresh builder. Without it PostgreSQL refuses the composite FK to `role_grants(id uuid)`. The old `extraColumns.links.linkId` trick — which worked only because `extraColumns` happened to be spread last in the column map — is obsolete; do not reintroduce it. |
| D-15 | `extraTableConfig` may be called once per table, so guard every branch | **Fixed upstream.** It is called **exactly once per schema**, with all three tables' columns populated, and each key's entries are built at most once. Entries may also be thunks. | Drop the guards and use `assertTablesReady(raw)`. The guards were not merely obsolete, they were **dangerous**: drizzle extracts each table's config independently and in no guaranteed order, so a `links` entry guarded on `tables.policies` returned `[]` whenever the links table serialised first — its composite FK and its RLS isolation policy silently absent from the migration, with no error anywhere. See `docs/design/errata.md` § station-readiness item 2. |
| D-12 | Roles are created only by `createDefaultRoleBundles` | `authorization.blackbox.test.ts:136-165` inserts a custom Role with raw SQL, and any future seed can too | `createRoleGrant` upserts the granted Role's template before writing the link, so the projection is self-healing. This is what lets that blackbox case pass **unchanged**. |
| D-13 | Revoking is "effective immediately on the replica that performed the revoke" | Only true when the write goes through `DrizzlePolicyStore.save()`, which emits a post-commit event. Station's writes go through `@station/database` so they can share the grant's transaction and advisory lock — no event is emitted | **Resolved.** Call `permissionsService.invalidate(organizationScope(id))` from `RolesService` after the grant/revoke transaction **commits**. Per-org, not `reload()`: `reload()` is `engine.invalidate('*')` and drops every tenant's cache to publish one tenant's grant, which is a thundering herd against the policy store on a busy instance. See `files/database/projection-writes.md` § "Staleness". |
| D-14 | `audit_entries` does not exist | It does (migration `0003`, ADR-0018), and `GET /organizations/:organizationId/audit-entries` is a live route | `AuditEntry` is a first-class vocabulary entity with an `organization` attribute; the route is in the S7 table. |

Two more, smaller: `apps/api/src/database/database.module.ts` is now
`api-database.module.ts` (`APPLICATION_DATABASE_CONNECTION` /
`IDENTITY_DATABASE_CONNECTION` tokens), and `apps/api` already depends on the
`@nestm` scope (`@nestm/better-auth`, `@nestm/standard-schema`), so adding three
more `@nestm/*` packages needs no registry or `.npmrc` work.

---

## Sequencing

Phase 0 is everything additive: it can land in one PR or five, it changes no
behaviour, and it is reversible by dropping three tables. Nothing reads the new
tables until S5.

```
Phase 0  additive        S1  ADR + SECURITY.md              ← REVIEW GATE
                         S2  vocabulary + entity builders
                         S3  schema + 0004 migration
                         S4  projection writes + scripts
Phase 1  shadow          S5  engine module (+ interop keys)
                         S6  shadow service + flag          ← EXIT GATE: zero divergences
Phase 2  cutover         S7  guard registration, then one route at a time
Phase 3  query plans     S8  listProjects / listOrganizations
                         S9  Better Auth hooks
Phase 4  delete          S10 legacy removal                 ← irreversible
```

**Steps needing human review, not just a green build:** S1 (both documents; the
`permission_scope_versions` carve-out needs a named security sign-off), the S6
exit gate (a human decides that zero divergences over N days of staging traffic
is enough), and the S7 cutover order (each route is a separate decision to
promote, and step 0 — the guard registration with no route edits — is its own
gate). Everything else is mechanical copy-in plus the listed commands.

---

## S1 — ADR-0020 and the SECURITY.md amendment

**Review gate. Do not start S2 until this is accepted.** Every later step
depends on the carve-out being approved; discovering it is not approved at S5 
means unwinding a migration.

| | |
|---|---|
| **Create** | `docs/adr/0020-cedar-authorization-engine.md` ← `adr/0020-cedar-authorization-engine.md` |
| **Modify** | `docs/SECURITY.md` ← the four edits in `adr/SECURITY-amendment.md` |
| **Modify** | `docs/DOCS_INDEX.md` — add the ADR row (check the file's existing format) |
| **Not modified** | `dependency-cruiser.config.mjs` — see drift D-2 |

```bash
pnpm lint:root          # oxlint over scripts + the cruiser config; unaffected, run it anyway
```

**Gate:** a named reviewer has signed off on the "one row-level-security
carve-out" subsection specifically — not on the ADR as a whole. Delete the
`> **Status: proposed.**` blockquote on acceptance.

**Rollback:** delete two files, revert one.

---

## S2 — vocabulary and entity builders

| | |
|---|---|
| **Create** | `packages/platform/src/authorization/vocabulary.ts` |
| **Create** | `packages/platform/src/authorization/vocabulary.test.ts` |
| **Create** | `packages/platform/src/authorization/entities.ts` |
| **Modify** | `packages/platform/src/index.ts` — `export * from './authorization/vocabulary.js'` and `'./authorization/entities.js'` |
| **Modify** | `packages/platform/package.json` — `"@nestm/permissions-core": "0.1.0-alpha.0"` in `dependencies` |

```bash
pnpm install
pnpm --filter=@station/platform typecheck
pnpm --filter=@station/platform test
pnpm --filter=@station/platform lint
pnpm dependencies:check          # must stay green: platform now has an npm dep
```

**Expected:** `vocabulary.test.ts` passes, including the Cedar `checkParseSchema`
case, which loads the WASM once (~1 s).

**Gate:**

1. `ActionOf<typeof stationVocabulary>` equals `PermissionKey | InstancePermissionKey`
   as a *type* and `actionNames` equals the two enums as a *value* — both halves,
   because a type-only assertion passes on a vocabulary whose object literal
   drifted behind a cast;
2. `dependencies:check` green — this is the check that `@nestm/permissions-core`
   really is NestJS-free and drizzle-free, rather than that being taken on trust;
3. the console bundle did not regress. `vocabulary.ts` and `entities.ts` import
   from **`@nestm/permissions-core/vocabulary`**, the schema-authoring subpath,
   which is pure TypeScript and never reaches the engine, the plan compiler, the
   policy-store SPI or the 4.1 MiB WASM — asserted upstream by
   `tests/unit/vocabulary-entry.test.ts`, which probes `__cedarLoaded()` after
   importing the entry. `defineVocabulary` performs no Cedar work either (core
   delta D3). **VERIFY** whether `packages/web` actually reaches
   `packages/platform` — the design asserts it and it was not re-checked against
   this tree; that half is about station, not about the library. If it does,
   record the before/after bundle size. If the WASM appears anyway, the cause is
   a barrel import that slipped in, not a missing entry point: grep
   `packages/platform` for `from '@nestm/permissions-core'` and expect exactly
   one hit — the dynamic `await import(...)` of `validateVocabulary` inside
   `vocabulary.test.ts`, which is test-only and deliberately not static.

**Rollback:** delete three files, revert two. Nothing else references them yet.

---

## S3 — the schema and migration `0004`

| | |
|---|---|
| **Modify** | `packages/database/src/schema.ts` — append `files/database/schema-permissions.ts`, add the `createPermissionsSchema` import, add `unique("role_grants_organization_id_id_unique")` to the `roleGrants` extras array |
| **Create** | `packages/database/drizzle/0004_cedar-policy-store.sql` — generate it, then append the hand-written block from `files/database/0004_cedar-policy-store.sql` |
| **Create** | `packages/database/drizzle/meta/0004_snapshot.json` — generated, never hand-written |
| **Modify** | `packages/database/drizzle/meta/_journal.json` — generated |
| **Modify** | `packages/database/package.json` — `"@nestm/permissions-drizzle": "0.1.0-alpha.0"` |

```bash
pnpm install
pnpm database:generate           # writes 0004_*.sql + snapshot + journal entry
# append the HAND-APPENDED block from files/database/0004_cedar-policy-store.sql
docker compose up -d postgres
pnpm database:migrate
pnpm database:drift              # regenerates and asserts an empty git diff
pnpm --filter=@station/database typecheck
pnpm database:test               # integration suite, real PostgreSQL, station_app
```

**Expected:** `0004_*.sql` contains three `CREATE TABLE`s, four indexes, two
`CREATE POLICY`s, **three** foreign keys from `extraTableConfig` plus the
`permission_policy_links_role_grant_fk`, and the `role_grants` unique
constraint; `link_id` is `uuid` (drift D-11, via `linkIdColumn`); the generated
`USING`/`WITH CHECK` predicates name `organization_id` (drift D-10 — if a policy
comes out over no column at all, `extraTableConfig` read `.organizationId`
instead of `["scope"]`).

**Gate:**

1. `pnpm database:drift` reports no diff — the schema and the migration agree;
2. `permission_scope_versions` has **no** `CREATE POLICY` and **no** `FORCE ROW
   LEVEL SECURITY`, and `permission_policies` / `permission_policy_links` have
   both;
3. **every `extraTableConfig` entry actually landed.** Count them in the
   generated SQL, do not assume: 4 foreign keys (`policies`→`organizations`,
   `links`→`policies` composite, `links`→`role_grants` composite,
   `scope_versions`→`organizations`) and 2 `CREATE POLICY`. This is the gate for
   drift D-15 — the old guarded form dropped the entire `links` array whenever
   drizzle serialised that table first, and the result was *valid SQL* that
   applies cleanly and leaves a tenant table with no isolation policy and no
   foreign keys. A silently missing `CREATE POLICY` is the worst outcome in this
   step and nothing else in the pipeline notices it. The exact `pg_policies` /
   `pg_constraint` queries are in VERIFICATION.md § S3;
4. an isolation check under `station_app`: with no context, `SELECT` on both
   policy tables returns zero rows; with a foreign Organization's context, an
   `INSERT` is refused with SQLSTATE `42501`. (drizzle wraps the driver error, so
   the `new row violates row-level security policy` text is on `error.cause`.)

**Rollback:** the commented `DOWN MIGRATION` block at the bottom of
`files/database/0004_cedar-policy-store.sql`, then revert the schema merge and
delete the journal/snapshot entries.

---

## S4 — transactional projection writes, backfill, drift check

| | |
|---|---|
| **Create** | `packages/database/src/authorization-projection.ts` — full source in `files/database/projection-writes.md` |
| **Create** | `packages/database/src/authorization-projection.test.ts` |
| **Modify** | `packages/database/src/seed.ts` — diff 1 |
| **Modify** | `packages/database/src/authorization.ts` — diffs 2 and 3 |
| **Modify** | `packages/database/src/index.ts` — export the projection module |
| **Create** | `packages/database/scripts/backfill-authz-projection.mjs` |
| **Create** | `packages/database/scripts/assert-authz-projection.mjs` |
| **Modify** | root `package.json` — `authz:backfill`, `authz:drift`; add `authz:drift` to the `check` script |

```bash
pnpm --filter=@station/database typecheck
pnpm --filter=@station/database test
pnpm database:test                # the real-PostgreSQL integration suite
pnpm authz:backfill --dry-run     # counts only, rolls back
pnpm authz:backfill
pnpm authz:drift                  # must print "Authorization projection is exact."
pnpm --filter=@station/api test   # blackbox suites — all 9 authorization cases
```

**Expected:** the backfill writes 4 templates and N links per pre-existing
Organization; a second run writes 0 of each (the `WHERE … IS DISTINCT FROM`
clauses make an unchanged upsert a no-op, so the counters really are a change
count, not a row count).

**Gate:**

1. `pnpm authz:drift` exits 0 on a database that has been through the full
   blackbox suite — that is the check that every write path projects, including
   the custom-Role path the blackbox test uses (drift D-12);
2. the advisory lock is still the first statement in `revokeRoleGrant` — read the
   diff, do not infer it from a green test;
3. `'refuses to revoke the last org-wide grant able to manage grants'` still
   passes;
4. `git diff --exit-code packages/api-client openapi.json` after
   `pnpm contracts:generate` — the contract must be untouched.

**Rollback:** revert the source diffs. The projection rows become inert (nothing
reads them yet); drop them with the S3 down migration if the tables go too.

---

## S5 — the engine module

| | |
|---|---|
| **Create** | `apps/api/src/authorization/authorization-engine.module.ts` |
| **Modify** | `apps/api/package.json` — the three `@nestm/permissions*` dependencies |
| **Modify** | `apps/api/src/security/api-security.module.ts` — import `AuthorizationEngineModule.forRoot()` (guard registration comes at S7) |

```bash
pnpm install
pnpm --filter=@station/api typecheck
pnpm --filter=@station/api test
pnpm contracts:generate           # boots the application — both audits must pass
```

**Expected:** the application boots. Nothing routes through the new guard yet
(`disableGlobalGuard: true`, and `PermissionsGuard` is not registered until S7),
so behaviour is unchanged.

**Gate:**

1. boot succeeds with `routeAudit.mode: 'error'` and the `interop` keys in step
   with it — this is where a route declared by neither family surfaces, and it
   surfaces as a *boot failure* in `contracts:generate`, i.e. in CI;
2. **`engine.validatePolicies(scope)` reports `ok` for a seeded Organization.**
   This was the highest-risk assertion in the migration. **It has now been run
   upstream and it passes** — see § "One template per Role" below. Keep the gate
   (it is cheap and it is the check that station's *actual* generated templates
   are what the upstream test modelled), but it is no longer the step most
   likely to send you backwards. `validateOnLoad: false` is still **not** a fix
   for anything — it is the setting that lets an errored `forbid` vanish;
3. **`validateRequests: true` is set, and asserted.** Not a tuning knob: with the
   one-template-per-role shape it is the only thing standing between "25 actions,
   each on its own resource type" and "25 actions on any resource type in the
   org". See § "One template per Role", constraint (c);
4. the poller runs: with `permission_scope_versions` unprotected, a manual
   counter bump in `psql` produces a reload within 5 s. If it does not, RLS was
   accidentally enabled on that table;
5. shutting the application down terminates cleanly — `StationPolicyStore` must
   dispose its poller, or the test run never exits.

### One template per Role — settled, with three constraints

The staged design writes **one** Cedar template per Role, naming every action
that Role grants even though those actions declare different resource types:

```cedar
permit(principal == ?principal,
       action in [Station::Action::"project:manage",
                  Station::Action::"run:read",
                  Station::Action::"run:dispatch"],
       resource in ?resource);
```

**Verdict: Cedar accepts this, at station's real width, and links to it evaluate
correctly.** Verified against `cedar-wasm@4.12.0` and pinned by
`packages/permissions-core/tests/integration/multi-resource-template.test.ts`:

- `validate()` returns `{ validationErrors: [], validationWarnings: [],
  otherWarnings: [] }`, byte for byte — for `resource in ?resource`, for an
  unconstrained `resource`, and for `resource == ?resource`;
- a generated case at **25 actions across 5 declared resource types**
  (`Organization`/`Project`/`Run`/`Secret`/`Webhook` × 5 verbs) validates clean,
  links included — that is station's real shape, not a reduced one;
- a link at `?resource = Station::Organization::"o1"` — an entity type no named
  action declares as a resource at all — **allows** both `run:dispatch` on a Run
  and `project:manage` on a Project, with the link id as the sole determining
  policy. Cedar resolves `Run::"r1" in Organization::"o1"` through the entity
  graph: the scope constraint is a **hierarchy** test, not a type test;
- splitting per resource type produces identical decisions and differs only in
  which link id is reported as determining. So the one-template form costs
  nothing observable and saves N−1 rows per grant.

**The plan to split by resource-type group is therefore withdrawn.** Nothing in
`authorization-projection.ts` or the two `.mjs` scripts needs a fallback shape.

Three constraints come with it, and all three are the same constraint stated
three ways: **the scope of such a template is permissive, so nothing about a
specific resource type may leak into it.**

**(a) A multi-resource-type role template must carry NO resource-attribute
`when` condition.** The condition is typechecked against the **union** of every
named action's declared resource type, so
`… resource in ?resource) when { resource.status == "queued" }` over the
three-action template above is a `validationError`: ``attribute `status` on
entity type `Station::Project` not found``. A Role that genuinely needs a
resource condition needs its own, narrower template. Station's projection emits
`conditions: []` today and must keep doing so — the projection unit test in
`files/database/projection-writes.md` pins that shape, and it is now pinning a
security property, not just a format.

**(b) A link whose `?resource` makes EVERY named action unreachable is
rejected** — `unable to find an applicable action given the policy scope
constraints` — and it is reported against the **link's** id, not the template's.
One reachable action is enough to pass, so a link at `?resource = Run::"r1"`
validates even though `project:manage` can never fire under it (a Project is
never `in` a Run). Consequence for station: a grant whose reach is narrower than
every action in its Role bundle will fail at *link* time with the
`role_grants.id` in the message, which is exactly the id needed to find the row.
Surface it rather than swallowing it — the backfill script's per-link error path
should print that id.

**(c) `validateRequests` must stay ON.** This is a hard invariant, not a
default. With `validateRequests: false`, `checkUnsafe({ action:
'project:manage', resource: Run::"r1" })` under an org-wide link returns
**allow**: the permissive scope matches and Cedar never consults the schema.
With it on, the same call throws ``resource type `Station::Run` is not valid for
`Station::Action::"project:manage"` ``. Turning it off converts every
one-template-per-role grant from "25 actions, each on its own declared resource
type" into "25 actions on any resource type in the org" — a silent, org-wide
privilege widening produced by a boot-time flag. It is set in
`authorization-engine.module.ts`'s `engine` block and asserted in
VERIFICATION.md.

**Rollback:** remove the import from `ApiSecurityModule`. The module is inert
until imported.

---

## S6 — shadow mode

| | |
|---|---|
| **Create** | `apps/api/src/authorization/shadow-authorization.service.ts` |
| **Modify** | `apps/api/src/config/environment.ts` — `STATION_AUTHZ_ENGINE` |
| **Modify** | `apps/api/src/metrics/metrics.module.ts` — export `PROMETHEUS_REGISTRY` |
| **Modify** | `turbo.json` — `STATION_AUTHZ_ENGINE` in `passThroughEnv` for `dev`, `test`, `openapi:generate` |
| **Modify** | `apps/api/src/authorization/permission.guard.ts` — the shadow call sites (edit D in the staged file) |
| **Modify** | `apps/api/src/authorization/authorization.module.ts` — provide the service |
| **Modify** | `.env.example` — document the flag |

```bash
pnpm --filter=@station/api typecheck
STATION_AUTHZ_ENGINE=shadow pnpm --filter=@station/api test
curl -s localhost:3001/metrics | grep station_api_authz
```

**Expected:** `station_api_authz_shadow_comparisons_total` climbs;
`station_api_authz_divergence_total` and
`station_api_authz_shadow_failures_total` stay at zero.

**EXIT GATE — the one that decides whether Phase 2 happens:**

1. `station_api_authz_divergence_total == 0` across the **full** blackbox suite;
2. `station_api_authz_shadow_failures_total == 0` — a shadow that silently
   stopped comparing reads exactly like a shadow that agrees, so this is not a
   secondary metric;
3. `station_api_authz_shadow_comparisons_total` is *plausible*: it should be
   roughly the number of guard decisions the suite makes on
   `organization`/`project`/`any`/`instance` routes. A suspiciously small number
   means the call sites are on the wrong branch;
4. N days of staging traffic with the same three conditions. N is a human
   decision; the counter is not.

Divergences are **not** dismissed. Each one is either a bug in the projection
(check `pnpm authz:drift` first), a bug in the vocabulary, or the intended
transitive-`in` widening — and the widening is not reachable today (no route
guards anything below a Project), so in this tree every divergence is a bug.

**Rollback:** `STATION_AUTHZ_ENGINE=legacy`. Zero request-path risk at any point.

---

## S7 — cutover, one route at a time

Full per-route table in `files/api/guard-swap.md`. **Routes are never
double-decorated.** `interop` is what makes this incremental: both guards are
registered, legacy first; a route still carrying station's `@RequirePermission()`
is one `PermissionsGuard` **abstains** on (returns `true`, resolves no principal,
stashes nothing) so station's `PermissionGuard` keeps enforcing it unchanged. A
route migrates by *replacing* its decorator — an own declaration is read first,
so from that commit on the library's guard is the one that decides it.

| | |
|---|---|
| **Modify** | `apps/api/src/security/api-security.module.ts` — `{ provide: APP_GUARD, useClass: PermissionsGuard }` **after** `AccessTokenGuard` |
| **Modify** | 4 controllers — replace station's decorator with the aliased library one, route by route |
| **Not modified** | `HealthController`, `MetricsController` — `interop.publicKeys` covers station's `@Public()`; they get `@CedarPublic()` at S10 |

The `interop` block lands with the module at S5, **before** the guard is
registered here. Registering the guard without it is what 403s every unmigrated
route at once, so treat it as part of the guard-registration commit's
preconditions rather than as configuration.

Order. The first commit is the guard registration alone, with no decorator
changes at all — that is the commit that proves abstention works, because
nothing has migrated yet and every route must behave exactly as before:

0. **Register `PermissionsGuard` with zero route edits.** All 15 routes still
   carry station's decorators; 13 are abstained on, 2 are allowed by
   `publicKeys`. The full blackbox suite must pass **unchanged**. If anything
   403s here, `interop` is misconfigured — stop, do not proceed to step 1.
1. `/me` routes.
2. Read-only Organization routes (`members`, `invitations`, `roles`,
   `role-grants`, `audit-entries`).
3. `GET /organizations/:organizationId/projects` — the first query-plan route.
4. `GET /organizations` — the batched-check route.
5. Grant management (`POST`/`DELETE .../role-grants`).
6. `POST /organizations` — instance scope, last.

```bash
pnpm --filter=@station/api test
pnpm contracts:generate
git diff --exit-code packages/api-client openapi.json
curl -sf localhost:3001/health          # step 0, and after every deploy in this phase
```

**Gate per step:** the blackbox cases touching the migrated routes pass, **and**
the cases touching every route that has *not* migrated pass unchanged — the
second half is the one that proves abstention is still holding the rest of the
surface. Divergence counter stays zero with `shadow` (both modes run in CI until
S10).

**Rollback is per route, not per deploy.** Put station's decorator back and take
the library's off: the legacy guard resumes enforcing that endpoint, and nothing
else in the application changes. `STATION_AUTHZ_ENGINE=legacy` remains the
deploy-wide rollback for shadow mode and the S8 call sites, but un-migrating one
endpoint no longer needs it.

---

## S8 — query plans

| | |
|---|---|
| **Create** | `packages/database/src/authorization-mappings.ts` |
| **Modify** | `packages/database/src/projects.ts` — `authorizationFilter?: SQL` (diff at the bottom of the mappings file) |
| **Modify** | `packages/database/src/index.ts` |
| **Modify** | `apps/api/src/tenancy/tenancy.service.ts` — `listProjects` via `planToSql`, `listOrganizations` via `checkMany` |
| **Modify** | `apps/api/src/tenancy/tenancy.controller.ts` — `@QueryPlan()` instead of `@CurrentAuthorization()` |

`listOrganizations` today runs one `resolveMemberAuthorization` transaction per
candidate Organization (`tenancy.service.ts:53-77`). It becomes one
`withIdentityContext` read of the memberships plus one `checkMany` across scopes.
**Keep the loop shape** so the diff stays reviewable.

```bash
pnpm --filter=@station/api test
pnpm database:test
```

**Gate:** `GET /organizations/:organizationId/projects` returns *exactly* the
same rows before and after, for both grant shapes — an org-wide grant and a
project-scoped one. The blackbox case `'confines a project-scoped grant to its
Project while an org-wide grant reaches all'` is the one that proves it, and
`'confines a project-scoped custom-Role grant created through the API'` proves
the projection path too.

**Rollback:** the legacy `projectIds` branch stays until S10; revert the service
diff.

---

## S9 — Better Auth `organizationHooks`

| | |
|---|---|
| **Modify** | `apps/api/src/auth/identity.module.ts` — `canManageInvitations` via `permissionsService.check` (diff in `files/api/guard-swap.md` § S9) |

Note drift D-3: this is **not** `auth.module.ts`, which no longer exists.

```bash
pnpm --filter=@station/api test    # apps/api/src/auth/invitations.blackbox.test.ts
```

**Gate:** `invitations.blackbox.test.ts` passes unchanged, including the case
where a non-Member gets Better Auth's own `FORBIDDEN` (not station's RFC 9457
envelope — ADR-0014 keeps the mount outside it).

**Rollback:** revert one function body.

---

## S10 — delete the legacy engine

**Irreversible.** Only after the cutover has been stable in production and the
`legacy` flag value is no longer wanted.

Full delete/keep list in `files/api/guard-swap.md` § S10. Headlines: delete
`permission.guard.ts` (+ its 406-line test, rewritten not ported),
`require-permission.decorator.ts`, `route-authorization.audit.ts`,
`current-authorization.decorator.ts`, the five evaluation functions in
`packages/platform/src/authorization.ts`, and `ShadowAuthorizationService`.
Keep `roles`/`role_permissions`/`role_grants`, the whole OpenAPI contract,
`AuthorizationService.resolveMemberAuthorization`, `OperatorsService`, the
advisory lock, and ADR-0004.

```bash
pnpm check                        # lint + typecheck + test + build + dependencies:check + authz:drift
pnpm contracts:generate
git diff --exit-code packages/api-client openapi.json
```

**Gate:** `pnpm check` green with `STATION_AUTHZ_ENGINE` removed from the
environment schema entirely, and the contract diff empty.

---

## Total, and where the time actually goes

The design estimates ≈13.5 days. The staged artifacts do not change that, but
they move the risk, and the library's station-readiness fixes moved it again:

- S1 and S6 are *decisions* whose duration is not engineering time. Unchanged.
- **S5 is no longer the step most likely to expand.** Its `validatePolicies`
  gate was the one that could have sent you back to S4 to reshape every Role
  template by resource-type group; that question is now answered upstream
  (§ "One template per Role"), and the answer is that the staged shape is
  correct. What is left at S5 is wiring, and three constraints to hold rather
  than a design to redo.
- **S7 got cheaper and safer.** It was a 15-route dual-decoration commit whose
  first step had to land `@Public()` on two controllers or take `/health` down.
  With `interop` it is a guard registration with *zero* route edits, followed by
  one-line replacements you can stop after at any point, each independently
  reversible without a deploy.
- The residual risk is concentrated in S3/S4 now: the `extraTableConfig` entries
  actually landing in the migration (drift D-15 — a missing `CREATE POLICY` is
  silent), and the projection's Cedar JSON staying condition-free (§ "One
  template per Role", constraint (a)). Both are cheap to assert and expensive to
  discover later. Budget S3 for the assertion work the old plan spent on S5.
