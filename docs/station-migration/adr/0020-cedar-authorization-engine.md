# Cedar is the authorization engine; Permissions and Role grants are unchanged

> **Status: proposed.** This ADR needs a security sign-off before S1 is
> complete — specifically on the `permission_scope_versions` row-level-security
> carve-out below, which is the one item in this migration that weakens a
> standing invariant. Delete this blockquote on acceptance; station's ADRs carry
> no status line once accepted.

> **Numbering.** The design document calls this ADR-0019. That number is taken:
> `docs/adr/0019-framework-free-cores-concern-specific-nest-adapters.md` landed
> in the working tree after the design was written. This is **0020**. Rename the
> file and every reference if a different number is assigned before merge.

Station keeps atomic Permissions and configurable Role bundles exactly as
ADR-0004 defines them, and replaces the *evaluation* of those Permissions with
Cedar — AWS's formally verified policy language — through the `@nestm/permissions`
family. `packages/contracts`' two closed Zod enums stay the single source of
truth for the Permission catalog; the Cedar vocabulary in
`packages/platform/src/authorization/vocabulary.ts` is a projection of them, and
a CI test fails the build if the two diverge. `roles`, `role_permissions` and
`role_grants` keep their schemas, their API contract and their generated client
unchanged; each `roles` row also gains a Cedar **template** and each `role_grants`
row a Cedar **template link**, written in the same database transaction as the
row they project.

We chose this over keeping the hand-written evaluator because the two capabilities
Station needs next are the two the hand-written evaluator cannot grow into: a
grant that reaches everything *under* a Project (Runs, Gates, Artifacts — none of
which the current literal `:projectId` match can see), and list endpoints that
push authorization into SQL rather than materialising an id set in application
memory. Both fall out of Cedar's transitive `in` and its partial evaluation, and
both would otherwise be a second bespoke engine.

## Consequences

- **`packages/platform` may depend on `@nestm/permissions-core`.** It is
  NestJS-free, has one Apache-2.0 dependency, and satisfies both existing
  `dependency-cruiser` rules (`framework-free-packages-do-not-import-nest` and
  `platform-does-not-import-database-infrastructure`) without a config change.
  It imports the `@nestm/permissions-core/vocabulary` **subpath**, not the
  package barrel: that entry is the schema-authoring surface alone and is pure
  TypeScript, so `packages/web`'s transitive graph never reaches the engine, the
  plan compiler, the policy-store SPI or the 4.1 MiB WASM. The vocabulary
  builder performs no Cedar work either.
- **One Cedar template per Role, spanning resource types, with three
  constraints.** A Role's template names every action the Role grants, even
  though those actions declare different resource types
  (`organization:read` on `Organization`, `run:read` on `Run`). Cedar accepts
  this — verified at station's real width, 25 actions across 5 declared resource
  types, validating with zero errors and zero warnings — and links to it
  evaluate correctly, because a template's `resource in ?resource` scope is a
  **hierarchy** test, not a type test: Cedar resolves `Run::"r1" in
  Organization::"o1"` through the entity graph. Splitting per resource type
  produces identical decisions and differs only in which link id is reported as
  determining, so the one-template form saves N−1 rows per grant and costs
  nothing observable. The three constraints are the price, and all three are the
  same statement — the scope of such a template is permissive, so nothing about
  a specific resource type may leak into it:
  1. **no resource-attribute `when` condition.** The condition is typechecked
     against the *union* of every named action's declared resource type, so a
     `when` over an attribute only some of them declare is a validation error. A
     Role needing one needs its own, narrower template.
  2. **a link whose `?resource` makes every named action unreachable is
     rejected**, and reported against the *link's* id rather than the
     template's. One reachable action is enough to pass.
  3. **`validateRequests` stays on** — see the next entry. It is not a tuning
     knob here, it is what makes points 1 and 2 the *only* constraints.
- **`validateRequests: true` is a security invariant of this design, not a
  default we happen to keep.** It is the only thing that stops a schema-invalid
  action/resource pairing being *allowed*. With it off,
  `check({ action: 'project:manage', resource: Run::"r1" })` under an org-wide
  link returns **allow** — the template's permissive scope matches and Cedar
  never consults the schema; with it on, the same call is refused because
  `Station::Run` is not a valid resource type for that action. Turning it off
  converts every one-template-per-role grant from "25 actions, each on its own
  declared resource type" into "25 actions on **any** resource type in the
  Organization", silently, for every tenant at once, with no error and no failing
  test. It is asserted in CI rather than left to the library's default.
- **Cedar's `in` is transitive and reflexive, so a project-scoped grant reaches
  entities under its Project.** This is an intended widening on a security
  boundary, not an implementation detail. It is shipped behind shadow mode, and
  it is accepted with an explicit test rather than by observing that nothing
  broke — today no route guards an entity below a Project, so the widening has
  no reachable effect until one does.
- **`role_grants` remains the source of truth.** `permission_policy_links` is a
  projection with a composite `ON DELETE CASCADE` foreign key back to it, so a
  link cannot outlive its grant; `scripts/assert-authz-projection.mjs` proves the
  other direction in CI. The `pg_advisory_xact_lock` last-administrator
  protection is untouched, because the projection write happens inside the same
  transaction the lock already guards.
- **403-versus-404 (ADR-0014) is preserved without a new Permission.** The 404
  is a principal-*resolution* outcome — "this authenticated identity has no
  `members` row in this Organization" — surfaced as the library's `NOT_IN_SCOPE`
  and mapped back to Station's constant-detail `NotFoundException`. Cedar is
  never asked, so no policy and no action can accidentally make a non-Member's
  response distinguishable from an unknown Organization's.
- **Instance-scoped Permissions do not become policy data.** Operators
  (ADR-0015) stay a global table with no Organization context and no RLS; the
  instance policy scope is served by an in-memory store holding one code-owned
  policy, and Group membership arrives as an entity, not a grant. No schema
  change, no ADR-0015 amendment.
- **`permission_scope_versions` ships without row-level security.** This is the
  carve-out, and it is the reason this ADR needs a sign-off. The invalidation
  poller runs `SELECT organization_id, updated_at FROM permission_scope_versions
  WHERE updated_at > $1` with no Organization context, because it cannot know
  which tenants changed until it reads; under RLS that predicate is NULL for
  every row, the poller sees nothing, and a revoked grant stays effective on
  every replica but the one that performed it. The table holds no Organization
  *data* — one monotonic counter keyed by an Organization id the application role
  already knows for every tenant it serves. SECURITY.md's rule is that a schema
  change introducing Organization-scoped **data** must add equivalent RLS
  policies; this introduces none. What one tenant can learn is "something changed
  in Organization X", and nothing else: not what changed, not who, not whether
  they have access. `permission_policies` and `permission_policy_links` are
  FORCE RLS with the standard isolation predicate, and the foreign key still
  cascades a deleted Organization's counter away. The alternatives were an
  "Organization context unset" SELECT policy mirroring the identity lens
  (a second lens to reason about, for a table with nothing to protect) and
  polling per Organization inside a context (N transactions per tick, rejected).
- **A policy set that cannot load is a 503, never an allow.** The engine refuses
  to serve rather than treating "no policies" as "no restrictions", and a failed
  invalidation poll leaves the cached policy set in place rather than clearing
  it: stale-but-known beats empty.
- **Authorization decisions become cacheable per Organization** rather than
  recomputed per request. A grant change converges on the writing replica
  immediately — `PermissionsService.invalidate(organizationScope(id))`, called
  after the grant's transaction commits — and on other replicas within the poll
  interval, currently 5 seconds. The invalidation is **per Organization**: the
  coarse alternative drops every tenant's cached policy set to publish one
  tenant's grant, which on a busy instance is a thundering herd against the
  policy store. The staleness window can never *widen* access beyond what was
  true before the change.
- **`cedar-wasm` is pinned exactly.** Cedar's partial-evaluation residual shapes
  are experimental and unversioned; the library exact-pins `4.12.0` and carries a
  non-blocking canary against `@latest`. Station inherits the pin. A regression
  there degrades list filtering — `check()` never depends on partial evaluation —
  so enforcement cannot silently weaken.

## Considered options

- **Keep `packages/platform/src/authorization.ts` and extend it.** Rejected. The
  transitive reach and the SQL pushdown are each a small engine; writing both
  by hand means owning the soundness argument for both, and the failure mode of
  getting the pushdown wrong is returning rows the caller may not see.
- **Cerbos or OPA as a sidecar.** Rejected. Both add a process and a network hop
  to a decision that currently costs a single indexed query, and neither has a
  NestJS integration. Station's isolation story is "the database is the second
  wall"; a policy engine that cannot compile a `WHERE` clause leaves list
  endpoints exactly where they are.
- **Cedar, but as the storage format only, with Station's own evaluator.**
  Rejected: it keeps the part that is expensive to get right and discards the
  part that is free.
- **One template per Role *per resource type*** (`role:<id>:organization`,
  `role:<id>:project`, …). Rejected on evidence rather than on taste: it was the
  contingency in case Cedar's validator refused a template naming actions with
  differing declared resource types, and Cedar does not refuse it. The two shapes
  produce identical decisions and differ only in which link id is reported as
  determining, so the split buys nothing and costs N−1 extra rows per grant plus
  a fan-out in every write path and both backfill scripts.
- **Cut over in one change.** Rejected. Shadow mode costs one environment
  variable and one service, and it converts "we believe the two engines agree"
  into a number that has to be zero.
- **Dual-decorate every route for the cutover.** Rejected, and superseded. The
  original plan was to carry both guards' decorators on all 15 routes in one
  commit and let an environment variable choose which guard was authoritative.
  The library's `interop` option makes that unnecessary: `declaredKeys` makes
  `PermissionsGuard` **abstain** on a route declared by Station's existing
  decorator — returning `true` without resolving a principal or checking
  anything, so the legacy guard remains the one enforcing it — and `publicKeys`
  makes it honour Station's `@Public()` directly. Routes therefore migrate one
  at a time, by replacing a decorator rather than adding one, and each is
  independently reversible without a deploy.

## Rollback

`STATION_AUTHZ_ENGINE` selects the engine for shadow mode and the query-plan call
sites: `legacy` (today), `shadow` (legacy decides, Cedar compares), `cedar`
(Cedar decides). The legacy path stays compiled and covered by CI until S10, so
rollback at any earlier phase is an environment change.

During the guard cutover the finer-grained rollback is **per route**: restore
Station's decorator and remove the library's, and `interop`'s abstention puts
that endpoint back under the legacy guard with nothing else affected. Backing out
the whole phase is removing `PermissionsGuard` from `ApiSecurityModule`.

Before cutover, the additive schema is reversible by dropping three tables and
one constraint (`drizzle/0004_cedar-policy-store.sql` carries the statements in a
comment block); after cutover it is not, and the environment flag plus the
per-route decorator swap are the rollback.
