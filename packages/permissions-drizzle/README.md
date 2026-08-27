# @nestm/permissions-drizzle

> [!CAUTION]
> Alpha. Published under the `alpha` tag; every release may break. Do not use this in production.

The Drizzle ORM driver for [`@nestm/permissions`](https://github.com/nestm-dev/permissions). Three
things, all Postgres:

- a **`PolicyStore`** over three tables — Cedar policies and template links persisted as queryable
  `jsonb`, with a monotonic per-scope version stamp and a poller (plus optional `LISTEN`/`NOTIFY`)
  that turns every write into a cache-invalidation event;
- a **schema factory** whose tenant column belongs to _you_ — `text('scope')` for a greenfield app,
  `uuid('organization_id') NOT NULL REFERENCES organizations(id)` for one already under row-level
  security — with an `extraTableConfig` seam that puts `pgPolicy(...)`/`foreignKey(...)` on the
  generated tables;
- the **query-plan compiler**: `planToSql(plan, mapping)` turns a Cedar partial-evaluation plan into
  a Drizzle `SQL` predicate, so "list the projects this member can read" is one indexed query rather
  than a fetch-then-filter loop.

The compiler is a **total function**. `ALWAYS_ALLOW` compiles to `TRUE`, `ALWAYS_DENY` to `FALSE`,
and any node the mapping cannot express **throws** — there is no configuration in which an
uncompilable filter becomes `TRUE`, and no API that can return "nothing" for a plan.

Importing this package pulls in neither NestJS nor the 4.1 MiB Cedar WASM: the framework wiring
lives behind `./nestjs`, and the compiler reaches `@nestm/permissions-core/plan`, which is pure
TypeScript.

Design: [`docs/design/drivers-and-station.md`](../../docs/design/drivers-and-station.md) §§1–3.
Live-verified corrections: [`docs/design/errata.md`](../../docs/design/errata.md).

## Install

```sh
npm install @nestm/permissions-drizzle@alpha drizzle-orm
```

Peers: `drizzle-orm@^0.45`, and optionally `drizzle-kit@^0.31` (migrations) and
`@nestjs/common@^12.0.0` (the `./nestjs` subpath). `@nestm/permissions-core` is a hard
dependency. Node >= 22.12, ESM only, Postgres only.

## Quick start

### 1. The tables

> [!IMPORTANT]
> **Destructure the factory result into top-level `export const`s.** This is not stylistic.
> `drizzle-kit`'s `prepareFromExports` walks `Object.values(module)` and keeps only the values that
> pass `is(value, PgTable)`. An exported object _containing_ the tables passes nothing, so
> `drizzle-kit generate` emits an **empty migration** — successfully, with no warning anywhere — and
> your application dies at runtime on `relation "permission_policies" does not exist`.

```ts
// db/schema.ts
import { createPermissionsSchema } from "@nestm/permissions-drizzle/schema";

// ✅ three top-level PgTables — drizzle-kit sees three CREATE TABLEs
export const { permissionPolicies, permissionPolicyLinks, permissionScopeVersions } =
	createPermissionsSchema();

// ❌ silently generates an EMPTY migration
// export const permissionsSchema = createPermissionsSchema();
```

Both halves of that behaviour are pinned by `tests/integration/drizzle-kit-roundtrip.test.ts`,
including the empty one.

Then `drizzle-kit generate`, and hand-append the statements drizzle-kit cannot express — see
[the RLS seam](#the-rls-seam).

### 2. The store

```ts
import { drizzle } from "drizzle-orm/node-postgres";
import { DrizzlePolicyStore } from "@nestm/permissions-drizzle";
import { createEngine } from "@nestm/permissions-core";

import { permissionPolicies, permissionPolicyLinks, permissionScopeVersions } from "./db/schema.ts";

const db = drizzle(process.env.DATABASE_URL);

const policyStore = new DrizzlePolicyStore(db, {
	permissionPolicies,
	permissionPolicyLinks,
	permissionScopeVersions,
});

const engine = await createEngine({ vocabulary, policyStore });
```

The schema object may be the factory's return value or one re-assembled from the top-level consts —
the scope codec travels on the tables themselves, so the two cannot drift.

### 3. The plan, as a `WHERE` clause

```ts
import { and, eq } from "drizzle-orm";
import { planToSql, type DrizzleResourceMapping } from "@nestm/permissions-drizzle";

const projectMapping = {
	resourceType: "Project",
	table: projects,
	id: projects.id,
	attributes: {
		organization: { kind: "entity", column: projects.organizationId, entityType: "Organization" },
		status: { kind: "scalar", column: projects.status, valueKind: "string" },
	},
	hierarchy: {
		Organization: { kind: "column", column: projects.organizationId },
		Project: { kind: "self" },
	},
} as const satisfies DrizzleResourceMapping<"Project">;

const plan = await engine.plan({
	scope,
	principal,
	action: "project:read",
	resourceType: "Project",
});

const rows = await db
	.select()
	.from(projects)
	.where(and(eq(projects.organizationId, organizationId), planToSql(plan, projectMapping)));
```

An org-wide grant's residual `resource in Organization::"o"` compiles to
`projects.organization_id = $o`; a project-scoped grant's `resource in Project::"p"` compiles to
`projects.id = $p`; a mix is `OR`-ed. `ALWAYS_DENY` compiles to `false`, so "this member can see
nothing" is structural rather than a hand-written early return.

## The schema factory

```ts
createPermissionsSchema<TScope, TScopeColumn extends PgColumnBuilderBase>(options?: {
	tablePrefix?: string;                 // default 'permission_'
	scopeColumn?: ScopeColumnOptions<TScope, TScopeColumn>;
	linkIdColumn?: () => PgColumnBuilderBase; // default text('link_id').notNull()
	extraColumns?: { policies?; links?; scopeVersions? };
	extraTableConfig?: (tables: RawPermissionsTables) => ExtraTableConfig | undefined;
}): { permissionPolicies; permissionPolicyLinks; permissionScopeVersions }
```

Three tables: `${prefix}policies` (static policies **and** templates, so "list everything in this
scope" stays one query), `${prefix}policy_links` (template links — the role-grant primitive, with
slot values as **columns** so "revoke every grant for member X" is an indexed statement), and
`${prefix}scope_versions` (one `bigint` per scope, bumped in the same transaction as the write it
describes).

**No foreign key is emitted from `links.template_id` to `policies.policy_id`.** The obvious
`ON DELETE CASCADE` turns "an operator deleted a template" into "every grant under it silently
disappeared"; core's conformance suite requires the opposite — an orphaned link must survive into
the bundle so `buildPolicySet` can refuse it loudly. Add the constraint through `extraTableConfig`
if you want it, knowingly.

### The scope column is yours

```ts
interface ScopeColumnOptions<
	TValue = string,
	TColumn extends PgColumnBuilderBase = PgColumnBuilderBase,
> {
	name: string;
	column: () => TColumn; // called once per table — return a FRESH builder
	toScope: (value: TValue) => string; // column value -> core's PolicyScopeId
	fromScope: (scope: string) => TValue; // the inverse; throws on '' when unsupported
	supportsGlobalScope?: boolean; // default true
}
```

An inline `column` keeps its concrete Drizzle builder in the returned tables. For example,
`text("organization_id").notNull()` makes every returned `.scope` a non-null `PgText` column with
`string` data, so string-tenant RLS helpers accept it without a cast.

`supportsGlobalScope: false` (a `NOT NULL uuid` tenant key) makes the store **reject** writes to the
global scope `''` and skip the global half of the `load()` union entirely. A `NOT NULL` tenant
column has no value meaning "every tenant", and inventing one is how a global policy leaks into a
tenant's bundle.

> [!IMPORTANT]
> **`scopeColumn.name` sets the SQL name only.** The drizzle **property** stays `scope` on all
> three tables, whatever the column is called in the database — so it is `t.policies.scope`, never
> `t.policies.organizationId`, in `extraTableConfig` and in every `sql` template. Getting this
> wrong does not fail loudly: `t.policies.organizationId` is `undefined`, and a `pgPolicy` built
> from it is a policy over nothing. Pinned by
> `tests/unit/schema-factory.test.ts > the scope column's property name`.

### The link id column is yours too

`link_id` is `text('link_id').notNull()` by default. A link id is core's `TemplateLinkRecord['id']`
— a `string` on the JavaScript side whatever the SQL type is — so this is a physical-schema choice,
and the one that matters is the foreign key. A deployment that reuses its own grant table's `uuid`
primary key as the link id needs a composite FK to `(tenant, id)`, and Postgres refuses one between
`text` and `uuid` ("foreign key constraint cannot be implemented … incompatible types"):

```ts
import { assertTablesReady, createPermissionsSchema } from "@nestm/permissions-drizzle/schema";

createPermissionsSchema({
	scopeColumn: stationScopeColumn,
	linkIdColumn: () => uuid("link_id").notNull(),
	extraTableConfig: (raw) => {
		const t = assertTablesReady(raw);
		return {
			links: [
				foreignKey({
					columns: [t.links.scope, t.links.linkId],
					foreignColumns: [roleGrants.organizationId, roleGrants.id],
				}).onDelete("cascade"),
			],
		};
	},
});
```

Like `scopeColumn.column`, it is called once per table it appears on and must return a **fresh**
builder. The drizzle property name stays `linkId` — that is what the store reads — so only the SQL
name and type are yours. Spreading a `linkId` override through `extraColumns.links` still works and
still wins (the extras are spread last), but it relies on that spread order rather than on a
documented option; `linkIdColumn` is the supported spelling.

### The RLS seam

`extraTableConfig` receives the built columns and returns extra `pgTable` config entries, so the
generated tables are indistinguishable from hand-written ones:

```ts
import { assertTablesReady, createPermissionsSchema } from "@nestm/permissions-drizzle/schema";

export const { permissionPolicies, permissionPolicyLinks, permissionScopeVersions } =
	createPermissionsSchema({
		scopeColumn: {
			name: "organization_id",
			column: () => uuid("organization_id").notNull(),
			toScope: (id) => id,
			fromScope: (scope) => scope,
			supportsGlobalScope: false,
		},
		extraTableConfig: (raw) => {
			// The columns are keyed by drizzle PROPERTY name, so the tenant column is
			// `scope` here even though its SQL name is `organization_id`.
			const t = assertTablesReady(raw);
			return {
				policies: [
					foreignKey({
						columns: [t.policies.scope],
						foreignColumns: [organizations.id],
					}).onDelete("cascade"),
					pgPolicy("permission_policies_isolation", {
						as: "permissive",
						for: "all",
						to: "public",
						using: sql`${t.policies.scope} = nullif(current_setting('station.organization_id', true), '')::uuid`,
						withCheck: sql`${t.policies.scope} = nullif(current_setting('station.organization_id', true), '')::uuid`,
					}),
				],
				// A composite FK across two of the tables — the reason the callback has to
				// see all three at once.
				links: [
					foreignKey({
						columns: [t.links.scope, t.links.templateId],
						foreignColumns: [t.policies.scope, t.policies.policyId],
					}).onDelete("cascade"),
				],
				// scopeVersions: deliberately no policy — see below.
			};
		},
	});
```

**The callback is invoked exactly once**, with all three tables' columns already populated, and each
key's entries are built at most once. Any key may be omitted, `undefined`, or a **thunk**
(`links: () => [...]`) when an entry has to be built late — a thunk runs when its own table is first
serialised.

`assertTablesReady(raw)` is optional sugar: it drops the `?` from the three keys (they stay optional
in the type for source compatibility) and throws if a table is genuinely missing, which would mean
your foreign keys were about to be dropped from the migration silently.

<details>
<summary>What changed, and why guarded branches are now dead code</summary>

`pgTable()` does not call its config callback — it stores it, and drizzle-kit calls each table's
independently and in no guaranteed order. Resolving `extraTableConfig` from inside those callbacks
therefore evaluated your whole returned object once per table, each time against a differently
filled `tables`. Two failure modes followed, and the second is the dangerous one:

- an entry dereferencing a table that had not been built yet threw `Cannot read properties of
undefined (reading 'scope')` from inside drizzle-kit, naming neither this option nor the table;
- guarding the branches — `tables.policies === undefined ? [] : [...]` — traded that crash for a
  **silent omission**: a `links` entry guarded on `tables.policies` produced `[]` whenever the links
  table happened to be serialised first, so the foreign key and the isolation policy were simply
  absent from the migration, with no error anywhere.

Existing guarded implementations keep working unchanged and now always take the populated branch.
Pinned by `tests/unit/schema-factory.test.ts`.

</details>

`drizzle-kit generate` emits the tables, indexes and policies. It does **not** emit grants, and
`FORCE ROW LEVEL SECURITY` — the part that makes RLS apply to the table's owner too — has no
schema-level representation at all. `permissionsPostgresPolicyStatements({ role })` returns those
statements verbatim so it is copy-paste rather than archaeology:

```ts
permissionsPostgresPolicyStatements({ role: "station_app" }).join(";\n") + ";";
```

Two things to know before running under RLS:

- **`permission_scope_versions` is left unprotected by default.** The invalidation poller runs
  `SELECT scope, version …` with **no** tenant context; under RLS that returns
  zero rows and no cache ever invalidates. The table holds no tenant _data_, only a monotonic
  counter keyed by tenant id — a cache-coherence channel. `rowLevelSecurityOnScopeVersions: true`
  turns it on if you have given the poller a context, or accepted that invalidation stops. This is
  the one item in the design a security reviewer is asked to sign off on.
- **Run foreground store work through the executor that carries the context.** `set_config(…, true)`
  is transaction-local, so a singleton store issuing its statements on a different pooled
  connection sees no context and reads **zero** rows. `DrizzlePolicyStoreExecutor` is structural;
  a tenant library can implement it without depending on this package:

  ```ts
  const executor: DrizzlePolicyStoreExecutor = tenantRlsExecutor;
  const options = { executor, poll: false };
  const store = new DrizzlePolicyStore(db, schema, options);
  ```

  Keep polling disabled unless `scope_versions` is deliberately readable without context.

  Its one method is
  `run({ operation, access, isolationLevel, commitOwnership, scopes }, work)`. `scopes` is the exact effective
  database scope set: a global-capable tenant read names `["", tenant]`, while a tenant-only schema
  names `[tenant]`. Validate it against the request tenant before opening/pinning a transaction,
  setting the context, and invoking `work(tx)`. A global or mismatched scope must be rejected, not
  interpreted as an empty RLS result.

  The execution object declares transaction policy directly, so adapters never infer it from the
  operation name. Apply `access` and `isolationLevel` as given. When `commitOwnership` is
  `"required"`, reject nesting and resolve only after the real `COMMIT`, because the store emits
  its synchronous local invalidation immediately after that promise resolves.

  Omitting `executor` uses `db.transaction(...)` when `db` is a root database handle. Passing an
  ambient Drizzle transaction without an explicit executor is rejected: Drizzle would create only
  a savepoint, could not apply the requested transaction configuration, and could not truthfully
  report a write as committed. The portable database type still accepts transaction handles for
  explicit executors. A long-lived Nest store should receive the pool as `db` and a request-aware
  executor through `options`, never a request transaction as the module's database.

  A superuser bypasses RLS regardless of `FORCE`, so verify your isolation as the
  `NOLOGIN NOBYPASSRLS` role your application actually connects as.
  `tests/integration/rls.test.ts` is a working harness for exactly this shape.

## The store

```ts
new DrizzlePolicyStore(db, schema, options?)
```

| option        | default                |                                                                                                                                                                                                                                                       |
| ------------- | ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `executor`    | `db.transaction`       | Foreground transaction/RLS seam. `load` requests read-only repeatable-read; writes request an owned, post-commit transaction. Background polling still uses `db`.                                                                                     |
| `poll`        | `{ intervalMs: 5000 }` | Invalidation poll; `false` disables it. **One** query per tick compares every scope's monotonic version with an in-memory snapshot, avoiding timestamp/commit-order races. Rows returned are O(all scopes).                                           |
| `notify`      | off                    | Opt-in `LISTEN`/`NOTIFY`: `{ channel, client: () => new Client(url) }`. The connection must be **dedicated and non-pooled** — a pooled connection handed out mid-`LISTEN` stops delivering notifications with no error anywhere. `dispose()` ends it. |
| `onError`     | —                      | Where background failures go. The poller must never crash the process and must never clear the cache.                                                                                                                                                 |
| `scopeColumn` | from the tables        | Only needed when the tables were declared by hand rather than by the factory.                                                                                                                                                                         |

Beyond core's `PolicyStore` SPI it adds `dispose()` (stops the poller, closes any `LISTEN`
connection) and `pollOnce()` (one tick, for tests).

**Invalidation, in three sentences.** Every write bumps its scope's version in the _same
transaction_ and emits a change event **synchronously after commit**, so the writing replica has
zero staleness. Other replicas learn from the poller, which emits exactly one event per changed
scope. A failed tick logs to `onError`, backs off exponentially (capped at 60 s) and **leaves the
observed version snapshot and the cache untouched** — stale-but-known beats empty, because an empty policy set is
`deny` for the whole tenant.

A global-scope write is broadcast as `{ scope: '*' }`, because it changes the effective bundle of
every scope. A policy or link id present in **both** the global scope and the scope being loaded
makes `load()` **throw**: precedence between them is undefined, so a silent winner is a
configuration error waiting to be a security incident.

## `planToSql` / `applyPlan`

```ts
function planToSql<R extends string>(
	plan: QueryPlan<R>,
	mapping: DrizzleResourceMapping<R>,
	options?: { allowPermissiveApproximations?: boolean },
): SQL;

function applyPlan<Q extends { where(condition: SQL): unknown }, R extends string>(
	query: Q,
	plan: QueryPlan<R>,
	mapping: DrizzleResourceMapping<R>,
	options?,
): PlanFiltered<Q>;

function planNodeToSql<R extends string>(node: PlanNode, mapping: DrizzleResourceMapping<R>): SQL;
```

`planToSql` is the primitive and it always returns a total boolean expression. `applyPlan` is sugar
over it and **replaces** any `WHERE` already on the builder — that is drizzle's `.where()`
semantics, not something this function could soften, so compose your tenant filter explicitly.

### Mapping DSL

```ts
interface DrizzleResourceMapping<R extends string> {
	resourceType: R; // must equal plan.resourceType
	table: PgTable;
	id: PgColumn; // the row's Cedar entity id
	attributes: Record<string, DrizzleAttributeMapping>;
	hierarchy?: Record<string, DrizzleHierarchyMapping>; // key = PARENT entity type
	text?: { escapeChar?: string; collation?: "exact" | "case-insensitive" };
}

type DrizzleAttributeMapping =
	| {
			kind: "scalar";
			column: PgColumn;
			valueKind: "string" | "long" | "bool" | "datetime" | "duration" | "decimal" | "ipaddr";
	  }
	| {
			kind: "entity";
			column: PgColumn;
			entityType: string;
			hierarchy?: Record<string, DrizzleHierarchyMapping>;
	  }
	| { kind: "array"; column: PgColumn; elementKind: DrizzleScalarKind }
	| { kind: "jsonPath"; column: PgColumn; path: readonly string[]; valueKind: DrizzleScalarKind };

type DrizzleHierarchyMapping =
	| { kind: "self" } // parent type IS the resource type
	| { kind: "column"; column: PgColumn } // denormalised ancestor id
	| { kind: "closure"; table: PgTable; ancestor: PgColumn; descendant: PgColumn }
	| { kind: "recursive"; parentColumn: PgColumn; idColumn: PgColumn };
```

A mapping is a **claim**, and every claim is checked before any SQL is produced.
`{ kind: 'scalar', valueKind: 'string' }` says "this column holds exactly the strings Cedar compares
against this attribute" — so an ordering comparison over it is refused (Cedar has no string
ordering; SQL invents one under the column's collation) and a `contains` over it is refused (a
scalar is not a set). There is no `kind: 'unknown'` and no fallback.

**Cedar's `in` is reflexive.** `Project::"p" in Project::"p"` is true, so `{ kind: 'self' }`
compiles to `id = $p` rather than to an ancestor lookup, and the `closure`/`recursive` strategies
emit the reflexive disjunct themselves (`col = $p OR EXISTS (…)`) rather than requiring self-pairs
in your data. Getting that wrong is a silent over-block on the one query a role-grant system is
about.

A mapping for `parent.type` is **required**, even when it equals the resource's own type. That looks
pedantic until a vocabulary declares `Doc memberOf ['Doc']`, at which point `id = $p` silently stops
finding the nested rows. Writing `{ kind: 'self' }` is asserting "this type does not nest under
itself", which the compiler has no other way to learn.

### The fail-closed contract

> `planToSql` / `planToBrackets` compile **exactly** the `PlanNode` grammar. Anything a mapping does
> not cover raises a `PlanCompilationError` before any SQL is produced. There is no configuration in
> which an uncompilable node becomes `TRUE`.

Concretely, each of these **throws** (never degrades), with a machine-readable `error.reason`:

| `reason`                                        | when                                                                                                 |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `unmapped-attribute` (`UnmappedAttributeError`) | the plan reads an attribute the mapping does not declare, a principal-rooted path, or a depth-2 path |
| `unmapped-hierarchy` (`UnmappedHierarchyError`) | an `inHierarchy` node names a parent type the mapping has no strategy for                            |
| `unorderable-comparison`                        | `<`/`<=`/`>`/`>=` over a string, bool, entity, ipaddr or set                                         |
| `contains-on-scalar`                            | `contains()`/`isEmpty()` against a column mapped as a scalar                                         |
| `entity-column-mismatch`                        | an entity constant against a non-entity column, or the reverse                                       |
| `case-insensitive-like`                         | `like` against a table declaring `collation: 'case-insensitive'`                                     |
| `permissive-approximation`                      | the plan widens the row set and the caller did not opt in                                            |
| `resource-type-mismatch`                        | `plan.resourceType` is not the type the mapping describes                                            |
| `value-kind-mismatch`                           | a `PlanValue` kind the mapped column cannot hold                                                     |
| `invalid-mapping`                               | a structurally unusable mapping entry                                                                |

`allowPermissiveApproximations: true` alone is **not** enough to compile a widened plan: the plan
must also carry a `postFilter`, and you must run every returned row through it. `ALWAYS_DENY` is
exempt — it selects nothing, so nothing it carries can over-share.

Use `isPlanCompilationError(value)` rather than `instanceof`: it checks the stable `code`/`reason`
pair, so it survives the class duplication a bundler will happily perform across package boundaries.

### Why NULL is safe here

The assembled condition is `OR(permits) AND NOT(OR(forbids))`. SQL's three-valued logic makes any
NULL-touching subterm propagate to NULL, and a top-level NULL excludes the row. Under this shape
that is **uniformly restrictive**: a NULL inside a permit drops the row, and a NULL inside a forbid
makes `NOT NULL` NULL, which also drops the row. So a nullable column mapped to a Cedar optional
attribute is fail-closed by construction — and it agrees with Cedar, where reading an absent
attribute errors the policy into `false`.

Two consequences, both load-bearing: this compiler **never** wraps a condition in
`COALESCE(…, true)` and **never** emits `NOT IN` against a nullable subquery. It also never calls
drizzle's `and()`/`or()`, whose `SQL | undefined` return type is the same hazard wearing a type
signature — `undefined` reaching `.where()` is not a type error and not a runtime error, it is a
`WHERE` clause that was never emitted.

### Value binding

Every value is a bind parameter; nothing in this package concatenates a value into SQL. The casts
that are not obvious:

| kind                         | binding                              | why                                                                    |
| ---------------------------- | ------------------------------------ | ---------------------------------------------------------------------- |
| `long`                       | `$1::bigint`, bound as **text**      | `PlanValue.long` is a `bigint`; `Number()` rounds past 2^53            |
| `datetime`                   | `$1::timestamptz`, ISO-8601 with `Z` | a `Date` handed to a driver renders in whatever timezone it feels like |
| `decimal`                    | `$1::numeric`                        | `1.5 = 1.50` in Cedar and in `numeric`, and false under text equality  |
| `ipaddr`                     | `$1::inet`                           | see below                                                              |
| `string`, `bool`, entity ids | no cast                              | an explicit `::text` would break against `citext`, an enum or a `uuid` |

**ipaddr semantics.** Cedar's `ipaddr` equality compares the **address and the prefix**, not the
network — `1.2.3.4 == 1.2.3.4/32` is true (a bare address is a full-width prefix), and
`1.2.3.0/24 == 1.2.3.1/24` is **false**. Postgres `inet` equality agrees on every case (verified in
`tests/integration/value-binding.test.ts`); the two tempting alternatives do not. `::text` equality
is wrong on every pair Cedar calls equal but spells differently (`::1` vs `0:0:0:0:0:0:0:1`,
`FE80::1` vs `fe80::1`); `<<=` (network containment) is wrong on `1.2.3.1/24` vs `1.2.3.0/24`, which
it calls true. One caveat is on the _column_ side: Postgres accepts `01.2.3.4` and `::ffff:1.2.3.4`,
both of which Cedar rejects at evaluation, so a row holding one is a row Cedar would have errored on.

**Set semantics.** Cedar sets are unordered and duplicate-insensitive (`[1,2,2] == [2,1]`), which is
mutual containment — `col @> $x AND col <@ $x`. Plain array `=` is ordered and element-wise and is
the one spelling that must not be used.

**`like` semantics.** Cedar's `like` carries **tokens**, never a rendered pattern: `%` and `_` are
ordinary text to Cedar and metacharacters to SQL, and Cedar has no `\%` escape at all
(`like "50\%*"` is a parse error). The escaping lives in core's `likeTokensToPattern`, shared by both
ORM drivers so that a `%`-injection bug cannot exist in exactly one of them. Both the pattern and the
escape character are bound.

## NestJS

```ts
import { PermissionsDrizzleModule } from "@nestm/permissions-drizzle/nestjs";

@Module({
	imports: [
		PermissionsDrizzleModule.forRoot({ db, schema }),
		PermissionsModule.forRoot({ vocabulary, store: { useExisting: DrizzlePolicyStore } }),
	],
})
export class AppModule {}
```

`forRoot` / `forRootAsync`, global by default. The module provides and exports `DrizzlePolicyStore`
under its own class token and wires `dispose()` to `OnApplicationShutdown` — a store that outlives
its application keeps a `pg` client open and a timer scheduled, which surfaces as a test run that
never exits.

## Entry points

| subpath     | contents                                                                                                  |
| ----------- | --------------------------------------------------------------------------------------------------------- |
| `.`         | schema factory, store, watcher, compiler, errors                                                          |
| `./schema`  | the schema factory alone, for a `db/schema.ts` that should not import a store                             |
| `./nestjs`  | `PermissionsDrizzleModule` — the only file importing `@nestjs/*`                                          |
| `./testing` | `drizzleStoreFactory`, `provisionPermissionsSchema`, `generateSchemaDdl`, plus core's oracles re-exported |

## Limitations

- **Postgres only.** The compiler emits `@>`, `#>>`, `cardinality`, `ESCAPE`, `WITH RECURSIVE` and
  `::inet`/`::numeric` casts. MySQL and SQLite are out of scope for v1.
- **Depth-1 attributes.** `resource.owner.dept` needs a join the planner cannot know about and is
  rejected upstream as `nested-attribute`.
- **Longs outside ±2^53** are already rounded before this package sees them — the residual crosses
  the WASM boundary as JSON. The `bigint` keeps the driver side exact; it cannot undo the rounding.
- **`closure` and `recursive` hierarchies require ids unique across entity types**, since neither
  table carries a type column.
- **Row identity is not expressible.** `resource == Run::"r1"` is rejected by core's planner as
  `entity-identity`; `inHierarchy` is Cedar's reflexive-and-transitive `in`, which is strictly wider,
  so mapping `==` onto it would widen a permit.
- **`load()` issues three sequential round trips in one repeatable-read snapshot.** It is a cold
  path (the engine caches per scope), and the alternative overlaps queries on one pinned `pg`
  client — deprecated in `pg@8` and removed in `pg@9`.
- **`LISTEN`/`NOTIFY` accelerates the poll rather than replacing it.** `NOTIFY` is best-effort: it is
  lost if nobody is listening at that instant, and a dropped connection loses every notification
  until it reconnects. `poll: false` alongside `notify` is supported and means a missed notification
  is never recovered.

## Testing

The suites are differential against **real Postgres 16** — a compose file at the repository root
provides it — and a missing database is a failure, not a skip.

```sh
docker compose up -d
pnpm --filter @nestm/permissions-drizzle run test
```

| knob                        |                                                                                       |
| --------------------------- | ------------------------------------------------------------------------------------- |
| `PG_URL`                    | connection string; default `postgres://nestm:nestm@localhost:55433/nestm_permissions` |
| `PG_SKIP=1`                 | skip every suite needing a server, deliberately and out loud                          |
| `DRIZZLE_DIFFERENTIAL_RUNS` | property runs for the three-way differential (default 12)                             |
| `DRIZZLE_LIKE_FUZZ_RUNS`    | property runs for the LIKE fuzz (default 150)                                         |

The flagship suite computes three row sets — brute-force `check()` per row through real cedar-wasm,
core's reference interpreter over the same rows, and `SELECT id … WHERE <compiled>` against real
Postgres — and asserts **all three are equal**. Not "mostly", and not "the SQL is a subset": a
filter that selects a row Cedar would deny is a data leak, and one that drops a row Cedar would
allow is a silent outage.

## Errors

Everything the compiler refuses is a `PlanCompilationError` with `code: 'PLAN_COMPILATION'` and a
`reason` from the table above. Everything the store refuses is core's `PermissionsError` with
`code: 'POLICY_STORE'`, so a caller branches on one code for the whole storage layer.

## License

BSD-3-Clause.
