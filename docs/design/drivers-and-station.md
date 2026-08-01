> Verified live for this plan: `typeorm@1.1.0` is npm `latest` (0.3.31 is dist-tag `legacy`); it ships dual ESM (`index.mjs`), `engines.node ^20.19 || ^22.13 || >=24.11`, and still exports `Brackets`, `EntitySchema`, `EntityMetadata.findColumnWithPropertyPathStrict`, `WhereExpressionBuilder.andWhere(Brackets)`. `drizzle-orm@0.45.2` exports `and/or/not/inArray/like/isNull/isNotNull/arrayContains` — and `and()`/`or()` return `SQL | undefined`. `drizzle-kit@0.31.10`'s `prepareFromExports` iterates `Object.values(moduleExports)` and keeps values passing `is(v, PgTable)` — so factory-produced tables must be spread into **top-level named consts**, not nested in one object. Station's `dependency-cruiser.config.mjs` contains **only** a `no-circular` rule.

# `@nestm/permissions-typeorm` + `@nestm/permissions-drizzle` + station migration

## 0. Core SPI deltas (things `design-core.md` must accommodate)

These are the only places I diverge from `/private/tmp/.../design-core.md`. Each is small and each is load-bearing.

| # | Delta | Why |
|---|---|---|
| D1 | **`watch()` owns freshness; the engine must not call `currentVersion()` on the check path.** Core §3 says "if absent or version stale" without saying how staleness is detected. A DB round-trip per `check()` destroys the 0.136 ms number. Contract: when a store provides `watch`, the engine trusts its cache until an event arrives; `currentVersion` is used only at cold load and in `warm()`. | perf |
| D2 | **`load(scope)` returns the *effective* bundle (global `''` ∪ scope), and `PolicyChangeEvent` may carry `scope: '*'`.** A global-template change must invalidate every cached scope. `PolicyBundle.version` becomes a composite string (`g<n>:s<m>`). The driver detects id collisions between global and scope policies and **throws** (fail-closed) rather than letting one shadow the other. | correctness |
| D3 | **`defineVocabulary` must not eagerly load WASM.** Core §2 runs `checkParseSchema` at definition time. Station wants the vocabulary in `packages/platform`, which `packages/web` transitively reaches. Move validation to `vocabulary.validate()` / `PermissionsEngine.create()`. | bundle size |
| D4 | **Ship `CompositePolicyStore`** (`scopedStore({ 'instance': memoryStore, '*': dbStore })`) in core. Station needs a code-owned static policy set for instance scope alongside a DB store for org scopes; this is framework-free and belongs in core, not duplicated in both drivers. | reuse |
| D5 | **Export pure AST utilities from core** (`@nestm/permissions-core` barrel or a `./plan` subpath): `walkPlanNode`, `likeTokensToPattern(tokens, { escapeChar })`, `planValueKindOf`, `assertOrderable(value)`. Both drivers need identical LIKE-escaping and value-kind logic; duplicating the escaping is how you get a `%`-injection bug in exactly one driver. | correctness |
| D6 | **`TemplateLinkRecord.values` must tolerate a missing `?resource`** (some templates only parameterise `?principal`). Type it `Partial<Record<'?principal'\|'?resource', EntityRef<string>>>` with a runtime check against the template's declared slots. | fidelity |
| D7 | **`evaluatePlanNode` (core `./testing`) must expose a `HierarchyResolver` seam** — already in the signature; I'm pinning that it must be **required** whenever the node tree contains `inHierarchy`, and must throw when unresolvable. That's what makes the drivers' differential tests meaningful. | testability |

Delta to the **NestJS** slice (`design-nest.md`): `PrincipalResolver.resolve()` must be able to return `{ kind: 'not-in-scope' }` distinctly from `null`. Station's 404-vs-403 hinges on "authenticated identity that is not a Member of this org", which is an *entity-resolution* outcome, not a Cedar decision. See §4d.

---

## 1. Storage schema — one logical model, two physical bindings

Three tables. Names are configurable via a `tablePrefix` (default `permission_`).

**`permission_policies`** — static policies *and* templates (Cedar treats a template as a policy with `?principal`/`?resource` slots; one table keeps "list everything in this scope" a single query).

| column | type | notes |
|---|---|---|
| `scope` | scope-column (see below) | `''` = global |
| `policy_id` | `text` | Cedar policy id; **PK = (scope, policy_id)** |
| `kind` | `text` | `CHECK IN ('static','template')` |
| `cedar_json` | `jsonb` | canonical persisted form (core §3) |
| `cedar_text` | `text` NULL | denormalised `policyToText` output, for the admin UI/diffs only — never parsed back |
| `description` | `text` NULL | |
| `annotations` | `jsonb` NOT NULL DEFAULT `'{}'` | |
| `enabled` | `boolean` NOT NULL DEFAULT true | |
| `created_at` / `updated_at` | `timestamptz` | |

Indexes: `(scope) WHERE enabled` (the load path), `GIN (cedar_json jsonb_path_ops)` (answering "which policies mention `Run`?" for the admin API).

**`permission_policy_links`** — template links; the role-grant primitive.

| column | type | notes |
|---|---|---|
| `scope` | scope-column | |
| `link_id` | `text` (uuid in station) | Cedar `newId`; **PK = (scope, link_id)** |
| `template_id` | `text` | composite FK → `permission_policies(scope, policy_id)` `ON DELETE CASCADE` |
| `principal_type` / `principal_id` | `text` / `text` | **columns, not JSON** |
| `resource_type` / `resource_id` | `text` NULL / `text` NULL | NULL pair = template has no `?resource` (D6) |
| `created_at` / `updated_at` | `timestamptz` | |

Index: `(scope, principal_type, principal_id)`. Storing the slot values as columns (rather than a `values jsonb`) is what makes "revoke every grant for member X" and "who holds this role?" plain indexed statements — exactly station's `role_grants` access pattern.

**`permission_scope_versions`** — the invalidation stamp. `scope` PK, `version bigint NOT NULL DEFAULT 1`, `updated_at timestamptz NOT NULL`, plus `INDEX (updated_at)`.

Every write bumps its scope row **in the same transaction**:
```sql
INSERT INTO permission_scope_versions (scope, version, updated_at) VALUES ($1, 1, now())
ON CONFLICT (scope) DO UPDATE SET version = permission_scope_versions.version + 1, updated_at = now();
```
Monotonic, clock-skew-immune, and `currentVersion(scope)` is two PK reads (`scope IN ('', $s)`) composed into `g<n>:s<m>` (D2).

**Optional `permission_principal_groups`** (`scope, child_type, child_id, parent_type, parent_id`) ships behind `groups: { enabled: true }`, default **off**. Greenfield apps get memberships for free; station keeps its own `members`/`operators` and supplies an `EntityProvider` instead.

**Multi-tenant / scope-column strategy.** The single most important schema decision: the scope column is **supplied by the consumer**, not fixed. Both drivers expose a schema *factory* taking:
```ts
interface ScopeColumnOptions<TValue> {
  readonly name: string;                                   // 'scope' | 'organization_id'
  readonly toScope: (value: TValue) => PolicyScopeId;      // uuid -> 'org:<uuid>' (or identity)
  readonly fromScope: (scope: PolicyScopeId) => TValue;    // inverse; throws on the global scope when unsupported
  readonly supportsGlobalScope?: boolean;                  // default true; false for a NOT NULL uuid column
}
```
When `supportsGlobalScope: false` (station: `organization_id uuid NOT NULL` with an FK), the store rejects writes to `''` and `load(scope)` skips the global union — the app must seed per-tenant templates instead. This is what makes the tables droppable straight into station's RLS regime with no `NULL`-tenant escape hatch.

**Invalidation mechanism — v1 pick: version-stamp polling + synchronous local invalidation, with LISTEN/NOTIFY opt-in.**
- The store's own `save`/`delete`/`linkTemplate`/`unlinkTemplate` emit a `PolicyChangeEvent` **synchronously after commit** → zero staleness for the writing replica.
- `watch()` starts a poller (default 5000 ms) issuing **one** query regardless of tenant count: `SELECT scope, version FROM permission_scope_versions WHERE updated_at > $lastSeen` → emits one event per changed scope. Cost is O(changed scopes), not O(cached scopes).
- `notify: { channel: 'nestm_permissions' }` (Postgres only, both drivers) switches to `LISTEN/NOTIFY` on a **dedicated non-pooled connection**; documented as requiring a connection outside the app pool. Not the default because station's client pool assumes `station_app` at connect time.

Rejected: an in-process bus alone (useless across replicas); `currentVersion` on the hot path (D1).

---

## 2. Driver SPI implementation

Both packages implement core's `PolicyStore` verbatim, plus `watch`. Shared contract:
```ts
export interface PolicyStoreDriverOptions {
  readonly tablePrefix?: string;                 // default 'permission_'
  readonly scopeColumn?: ScopeColumnOptions<unknown>;  // default { name: 'scope', identity mapping }
  readonly poll?: { intervalMs?: number } | false;     // default { intervalMs: 5000 }
  readonly notify?: { channel: string };               // opt-in LISTEN/NOTIFY
  readonly onError?: (error: unknown) => void;         // poller failures must not crash the process
}
```
Fail-closed rules identical in both: a `load()` that throws propagates (the engine then refuses to serve — the Nest module's `assertReady()` yields 503, never "no policies ⇒ allow"); a poller failure logs and **retries with backoff without touching the cache** (stale-but-known beats empty).

### TypeORM
```ts
export function createPermissionsEntities(o?: PolicyStoreDriverOptions): {
  readonly policy: EntitySchema<PolicyRow>;
  readonly link: EntitySchema<LinkRow>;
  readonly scopeVersion: EntitySchema<ScopeVersionRow>;
};
export class TypeOrmPolicyStore implements PolicyStore {
  constructor(dataSource: DataSource, o?: PolicyStoreDriverOptions);
}
```
**`EntitySchema`, not decorated classes** — consumers are not forced to enable `experimentalDecorators`, the tables stay renameable at runtime, and it sidesteps the family's `design:paramtypes` fragility entirely. Trade-off: users expecting `@Entity()` classes get a factory call instead; `dataSource.getRepository(entities.policy)` is fully typed, so the DX cost is one line.

**Migrations story — consumers run their own, we make that trivial.** Three tiers, in order of preference:
1. Register `createPermissionsEntities()` in `DataSource.entities` and run `typeorm migration:generate` — zero code from us, standard flow, documented as the recommended path.
2. `buildPermissionsMigration(o & { dialect: 'postgres' | 'mysql' | 'sqlite' }): { up: string[]; down: string[] }` — returns raw statements so consumers can hand-append `GRANT`/RLS before committing.
3. `PermissionsInitialMigration(o)` — a factory returning a class implementing `MigrationInterface`, droppable into `migrations: [...]` for consumers who want it managed.

All writes go through `dataSource.transaction()`; the version bump is in the same transaction as the policy write (§1). RLS compatibility: nothing in the driver issues `SET`/`SET LOCAL`, so a consumer wrapping calls in their own tenant-context transaction works — but see the **`permission_scope_versions` caveat** in §4e, which is the one place RLS and the poller genuinely conflict.

### Drizzle
```ts
export function createPermissionsSchema<TScope>(o: {
  tablePrefix?: string;
  scopeColumn: { name: string; column: () => PgColumnBuilderBase; ... };
  extraColumns?: Record<string, PgColumnBuilderBase>;
  extraTableConfig?: (tables: RawTables) => Record<'policies'|'links'|'scopeVersions', unknown[]>;
}): { permissionPolicies; permissionPolicyLinks; permissionScopeVersions };

export class DrizzlePolicyStore implements PolicyStore {
  constructor(db: NodePgDatabase<any>, schema: PermissionsSchema, o?: PolicyStoreDriverOptions);
}
```
`extraTableConfig` is the RLS seam: it receives the built columns and returns the extra `pgTable` config entries — `pgPolicy(...)`, `foreignKey(...)`, `index(...)`. Station passes its isolation policy through it and gets a table indistinguishable from a hand-written one. **drizzle-kit flow (verified):** consumers must spread the factory result into top-level consts —
```ts
export const { permissionPolicies, permissionPolicyLinks, permissionScopeVersions } =
  createPermissionsSchema({ /* … */ })
```
because `prepareFromExports` only sees `Object.values(module)` entries that pass `is(v, PgTable)`. Nesting them in one exported object silently produces an empty migration. This goes in the README in bold.

Then `drizzle-kit generate` produces the SQL, and the consumer hand-appends `GRANT`/`FORCE ROW LEVEL SECURITY` exactly as station does in `packages/database/drizzle/0003_audit-trail.sql:18-19`. `permissionsPostgresPolicyStatements(o)` returns those extra strings so it's copy-paste, not archaeology.

---

## 3. Query-filter compilers

### Public API

```ts
// @nestm/permissions-drizzle
export function planToSql<R extends string>(plan: QueryPlan<R>, mapping: DrizzleResourceMapping<R>): SQL;
export function applyPlan<Q extends PgSelectBase<any, any, any>>(query: Q, plan: QueryPlan<any>, mapping): Q;

// @nestm/permissions-typeorm
export function planToBrackets<R extends string>(plan: QueryPlan<R>, mapping: TypeOrmResourceMapping<R>, o?: { parameterPrefix?: string }): Brackets;
export function applyPlan<E>(qb: SelectQueryBuilder<E>, plan: QueryPlan<any>, mapping, o?): SelectQueryBuilder<E>;
```
`planToSql`/`planToBrackets` are the **primitives** and they always return a total boolean expression — `ALWAYS_ALLOW → TRUE`, `ALWAYS_DENY → FALSE`, `CONDITIONAL → condition`. There is deliberately **no** API that can return "nothing" for a plan, because "nothing" concatenated into a query is `WHERE` omitted, which is every row. `applyPlan` is sugar over it.

### Mapping DSL

```ts
interface DrizzleResourceMapping<R extends string> {
  readonly resourceType: R;
  readonly table: PgTable;
  readonly id: PgColumn;
  readonly attributes: Readonly<Record<string, DrizzleAttributeMapping>>;
  readonly hierarchy?: Readonly<Record<string, DrizzleHierarchyMapping>>;  // key = parent entity type
  readonly text?: { escapeChar?: string; collation?: 'exact' | 'case-insensitive' };
}
type DrizzleAttributeMapping =
  | { kind: 'scalar';  column: PgColumn; valueKind: 'string'|'long'|'bool'|'datetime'|'duration'|'decimal' }
  | { kind: 'entity';  column: PgColumn; entityType: string }     // column stores the id of that type
  | { kind: 'array';   column: PgColumn; elementKind: … }         // pg array
  | { kind: 'jsonPath'; column: PgColumn; path: readonly string[]; valueKind: … };
type DrizzleHierarchyMapping =
  | { kind: 'self' }                                              // parent type == resource type
  | { kind: 'column'; column: PgColumn }                          // denormalised ancestor id (station's shape)
  | { kind: 'closure'; table: PgTable; ancestor: PgColumn; descendant: PgColumn }
  | { kind: 'recursive'; parentColumn: PgColumn; idColumn: PgColumn };
```
TypeORM's equivalent uses **property paths resolved through `EntityMetadata.findColumnWithPropertyPathStrict`** rather than raw strings — a typo is a hard error at compile time of the query, and the emitted identifier comes from `qb.escape(column.databaseName)`, never from user input. That resolution step is exactly what `@ucast/sql/typeorm@0.2.0` does (`findRelationWithPropertyPath`); **study it, do not depend on it** — it is 0.2.0/11.9k dl-wk, drags `@ucast/core@2.0.0`, and its AST has no tokenised `LIKE`, no `inHierarchy`, and no three-state plan. Vendor it under `references/ucast-sql/` per the family convention and cite in the README.

### AST → SQL mapping table

| `PlanNode` | Drizzle (Postgres) | TypeORM |
|---|---|---|
| `true` / `false` | `sql\`true\`` / `sql\`false\`` | `1 = 1` / `1 = 0` |
| `and[]` | `allOf()` → `and(...)`, **empty ⇒ `true`** | `new Brackets(qb => …andWhere)`, empty ⇒ `1=1` |
| `or[]` | `anyOf()` → `or(...)`, **empty ⇒ `false`** | `new Brackets(qb => …orWhere)`, empty ⇒ `1=0` |
| `not` | `not(x)` | `NOT (…)` |
| `cmp eq/ne` scalar | `eq/ne(col, bind)` | `col = :p` / `col <> :p` |
| `cmp eq/ne` entity | assert `value.type === attributeMapping.entityType`; mismatch folds to `false`/`true` (a different type can never equal this column) | same |
| `cmp lt/lte/gt/gte` | `lt/lte/gt/gte`; **`valueKind: 'string'` ⇒ throw** (Cedar has no string ordering, so any string comparison is a mapping bug) | same |
| `in` | `inArray(col, binds)`; empty ⇒ `false` | `col IN (:...p)`; **empty ⇒ `1=0`** (TypeORM emits invalid SQL for an empty `IN`) |
| `contains` (array col) | `arrayContains(col, [v])` → `col @> ARRAY[$1]` | `col @> ARRAY[:p]` |
| `contains` (jsonb col) | `sql\`${col} @> ${JSON.stringify([v])}::jsonb\`` | same, parameterised |
| `like` | `like(col, $pattern) ESCAPE $escape` — both bound | `col LIKE :p ESCAPE :e` |
| `exists` | `isNotNull(col)` | `col IS NOT NULL` |
| `isEmpty` | array: `coalesce(array_length(col,1),0) = 0`; jsonb: `jsonb_array_length(col) = 0` | same |
| `isType` | folded in core; if it arrives: `true` iff `=== mapping.resourceType`, else `false` | same |
| `inHierarchy{attr:null}` | `self` ⇒ `eq(id, $p)`; `column` ⇒ `eq(col, $p)`; `closure` ⇒ `EXISTS (SELECT 1 FROM closure WHERE descendant = id AND ancestor = $p)`; `recursive` ⇒ `EXISTS` over a `WITH RECURSIVE` CTE | same |
| `inHierarchy{attr}` | resolve `attr` to an `entity`-kind column, then apply the mapping rooted at that column | same |

**Cedar `in` is reflexive** — `X in X` is true. So `inHierarchy` over a parent whose type equals the resource type must compile to `id = $p`, not `parent_col = $p`. That's the `{ kind: 'self' }` case, and getting it wrong is a silent over-block on the very query station cares about.

### Fail-closed contract (README, verbatim)

> `planToSql` / `planToBrackets` compile **exactly** the `PlanNode` grammar. Anything a mapping does not cover raises a `PlanCompilationError` before any SQL is produced. There is no configuration in which an uncompilable node becomes `TRUE`.

Concretely, each of these **throws** (never degrades): unmapped attribute (`UnmappedAttributeError`), unmapped hierarchy parent type (`UnmappedHierarchyError`), ordering comparison on a `string` mapping, `contains` on a scalar column, entity comparison against a non-entity column, and `mapping.text.collation === 'case-insensitive'` under a `like` node (a `citext`/ICU-nondeterministic column makes SQL `LIKE` case-insensitive while Cedar's is case-sensitive — silent over-match). The plan's own `approximations[]` (permissive direction) are re-checked at compile time and throw unless the caller passed `allowPermissiveApproximations: true` **and** the plan carries a `postFilter`.

**NULL analysis, which is why this is safe at all.** The assembled condition is `OR(permits) AND NOT(OR(forbids))`. SQL three-valued logic makes any NULL-touching subterm propagate to NULL, and a top-level NULL excludes the row. Under this shape that is *uniformly restrictive*: NULL inside a permit ⇒ row dropped; NULL inside a forbid ⇒ `NOT NULL` = NULL ⇒ row dropped. So a nullable column mapped to a Cedar optional attribute is fail-closed by construction — which also matches Cedar semantics, where reading an absent attribute errors the policy into `false`. **Consequence for implementers: never wrap the compiled condition in `COALESCE(…, true)` and never use `NOT IN` against a nullable subquery.** Both get an explicit oxlint-visible comment and a test.

**Other pinned gotchas.** `and()`/`or()` in drizzle return `SQL | undefined` — internal `allOf`/`anyOf` helpers never call them with an empty list, and a unit test asserts `planToSql` never returns `undefined` for any node. `PlanValue.long` is a `bigint`: bind as `value.toString()` with an explicit `::bigint` cast (node-pg returns `int8` as string; passing a JS `bigint` through drizzle's serialiser is unreliable). `datetime` binds as an ISO string with `::timestamptz`. TypeORM parameters are QueryBuilder-global — names are `${prefix}_${n}` with `prefix` defaulting to `nestmp` and a counter seeded from `qb.expressionMap.parameters` so two `applyPlan` calls on one builder cannot collide.

### Testing

Three-way differential, per driver, against **real Postgres 16** — CI `services: postgres:16-alpine` (already in `design-nest.md`'s `test-drivers` job) plus a repo `compose.yaml` mirroring station's for local runs. Testcontainers is rejected for v1: an extra heavyweight devDependency for something a CI service and one compose file already give, and it does not match station's blackbox pattern.

1. **Differential soundness (flagship).** `fast-check` generates a policy set from the pushdown grammar + 50–200 fixture rows. Compute three sets: (a) brute-force `engine.check()` per row, (b) `evaluatePlanNode` over the same rows (core `./testing`, D7), (c) `SELECT id FROM t WHERE <compiled>` against real Postgres. **Assert all three are equal.** (b) vs (c) is what catches driver bugs; (a) vs (b) is core's job but re-running it here catches integration drift.
2. **LIKE fuzz** — random strings containing `%`, `_`, `\`, `*` through Cedar → tokens → SQL → Postgres, asserted against Cedar's own decision. This is the escaping trap.
3. **Fail-closed table** — every throwing case above, asserted as a thrown typed error, and a "no API returns undefined/empty where-clause" property test.
4. **Store conformance suite**, shared: one abstract spec exported from `@nestm/permissions-core/testing` run against `MemoryPolicyStore`, `TypeOrmPolicyStore` and `DrizzlePolicyStore` — load/save/delete/link/unlink, version monotonicity, cross-scope isolation, global∪scope union (D2), id-collision throw, poller emits exactly once per change.
5. **RLS harness** — a Postgres fixture reproducing station's shape (`NOLOGIN NOBYPASSRLS` role, `FORCE RLS`, `set_config` transaction-local) asserting the driver works under it and that a missing context yields zero rows, not a partial read.
6. **Injection corpus** — table/column/pattern values containing `'`, `--`, `;`, `%`, `\` asserted to round-trip as data.

---

## 4. Station migration plan

### 4a. Cedar schema sketch (`packages/platform/src/authorization/vocabulary.ts`)

```ts
export const stationVocabulary = defineVocabulary({
  namespace: 'Station',
  entities: {
    Instance:     {},
    Group:        {},                                            // Group::"operators"
    Identity:     { memberOf: ['Group'] },                       // id = JWT sub (IdentitySubject)
    Organization: {},
    Project:      { memberOf: ['Organization'], attrs: { organization: t.ref('Organization') } },
    Member:       { memberOf: ['Organization'], attrs: { organization: t.ref('Organization'),
                                                        identitySubject: t.string() } },
    Repository:   { memberOf: ['Project'] },
    Board:        { memberOf: ['Project'] },
    WorkItem:     { memberOf: ['Board'] },
    Workflow:     { memberOf: ['Repository'] },
    Run:          { memberOf: ['Project'], attrs: { status: t.string(), project: t.ref('Project') } },
    Gate:         { memberOf: ['Run'],     attrs: { status: t.string() } },
    Approval:     { memberOf: ['Gate'] },
    Artifact:     { memberOf: ['Run'] },
    Secret:       { memberOf: ['Project'] },
    AuditEntry:   { memberOf: ['Organization'] },
  },
  actions: {
    // instance scope (ADR-0015)
    'organization:create': { principal: ['Identity'], resource: ['Instance'] },
    // org-scoped
    'organization:read':   { principal: ['Member'], resource: ['Organization'] },
    'organization:manage': { principal: ['Member'], resource: ['Organization'] },
    'project:read':        { principal: ['Member'], resource: ['Project'] },
    'project:manage':      { principal: ['Member'], resource: ['Organization', 'Project'] },  // create ⇒ Organization
    'member:read':         { principal: ['Member'], resource: ['Organization'] },
    'member:manage':       { principal: ['Member'], resource: ['Organization'] },
    'role:read':           { principal: ['Member'], resource: ['Organization'] },
    'role:manage':         { principal: ['Member'], resource: ['Organization'] },
    'repository:read':     { principal: ['Member'], resource: ['Project', 'Repository'] },
    'repository:manage':   { principal: ['Member'], resource: ['Project', 'Repository'] },
    'board:read':          { principal: ['Member'], resource: ['Project', 'Board'] },
    'board:manage':        { principal: ['Member'], resource: ['Project', 'Board'] },
    'work-item:read':      { principal: ['Member'], resource: ['Board', 'WorkItem'] },
    'work-item:create':    { principal: ['Member'], resource: ['Board'] },
    'workflow:read':       { principal: ['Member'], resource: ['Repository', 'Workflow'] },
    'run:read':            { principal: ['Member'], resource: ['Project', 'Run'] },
    'run:dispatch':        { principal: ['Member'], resource: ['Project', 'Run'] },
    'run:cancel':          { principal: ['Member'], resource: ['Run'] },
    'gate:approve-product':   { principal: ['Member'], resource: ['Gate'] },
    'gate:approve-technical': { principal: ['Member'], resource: ['Gate'] },
    'gate:approve-quality':   { principal: ['Member'], resource: ['Gate'] },
    'secret:manage':       { principal: ['Member'], resource: ['Organization', 'Project', 'Secret'] },
    'artifact:read':       { principal: ['Member'], resource: ['Run', 'Artifact'] },
    'audit:read':          { principal: ['Member'], resource: ['Organization'] },
    'metrics:read':        { principal: ['Member'], resource: ['Organization'] },
  },
} as const)
```
Action ids are `permissionKeys` **verbatim** — the closed Zod enum in `packages/contracts/src/authorization.ts:14-42` stays the source of truth and `scripts/assert-contracts-clean.mjs` is untouched. A CI test asserts `ActionOf<typeof stationVocabulary>` equals `PermissionKey | InstancePermissionKey` exactly, so adding a permission to the enum without adding the action fails the build.

The `memberOf` chain is the upgrade: because Cedar `in` is transitive, a project-scoped grant reaches Runs/Gates/Artifacts under that Project automatically. Station today can only match a literal `:projectId` route param.

### 4b. Roles → templates, grants → links

One template per role (`roles` row), stored per organization:
```cedar
@id("role:admin")
@station_role_id("<roles.id>")
permit(
  principal == ?principal,
  action in [Station::Action::"organization:read", /* … the role_permissions bundle … */],
  resource in ?resource
);
```
- `roles` + `role_permissions` → one `permission_policies` row, `kind='template'`, `policy_id = 'role:' || roles.id`.
- `role_grants` → one `permission_policy_links` row, `link_id = role_grants.id` (reuse the uuid ⇒ idempotent backfill, and revoke is a delete by the same key). `?principal = Station::Member::"<member_id>"`; `?resource = Station::Organization::"<organization_id>"` for `scope='organization'`, `Station::Project::"<project_id>"` for `scope='project'`.
- The four seeded bundles (`defaultRoleBundles`, `authorization.ts:80-143`) become four templates written by `createDefaultRoleBundles` in the **same transaction** it already writes the four `roles` rows — no new seeding path.
- **Operators are not a table change.** Instance scope is a separate policy scope `'instance'` served by a `MemoryPolicyStore` (D4) holding one code-owned static policy:
  ```cedar
  @id("instance:operators-create-organization")
  permit(principal in Station::Group::"operators",
         action == Station::Action::"organization:create",
         resource == Station::Instance::"station");
  ```
  Group membership comes from an `EntityProvider` reading the existing global `operators` table. `operators` stays SELECT-only for `station_app`; no RLS problem; no ADR-0015 change.

**`role_grants` remains the source of truth**; `permission_policy_links` is a projection written in the *same database transaction* (same DB, so atomic — not a distributed dual-write). This preserves the "last administrator" `pg_advisory_xact_lock` protection in `packages/database/src/authorization.ts` and leaves the entire `RoleGrant`/`Role` OpenAPI contract — and therefore the generated web client — byte-identical. A `scripts/assert-authz-projection.mjs` drift check runs in CI.

### 4c. What replaces `packages/platform/src/authorization.ts`

- `buildMemberAuthorization` / `hasOrganizationPermission` / `hasProjectPermission` / `hasAnyPermission` / `permissionReach` → deleted at Phase 4. `permissionReach`'s `{organization} | {projects} | {none}` is precisely `ALWAYS_ALLOW | CONDITIONAL | ALWAYS_DENY` — a shape-preserving swap.
- `packages/platform` gains `authorization/vocabulary.ts`, `authorization/entities.ts` (`memberEntity()`, `projectEntity()` builders over core's typed `entity()`), and `authorization/mappings.ts` is **not** here — mappings reference drizzle columns, so they live in `packages/database/src/authorization-mappings.ts`.
- **dependency-cruiser correction:** the recon note said a rule change is needed. It is not — `dependency-cruiser.config.mjs` contains only `no-circular`, and `doNotFollow` excludes all npm dependency types. `packages/platform`'s "dependency-free by design" is an ADR/social constraint, not an enforced one. What is actually required is an **ADR amendment** (a new ADR-0019, "Cedar is the authorization engine") recording that `packages/platform` may depend on `@nestm/permissions-core` (zero NestJS deps, one Apache-2.0 dependency). Optionally *add* the enforcement while you're there:
  ```js
  { name: 'platform-stays-framework-free', severity: 'error',
    from: { path: '^packages/platform/src' },
    to: { dependencyTypes: ['npm'], pathNot: '^(@station/contracts|@nestm/permissions-core)$' } }
  ```
- D3 matters here: `packages/web` transitively reaches `packages/platform`, so `defineVocabulary` must not pull 4.1 MiB of WASM at import time.

### 4d. Guard swap

| station `@RequirePermission` scope | `@nestm/permissions` `ResourceRef` |
|---|---|
| `{kind:'organization'}` (default) | `{kind:'param', param:'organizationId', type:'Organization', parseAs: organizationIdSchema}` |
| `{kind:'project', parameter}` | `{kind:'param', param, type:'Project', parseAs: projectIdSchema}` |
| `{kind:'any'}` | `{kind:'unspecified', type:'Project'}` → query plan |
| `{kind:'membership'}` | `{kind:'unspecified', type:'Organization'}` + handler-side batched checks |
| `{kind:'instance'}` | `{kind:'literal', type:'Instance', id:'station'}`, engine scope `'instance'` |
| `RequireAuthenticated()` | `@RequireAuthenticated()` |

**404-vs-403 preserved exactly (ADR-0014).** The 404 is *not* a Cedar denial — it is "this authenticated identity has no `Member` row in this Organization", which today is `resolveMemberAuthorization` returning `null` (`permission.guard.ts:137-139`). Map it onto principal resolution: `StationPrincipalResolver` looks up `(organizationId, identitySubject) → Member`; absent ⇒ `{ kind: 'not-in-scope' }` (nest-slice delta) ⇒ `Denial{reason:'not-a-member'}` ⇒ `hooks.onDenied` returns station's `NotFoundException` with the constant detail. Member-present-but-Cedar-denies ⇒ `ForbiddenException`. No 26th action, no new policy, byte-identical bodies. The e2e assertion "unknown org body === non-member probe body" stays as-is.

**Guard-before-pipes** is preserved by `parseAs: organizationIdSchema` (Zod 4 implements Standard Schema natively) with `denial.onInvalidParam` throwing station's `ValidationException([{ pointer, detail }])` — same pointer, same detail strings as `permission.guard.ts:120-127` and `165-177`.

**Boot-time route audit.** Phase 2 runs both: station's `route-authorization.audit.ts` keeps reading `ROUTE_PERMISSION` (routes stay dual-decorated), and the library's audit runs with `routeAudit: { mode: 'error', additionalMetadataKeys: [ROUTE_PERMISSION] }`. Phase 4 deletes station's file and rewrites `route-authorization.audit.test.ts`. `pnpm contracts:generate` (which boots the app) keeps working throughout — that is the CI tripwire.

**Do not forget the non-guard path:** Better Auth's `organizationHooks` in `apps/api/src/auth/auth.module.ts:54-85` call `AuthorizationService` directly for `member:manage` on invitations (ADR-0016). That becomes `permissionsService.check(...)` and is covered by `auth/invitations.blackbox.test.ts`.

### 4e. New tables under station's RLS regime

`packages/database/src/schema.ts` gains, via the factory:
```ts
export const { permissionPolicies, permissionPolicyLinks, permissionScopeVersions } =
  createPermissionsSchema({
    scopeColumn: { name: 'organization_id', column: () => uuid('organization_id').notNull(),
                   toScope: (id) => `org:${id}`, fromScope: (s) => s.slice(4),
                   supportsGlobalScope: false },
    extraTableConfig: (t) => ({
      policies: [
        foreignKey({ name: 'permission_policies_organization_id_fk', columns: [t.policies.organizationId],
                     foreignColumns: [organizations.id] }).onDelete('cascade'),
        pgPolicy('permission_policies_isolation_policy', { as: 'permissive', for: 'all', to: 'public',
          using: sql`${t.policies.organizationId} = nullif(current_setting('station.organization_id', true), '')::uuid`,
          withCheck: sql`…same…` }),
      ],
      links: [ /* composite FK to (organization_id, policy_id) + isolation policy */ ],
      scopeVersions: [ /* FK to organizations; NO pgPolicy — see below */ ],
    }),
  })
```

`packages/database/drizzle/0004_cedar-policy-store.sql` (generated, then hand-appended exactly like `0003_audit-trail.sql:17-19`):
```sql
CREATE TABLE "permission_policies" (
  "organization_id" uuid NOT NULL, "policy_id" text NOT NULL, "kind" text NOT NULL,
  "cedar_json" jsonb NOT NULL, "cedar_text" text, "description" text,
  "annotations" jsonb DEFAULT '{}'::jsonb NOT NULL, "enabled" boolean DEFAULT true NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL, "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "permission_policies_pk" PRIMARY KEY ("organization_id","policy_id"),
  CONSTRAINT "permission_policies_kind_check" CHECK ("kind" IN ('static','template'))
);--> statement-breakpoint
ALTER TABLE "permission_policies" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "permission_policies" ADD CONSTRAINT "permission_policies_organization_id_organizations_id_fk"
  FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade;--> statement-breakpoint
CREATE INDEX "permission_policies_organization_enabled_index"
  ON "permission_policies" ("organization_id") WHERE "enabled";--> statement-breakpoint
CREATE INDEX "permission_policies_cedar_json_index"
  ON "permission_policies" USING gin ("cedar_json" jsonb_path_ops);--> statement-breakpoint
CREATE POLICY "permission_policies_isolation_policy" ON "permission_policies" AS PERMISSIVE FOR ALL TO public
  USING ("permission_policies"."organization_id" = nullif(current_setting('station.organization_id', true), '')::uuid)
  WITH CHECK (…same…);--> statement-breakpoint
ALTER TABLE "permission_policies" FORCE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE TABLE "permission_policy_links" (
  "organization_id" uuid NOT NULL, "link_id" uuid NOT NULL, "template_id" text NOT NULL,
  "principal_type" text NOT NULL, "principal_id" text NOT NULL,
  "resource_type" text, "resource_id" text,
  "created_at" timestamptz DEFAULT now() NOT NULL, "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "permission_policy_links_pk" PRIMARY KEY ("organization_id","link_id")
);--> statement-breakpoint
ALTER TABLE "permission_policy_links" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "permission_policy_links" ADD CONSTRAINT "permission_policy_links_template_fk"
  FOREIGN KEY ("organization_id","template_id")
  REFERENCES "public"."permission_policies"("organization_id","policy_id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "permission_policy_links" ADD CONSTRAINT "permission_policy_links_role_grant_fk"
  FOREIGN KEY ("organization_id","link_id")
  REFERENCES "public"."role_grants"("organization_id","id") ON DELETE cascade;--> statement-breakpoint
CREATE INDEX "permission_policy_links_principal_index"
  ON "permission_policy_links" ("organization_id","principal_type","principal_id");--> statement-breakpoint
CREATE POLICY "permission_policy_links_isolation_policy" … ;--> statement-breakpoint
ALTER TABLE "permission_policy_links" FORCE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE TABLE "permission_scope_versions" (
  "organization_id" uuid PRIMARY KEY,
  "version" bigint DEFAULT 1 NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "permission_scope_versions" ADD CONSTRAINT "permission_scope_versions_organization_id_fk"
  FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade;--> statement-breakpoint
CREATE INDEX "permission_scope_versions_updated_at_index" ON "permission_scope_versions" ("updated_at");--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "permission_policies", "permission_policy_links" TO "station_app";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "permission_scope_versions" TO "station_app";
```
Note `role_grants` needs `UNIQUE(organization_id, id)` for that composite FK — add it in the same migration (it currently only has the two partial unique indexes; `id` is the PK, so the composite unique is a one-line addition).

**The one honest RLS conflict.** The invalidation poller runs `SELECT organization_id, version FROM permission_scope_versions WHERE updated_at > $1` with **no** organization context — under RLS that returns zero rows and the cache never invalidates. Three options: (i) an "organization context unset" SELECT policy mirroring the identity lens; (ii) **no RLS on `permission_scope_versions`**; (iii) poll per-org inside a context (N transactions per tick — rejected). **Recommend (ii)**, with the reasoning written into `docs/SECURITY.md`: this table holds no Organization *data*, only a monotonic change counter keyed by org id; it is a cache-coherence channel, not a tenant store; `station_app` already knows every org id it serves. SECURITY.md's rule is "a schema change that introduces Organization-scoped **data** must add equivalent RLS policies" — this introduces none. This needs an explicit line in ADR-0019 and a SECURITY.md paragraph, and it is the single item in this migration that a security reviewer must sign off on.

### 4f. `PermissionReach` replacement via the query plan

`apps/api/src/tenancy/tenancy.controller.ts` declares `resource: { kind: 'unspecified', type: 'Project' }`; the guard precomputes the plan into `request[AUTHORIZATION_STATE].plan`. `TenancyService.listProjects` becomes:
```ts
const where = planToSql(plan, projectResourceMapping)             // @nestm/permissions-drizzle
const rows = await withOrganizationContext(db, organizationId, (tx) =>
  tx.select().from(projects)
    .where(and(eq(projects.organizationId, organizationId), where))
    .orderBy(projects.name))
```
with, in `packages/database/src/authorization-mappings.ts`:
```ts
export const projectResourceMapping = {
  resourceType: 'Project', table: projects, id: projects.id,
  attributes: { organization: { kind: 'entity', column: projects.organizationId, entityType: 'Organization' } },
  hierarchy: { Organization: { kind: 'column', column: projects.organizationId },
               Project:      { kind: 'self' } },
} as const satisfies DrizzleResourceMapping<'Project'>
```
An org-wide grant residual `resource in Organization::"o"` compiles to `projects.organization_id = $o` (`ALWAYS_ALLOW` after the org filter, in practice); a project-scoped grant residual `resource in Project::"p"` compiles to `projects.id = $p`; the mix is `OR`-ed — identical to `permissionReach`, and RLS still runs underneath as the second wall. `ALWAYS_DENY` compiles to `false` (station's current `reach.kind === 'none' ⇒ return []` becomes structural rather than a hand-written guard).

`listOrganizations` (today N transactions, `tenancy.service.ts:70-84`) becomes **one** `withIdentityContext` query loading every membership + its grants, then N in-memory `engine.check()` calls at ~0.14 ms each. Same semantics, one round-trip instead of N. Keep the loop shape so the diff stays reviewable.

### 4g. Phasing, shadow mode, rollback

- **Phase 0 — additive, zero behaviour change.** Add `@nestm/*` deps; vocabulary in `packages/platform`; `0004` migration; `createDefaultRoleBundles` also writes templates; role-grant writes also write links; a re-runnable idempotent backfill (`scripts/backfill-authz-projection.mjs`) for existing orgs; the drift-check script. Nothing reads the new tables. **Reversible by dropping three tables.**
- **Phase 1 — shadow.** `STATION_AUTHZ_ENGINE=shadow`. The legacy `PermissionGuard` still decides; a `ShadowAuthorizationService` runs the Cedar check on the same inputs, compares, and on divergence logs a structured warning and increments a `station_authz_divergence_total` counter. Zero request-path risk. **Exit gate: zero divergences across the full blackbox suite and N days of staging traffic.**
- **Phase 2 — cutover, one route family at a time.** `STATION_AUTHZ_ENGINE=cedar`. Order: `/me` routes → read-only org routes → project routes → grant-management routes → instance (`POST /organizations`) last. Routes stay dual-decorated so both audits pass.
- **Phase 3 — query plans.** `listProjects` → `planToSql`; `listOrganizations` → batched checks.
- **Phase 4 — delete.** Remove `platform/src/authorization.ts` evaluation functions, `AuthorizationService.resolveMemberAuthorization`, station's `permission.guard.ts`, `require-permission.decorator.ts`, `route-authorization.audit.ts`, and the legacy branch. `roles`/`role_permissions`/`role_grants` and the entire OpenAPI contract **stay**.
- **Must keep passing unchanged:** all nine cases in `apps/api/src/authorization/authorization.blackbox.test.ts` (notably `'confines a project-scoped grant to its Project while an org-wide grant reaches all'`, `'filters the Organization list by organization:read'`, `'refuses to revoke the last org-wide grant able to manage grants'`, `'denies a grant-less Member and keeps non-Members indistinguishable from missing Organizations'`), `apps/api/src/tenancy/*.blackbox.test.ts`, `apps/api/src/auth/invitations.blackbox.test.ts`, `apps/api/src/authorization/route-authorization.audit.test.ts`. **Expected to be rewritten:** `permission.guard.test.ts` (406 lines of legacy-guard internals).
- **Rollback:** flip `STATION_AUTHZ_ENGINE` back to `legacy` (Phases 1–3 keep the legacy code path compiled and covered by CI). No destructive DDL before Phase 4; `0004` has a clean down (drop three tables + the added unique constraint).

---

## 5. File-by-file layout and ordered task list

```
packages/permissions-typeorm/                       packages/permissions-drizzle/
├─ package.json  (peer typeorm ^1.1.0, optional     ├─ package.json  (peer drizzle-orm ^0.45.0,
│   peers @nestjs/common ^12.0.0-alpha, @nestjs/    │   optional peers @nestjs/common, drizzle-kit;
│   typeorm; dep @nestm/permissions-core            │   dep @nestm/permissions-core workspace:^)
│   workspace:^; exports ".", "./nestjs",           │   exports ".", "./nestjs", "./schema",
│   "./testing", "./package.json")                  │   "./testing", "./package.json"
├─ tsdown.config.ts  entry [index, nestjs, testing],├─ tsdown.config.ts  (same shape)
│   deps.neverBundle [/^typeorm/,/^@nestjs\//]      ├─ vitest.config.ts   pool 'forks', PG_URL gate
├─ vitest.config.ts                                 ├─ compose.yaml       postgres:16-alpine
└─ src/                                             └─ src/
   ├─ index.ts                barrel                   ├─ index.ts
   ├─ nestjs.ts               PermissionsTypeOrm-       ├─ nestjs.ts        PermissionsDrizzleModule
   │                          Module.forRoot/Async      ├─ schema.ts        createPermissionsSchema
   ├─ testing.ts              store conformance re-     │                   (+ per-table builders)
   │                          export + fixtures         ├─ store/
   ├─ entities/                                         │  ├─ drizzle-policy-store.ts
   │  ├─ create-entities.ts   EntitySchema factory      │  ├─ rows.ts        row <-> record codecs
   │  ├─ rows.ts              row types + codecs        │  ├─ version.ts     bump/probe SQL
   │  └─ migration.ts         buildPermissionsMigration │  └─ watcher.ts     poller + LISTEN/NOTIFY
   │                          + PermissionsInitial-     ├─ compile/
   │                          Migration factory         │  ├─ mapping.ts    DrizzleResourceMapping
   ├─ store/                                            │  ├─ plan-to-sql.ts
   │  ├─ typeorm-policy-store.ts                        │  ├─ values.ts     bigint/date/entity binding
   │  ├─ version.ts                                     │  ├─ like.ts       tokens -> pattern+escape
   │  └─ watcher.ts                                     │  ├─ hierarchy.ts  self/column/closure/recursive
   ├─ compile/                                          │  └─ apply-plan.ts
   │  ├─ mapping.ts           TypeOrmResourceMapping    └─ errors.ts
   │  ├─ resolve-column.ts    EntityMetadata lookup
   │  ├─ plan-to-brackets.ts
   │  ├─ values.ts  like.ts  hierarchy.ts
   │  ├─ parameters.ts        collision-safe naming
   │  └─ apply-plan.ts
   └─ errors.ts
tests/{unit,integration,property}/**                 (mirrored in both packages)
references/ucast-sql/                                (vendored prior art, gitignored from lint)
```

### Ordered tasks

**Prerequisite:** core steps 1–9 in `design-core.md` (specifically step 9, `evaluate-plan.ts`) plus deltas D5/D7 must land first — the differential tests are impossible without the reference interpreter.

| # | Task | Package | Days |
|---|---|---|---|
| 1 | Core deltas D1–D7 agreed and landed (SPI doc + types) | core | 0.5 |
| 2 | Shared **store conformance suite** exported from core `./testing` (runs against `MemoryPolicyStore` first) | core | 1.0 |
| 3 | Drizzle package skeleton + `createPermissionsSchema` factory + drizzle-kit round-trip test (asserts the top-level-const export requirement) | drizzle | 1.0 |
| 4 | `DrizzlePolicyStore` (CRUD, version bump, composite version, id-collision throw) → conformance green | drizzle | 1.5 |
| 5 | `watcher.ts` — poller + optional LISTEN/NOTIFY + backoff | drizzle | 0.5 |
| 6 | **Drizzle compiler**: mapping DSL, values, like, hierarchy, `planToSql`, `applyPlan`, error taxonomy | drizzle | 2.0 |
| 7 | Drizzle differential/property/LIKE-fuzz/injection suites against real PG + RLS harness | drizzle | 1.5 |
| 8 | `@nestm/permissions-drizzle/nestjs` module + README (incl. the fail-closed contract verbatim) | drizzle | 0.5 |
| 9 | TypeORM skeleton + `createPermissionsEntities` (`EntitySchema`) + `migration:generate` round-trip test | typeorm | 1.0 |
| 10 | `TypeOrmPolicyStore` + version + watcher → conformance green | typeorm | 1.5 |
| 11 | `buildPermissionsMigration` + `PermissionsInitialMigration` (postgres first; mysql/sqlite statements behind a dialect switch) | typeorm | 1.0 |
| 12 | **TypeORM compiler**: `resolve-column` via `EntityMetadata`, `parameters.ts`, `planToBrackets`, `applyPlan` | typeorm | 2.0 |
| 13 | TypeORM test suites (same six categories) | typeorm | 1.5 |
| 14 | `@nestm/permissions-typeorm/nestjs` module + README | typeorm | 0.5 |
| 15 | CI `test-drivers` job wiring, publint/attw, `design:paramtypes` grep extended to `dist/nestjs.mjs` | both | 0.5 |
|  | **Driver total** | | **≈ 16.5 days** |

Drizzle lands first (simpler — `Column` objects mean no metadata resolution and no injection surface) so its compiler shakes out the AST↔SQL semantics before the TypeORM copy.

### Station migration phases

| # | Phase | Files | Days |
|---|---|---|---|
| S1 | ADR-0019 (Cedar engine) + SECURITY.md amendment (incl. the `permission_scope_versions` RLS carve-out) + optional dependency-cruiser rule | `docs/adr/0019-*.md`, `docs/SECURITY.md`, `dependency-cruiser.config.mjs` | 0.5 |
| S2 | Vocabulary + entity builders; CI test asserting action ids ≡ `permissionKeys ∪ instancePermissionKeys` | `packages/platform/src/authorization/*` | 1.5 |
| S3 | `0004_cedar-policy-store.sql` + schema factory wiring + `role_grants` composite unique | `packages/database/src/schema.ts`, `drizzle/0004_*.sql` | 1.0 |
| S4 | Transactional projection writes in `createDefaultRoleBundles` / `createRoleGrant` / `revokeRoleGrant`; backfill + drift scripts | `packages/database/src/authorization.ts`, `scripts/` | 2.0 |
| S5 | `AuthorizationEngineModule` (engine + `CompositePolicyStore` + `StationPrincipalResolver` + `StationEntityProvider` reading `members`/`operators`/`projects`) | `apps/api/src/authorization/` | 2.0 |
| S6 | Shadow service + divergence metric + `STATION_AUTHZ_ENGINE` flag | `apps/api/src/authorization/shadow-authorization.service.ts` | 1.0 |
| S7 | Guard swap incl. `hooks.onDenied` → 404/403/`ValidationException` mapping; dual-decorated routes; dual audits | `apps/api/src/authorization/`, all controllers | 2.0 |
| S8 | `listProjects` via `planToSql`; `listOrganizations` batched; drop `permissionReach` usage | `apps/api/src/tenancy/tenancy.service.ts`, `packages/database/src/authorization-mappings.ts` | 1.5 |
| S9 | Better Auth `organizationHooks` → `permissionsService.check` | `apps/api/src/auth/auth.module.ts` | 0.5 |
| S10 | Delete legacy evaluation core, guard, decorator, audit; rewrite `permission.guard.test.ts` | `packages/platform`, `apps/api/src/authorization/` | 1.5 |
|  | **Station total** | | **≈ 13.5 days** |

## Verification

```bash
# drivers
pnpm --filter @nestm/permissions-drizzle run build && pnpm dlx publint --strict --pack packages/permissions-drizzle
pnpm dlx @arethetypeswrong/cli --pack packages/permissions-drizzle --profile esm-only
docker compose up -d postgres
PG_URL=postgres://…:55432/nestm pnpm --filter "@nestm/permissions-{drizzle,typeorm}" run test
node -e "const s=require('fs').readFileSync('packages/permissions-drizzle/dist/nestjs.mjs','utf8');
         if(!s.includes('design:paramtypes')) throw new Error('decorator metadata dropped')"

# station
pnpm --filter @station/database run db:generate   # must produce an EMPTY diff after 0004 lands
pnpm --filter @station/api run test               # unit
pnpm --filter @station/api run test:blackbox      # real PG; all 9 authorization cases green
pnpm contracts:generate                           # boots the app -> route audit must pass
git diff --exit-code packages/api-client packages/contracts/openapi.json   # contract unchanged
node scripts/assert-authz-projection.mjs          # role_grants <-> permission_policy_links drift = 0
```

Smoke checks that must hold: a project-scoped grant reaches a `Run` under that Project (new capability, assert explicitly); `GET /organizations/:id/projects` returns exactly the same rows before and after S8 for both grant shapes; an unknown-org 404 body is byte-identical to a non-member-probe 404; killing the poller (stop writes to `permission_scope_versions`) makes grants take ≤5 s to take effect on other replicas but **never** widens access; revoking a grant is effective **immediately** on the replica that performed the revoke.

## Out of scope for this slice

Cedar wrapper internals and residual lowering (core); guard/decorator/module internals (nest slice); a policy-admin HTTP API and its UI; MySQL/SQLite compiler dialects beyond the migration-statement generator (Postgres only in v1); `permission_principal_groups` as a station feature; reverse queries ("who can act on this row"); and TypeORM 0.3.x support.
