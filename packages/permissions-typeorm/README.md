# @nestm/permissions-typeorm

> [!CAUTION]
> Alpha. Published under the `alpha` tag; every release may break. Do not use this in production.

The TypeORM driver for [`@nestm/permissions`](https://github.com/nestm-dev/permissions). Three
things, all Postgres:

- a **`PolicyStore`** over three tables — Cedar policies and template links persisted as queryable
  `jsonb`, with a monotonic per-scope version stamp and a poller (plus optional `LISTEN`/`NOTIFY`)
  that turns every write into a cache-invalidation event;
- an **`EntitySchema` factory** whose tenant column belongs to _you_ — `text('scope')` for a
  greenfield app, `uuid('organization_id') NOT NULL` for one already under row-level security — and
  a three-tier migration story so you never have to hand-write the DDL;
- the **query-plan compiler**: `planToBrackets(plan, mapping)` turns a Cedar partial-evaluation plan
  into a TypeORM `Brackets`, so "list the projects this member can read" is one indexed query rather
  than a fetch-then-filter loop.

The compiler is a **total function**. `ALWAYS_ALLOW` compiles to `1 = 1`, `ALWAYS_DENY` to `1 = 0`,
and any node the mapping cannot express **throws** — there is no configuration in which an
uncompilable filter becomes `TRUE`, and no API that can return "nothing" for a plan.

Importing this package pulls in neither NestJS nor the 4.1 MiB Cedar WASM: the framework wiring
lives behind `./nestjs`, and the compiler reaches `@nestm/permissions-core/plan`, which is pure
TypeScript.

Design: [`docs/design/drivers-and-station.md`](../../docs/design/drivers-and-station.md) §§1–3.
Live-verified corrections: [`docs/design/errata.md`](../../docs/design/errata.md).

## Install

```sh
npm install @nestm/permissions-typeorm@alpha typeorm pg
```

Peers: `typeorm@^1.1`, and optionally `@nestjs/common@^12.0.0-alpha` (the `./nestjs` subpath).
`@nestm/permissions-core` is a hard dependency. ESM only, Postgres only.

> [!IMPORTANT]
> **Node >= 22.13.** This package's engine floor is higher than the rest of the family's (>= 22.12)
> because `typeorm@1.1.0` declares `engines.node: ^20.19 || ^22.13 || >=24.11`. On 22.12 the peer
> resolves and then warns; raising the floor here makes that a resolution error at install time
> instead of a surprise at boot.

`typeorm@1.1.0` is npm `latest`; `0.3.x` is published under the `legacy` tag and is **not**
supported — the driver relies on `EntitySchema`'s `primaryKeyConstraintName` and `checks`, and on
`EntityMetadata.findColumnWithPropertyPathStrict`.

## Quick start

### 1. The entities

`createPermissionsEntities()` returns three `EntitySchema`s rather than decorated classes. That is
deliberate: consumers are not forced to enable `experimentalDecorators`/`emitDecoratorMetadata`, the
table names stay renameable at runtime (which is the whole point of the scope-column seam), and the
family's `design:paramtypes` bundler fragility never touches this package. The cost is one factory
call — `dataSource.getRepository(entities.policy)` is fully typed.

```ts
// db/permissions-entities.ts
import { createPermissionsEntities } from "@nestm/permissions-typeorm";

export const permissionsEntities = createPermissionsEntities();
```

```ts
// db/data-source.ts
import { DataSource } from "typeorm";
import { permissionsEntities } from "./permissions-entities.ts";

export const dataSource = new DataSource({
	type: "postgres",
	url: process.env.DATABASE_URL,
	entities: [
		permissionsEntities.policy,
		permissionsEntities.link,
		permissionsEntities.scopeVersion,
	],
});
```

### 2. The tables

See [Migrations](#migrations) — three tiers, in order of preference. The shortest path:

```ts
import { PermissionsInitialMigration } from "@nestm/permissions-typeorm";

migrations: [PermissionsInitialMigration()];
```

### 3. The store

```ts
import { TypeOrmPolicyStore } from "@nestm/permissions-typeorm";

await dataSource.initialize();

const store = new TypeOrmPolicyStore(dataSource, {
	entities: permissionsEntities,
	poll: { intervalMs: 5000 },
});

// …then hand it to the engine
const permissions = await createEngine({ vocabulary, policyStore: store });
```

`entities` is optional. Omitted, the store builds the default triple and resolves it against the
`DataSource` **by entity name**, so a consumer who registered the factory's output from another
module is served correctly. Pass it when you used a `tablePrefix` or a custom scope column.

### 4. The plan, as a `WHERE` clause

```ts
import { applyPlan, createTypeOrmResourceMapping } from "@nestm/permissions-typeorm";

// once, at startup — property paths are resolved here, so a typo throws now
const runMapping = createTypeOrmResourceMapping(dataSource, {
	resourceType: "Run",
	entity: Run,
	id: "id",
	attributes: {
		status: { kind: "scalar", column: "status", valueKind: "string" },
		project: { kind: "entity", column: "projectId", entityType: "Project" },
	},
	hierarchy: {
		Run: { kind: "self" },
		Project: { kind: "column", column: "projectId" },
	},
});

// per request
const plan = await permissions.plan({ scope, principal, action: "run:read", resourceType: "Run" });

const rows = await applyPlan(
	dataSource.createQueryBuilder(Run, "run").where("run.organizationId = :org", { org }),
	plan,
	runMapping,
).getMany();
// WHERE run.organization_id = $1 AND ( <compiled> )
```

`applyPlan` uses `.andWhere()`, so it **appends**: a tenant filter already on the builder survives.
(The Drizzle driver's `applyPlan` documents the opposite, because drizzle's `.where()` replaces. The
compiled SQL is the same; only the composition idiom differs.)

## Migrations

Three tiers, in order of preference.

### Tier 1 — `typeorm migration:generate`

Register the entities in your `DataSource` and run the standard flow. Zero code from us.

```sh
typeorm-ts-node-esm migration:generate ./src/migrations/AddPermissions -d ./src/data-source.ts
```

`tests/integration/migrations.test.ts` pins that this produces the three tables, and that a second
run produces an **empty** diff — for both the default `text` scope column and a station-shaped
`uuid` one. A schema that re-generates a diff on every run is a schema whose consumers get a
spurious migration in every pull request.

> [!WARNING]
> **Tier 1 cannot emit the `GIN (cedar_json jsonb_path_ops)` index.** `EntitySchemaIndexOptions` has
> no `using`, so TypeORM would produce a _btree_ index over a `jsonb` column — legal, useless for
> `@>`, and silently so. The factory therefore omits it, and `permissionsPostgresIndexStatements()`
> hands you the statement:
>
> ```ts
> for (const statement of permissionsPostgresIndexStatements()) {
> 	await queryRunner.query(statement);
> }
> ```
>
> Having added it, **every subsequent `migration:generate` will contain a `DROP INDEX` line for
> it** — TypeORM's schema builder treats the entity as the truth and drops indexes it did not
> declare. Delete that line each time, go without the index (it serves only an admin-API "which
> policies mention `Run`?" query, never the authorization path), or use tier 2/3. This behaviour is
> asserted in the suite, not assumed.

### Tier 2 — `buildPermissionsMigration()`

Raw statements, so you can hand-append `GRANT`/RLS or your own foreign keys before committing.

```ts
const { up, down } = buildPermissionsMigration({
	dialect: "postgres",
	tablePrefix: "permission_",
	postgresPolicies: { role: "station_app" }, // optional GRANT/RLS extras
});
```

Statements come back without trailing semicolons, which is what `QueryRunner.query` wants. Only
`dialect: "postgres"` is implemented; `"mysql"`/`"sqlite"` throw a clear error, because the compiler
is Postgres-only (`@>`, `cardinality`, `inet`, `jsonb` have no portable spelling) and a migration
generator that outran it would create tables no plan could filter.

### Tier 3 — `PermissionsInitialMigration()`

The same statements as a `MigrationInterface` class, droppable into `migrations: [...]`.

```ts
migrations: [PermissionsInitialMigration({ tablePrefix: "permission_" })];
```

The default migration name is `PermissionsInitial1753900000000` — a **fixed** timestamp, because a
name that changed per process would re-run the migration on every deploy. TypeORM orders migrations
by the last 13 characters of the name, so pass `{ name: "…<13 digits>" }` to place it relative to
your own; a name TypeORM cannot parse is rejected at call time, not at migration time.

## The schema

Three tables, `${prefix}policies` / `${prefix}policy_links` / `${prefix}scope_versions`, with
`prefix` defaulting to `permission_`. The logical model — columns, primary keys, checks, index names
— is **identical to `@nestm/permissions-drizzle`'s**, so the two drivers can read each other's
tables and a project can migrate between them without touching the database.

| table            | what it holds                                                                                                                                                                                                                                                                                          |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `policies`       | static policies **and** templates (Cedar treats a template as a policy with slots), so "list everything in this scope" is one query. `kind` is `CHECK`ed, not trusted. `cedar_json` is the canonical form; `cedar_text` beside it is for humans and is never parsed back.                              |
| `policy_links`   | template links — the role-grant primitive. Slot values are **columns**, not a `values jsonb`, so "revoke every grant for member X" is an indexed statement. Both slot pairs are nullable with a pair `CHECK`: a template declaring only `?principal` must be linkable without inventing a `?resource`. |
| `scope_versions` | the invalidation stamp: one `bigint` per scope, bumped in the **same transaction** as the write it describes.                                                                                                                                                                                          |

**No foreign key is emitted from `links.template_id` to `policies.policy_id`.** The obvious
`ON DELETE CASCADE` turns "an operator deleted a template" into "every grant under it silently
disappeared", and core's conformance suite requires the opposite — an orphaned link must survive
into the bundle so `buildPolicySet` can refuse it loudly. Add the constraint in your own migration
if you want it, knowingly.

### The scope column is yours

The single most important schema decision: the tenant column is supplied by the consumer.

```ts
createPermissionsEntities({
	scopeColumn: {
		name: "organization_id",
		type: "uuid",
		toScope: (id) => `org:${id}`,
		fromScope: (scope) => scope.slice(4),
		supportsGlobalScope: false,
	},
});
```

`toScope`/`fromScope` are a pair of inverses and both directions are used: `fromScope` on every read
and write, `toScope` in the poller, which learns about scopes from the database rather than from the
caller. With `supportsGlobalScope: false` the store **rejects writes to `''`** and skips the global
half of the `load()` union entirely — a `NOT NULL uuid` column has no value that means "every
tenant", and inventing one is how a global policy leaks into a tenant's bundle.

### The link id column is yours too

`link_id` is `text` by default. A link id is core's `TemplateLinkRecord['id']` — a `string` on the
JavaScript side whatever the SQL type is — so this is a physical-schema choice, and the one that
matters is the foreign key. A deployment that reuses its own grant table's `uuid` primary key as the
link id needs a composite FK to `(tenant, id)`, and Postgres refuses one between `text` and `uuid`
("foreign key constraint cannot be implemented … incompatible types"):

```ts
createPermissionsEntities({
	scopeColumn: { name: "organization_id", type: "uuid", ...codec },
	linkIdColumn: { type: "uuid" }, // name defaults to 'link_id'
});
```

```sql
-- now expressible in your own migration
alter table "permission_policy_links"
	add constraint "permission_policy_links_role_grant_fk"
	foreign key ("organization_id", "link_id")
	references "role_grants" ("organization_id", "id") on delete cascade;
```

The TypeScript **property** name stays `linkId` — that is what the store reads — so only the SQL
name and type are yours. All three migration tiers honour it, and the drizzle driver's
`linkIdColumn: () => uuid("link_id").notNull()` produces the same DDL, so the two drivers still read
each other's tables.

### Row-level security

The store never invents a tenant or issues `SET`/`SET LOCAL`. Give it a
`TypeOrmPolicyStoreExecutor` to put every foreground operation on the request's tenant-pinned
`EntityManager`. The executor receives the exact scopes, access mode, isolation level, and commit
ownership that the operation requires:

```ts
import type { TypeOrmPolicyStoreExecutor } from "@nestm/permissions-typeorm";

const policyExecutor: TypeOrmPolicyStoreExecutor = {
	async run(execution, work) {
		// A tenant-only UUID scope column means every operation names exactly one scope.
		const [expectedTenantId] = execution.scopes;
		if (expectedTenantId === undefined || execution.scopes.length !== 1) {
			throw new Error("Policy operation must target exactly one tenant");
		}

		return tenantTypeOrmRlsExecutor.transaction(work, {
			accessMode: execution.access === "read-only" ? "read only" : "read write",
			isolationLevel: execution.isolationLevel,
			// A policy write emits its local watch event as soon as run() resolves. It
			// must therefore own a real commit, never only an ambient savepoint.
			propagation: execution.commitOwnership === "required" ? "reject" : "required",
			expectedTenantId,
		});
	},
};

const store = new TypeOrmPolicyStore(dataSource, {
	entities: permissionsEntities,
	executor: policyExecutor,
});
```

`load()` requests a read-only **repeatable-read** snapshot so policies, links, and their version
cannot straddle a concurrent write. Every mutation requests read-write access and commit ownership;
the store emits its synchronous cache-invalidation event only after `run()` resolves. The default
executor provides these guarantees with a dedicated TypeORM `QueryRunner` when no request-aware
executor is supplied.

`permissionsPostgresPolicyStatements({ role })` returns the `GRANT` and `ENABLE`/`FORCE ROW LEVEL
SECURITY` statements — byte-identical to the Drizzle driver's — for the two tenant tables. The
isolation `CREATE POLICY` itself is deliberately **not** generated: its `USING` clause is
application-specific and a guessed predicate is worse than none.

> [!IMPORTANT]
> **`scope_versions` is left unprotected by default, and that is the one thing a security reviewer
> must sign off on.** The invalidation poller runs `SELECT scope, version … WHERE updated_at > $1`
> with _no_ tenant context, because "which scopes changed?" is a question with no tenant. Under RLS
> it would return zero rows and no cache would ever invalidate. The table holds no tenant _data_ —
> only a monotonic counter keyed by tenant id, a cache-coherence channel — so what a cross-tenant
> read exposes is an integer saying "something changed". `tests/integration/rls.test.ts` asserts
> both halves: the policy tables are invisible without a context, and the counter is not. Set
> `rowLevelSecurityOnScopeVersions: true` only if you have also given the poller a context, or have
> accepted that invalidation stops.

## The store

`TypeOrmPolicyStore implements PolicyStore`, plus `watch`. Four contracts, each of which fails as
_wrong authorization_ rather than as a crash:

- **D1** — implementing `watch` is a promise that every write becomes an event. The engine stops
  polling `currentVersion` the moment a store implements it. Writes emit **synchronously after
  commit** (zero staleness for the writing replica); the poller covers the others with one query per
  tick regardless of tenant count.
- **D2** — `load(scope)` returns global (`''`) ∪ `scope`, versioned `g<n>:s<m>`, and **throws** when
  an id exists in both halves. Precedence between them is undefined, so a silent winner is a
  configuration error waiting to be a security incident.
- **D6** — a template declaring only `?principal` is linkable without inventing a `?resource`.
- Every write bumps its scope's version **in the same transaction**. A bump that committed
  separately would leave a window in which a replica loads the new policies under the old version
  and caches them forever.

`load()`'s three reads are **sequential, not `Promise.all`**, on the one manager supplied by a
read-only repeatable-read executor transaction. A manager bound to a query runner has exactly one
client, on which overlapping queries are removed in `pg@9`.

Options: `entities`, `tablePrefix`, `scopeColumn`, `executor` (foreground transaction/RLS seam),
`poll` (default `{ intervalMs: 5000 }`, `false` disables), `notify` (opt-in `LISTEN`/`NOTIFY` on a
**dedicated, non-pooled** connection you supply), `onError`. Background polling deliberately uses
the constructor's root `DataSource`, not the request executor, because it asks which scopes changed
across the whole process. A failed poll tick logs to `onError`, backs off exponentially to 60 s, and
leaves both the watermark and the cache untouched — stale-but-known beats empty, because an empty
policy set is `deny` everywhere downstream.

`dispose()` stops the poller and closes any `LISTEN` connection. It deliberately does **not** destroy
the `DataSource`, which belongs to whoever created it.

## `planToBrackets` / `applyPlan`

```ts
planToBrackets(plan, mapping, options?): Brackets         // the primitive
applyPlan(qb, plan, mapping, options?): typeof qb         // sugar: qb.andWhere(...)
applyPlanToSelect(qb, plan, mapping, options?)            // same, keeps the entity type
planToSql(plan, mapping, options?): { text, parameters }  // raw text, for a hand-written query
planNodeToBrackets(node, mapping, options?)               // a bare PlanNode
planNodeToSql(node, mapping, options?)
```

Options: `allowPermissiveApproximations`, `parameterPrefix`, `alias`.

### Mapping DSL

TypeORM has no equivalent of drizzle's `Column` value, so a mapping names columns by **property
path** and `createTypeOrmResourceMapping` resolves every one through
`EntityMetadata.findColumnWithPropertyPathStrict` — eagerly. A typo in `"publishedAt"` is an
`UnmappedAttributeError` when the mapping is built, listing the entity's real columns, rather than a
`column "publishedat" does not exist` from Postgres or, far worse, a query that filters on nothing.
The emitted identifier is `qb.escape(column.databaseName)`, straight from the metadata: **no string
a caller supplied ever reaches the SQL text.**

```ts
type TypeOrmAttributeMapping =
	| { kind: "scalar"; column: string; valueKind: TypeOrmScalarKind }
	| {
			kind: "entity";
			column: string;
			entityType: string;
			hierarchy?: Record<string, TypeOrmHierarchyMapping>;
	  }
	| { kind: "array"; column: string; elementKind: TypeOrmScalarKind }
	| { kind: "jsonPath"; column: string; path: readonly string[]; valueKind: TypeOrmScalarKind };

type TypeOrmHierarchyMapping =
	| { kind: "self" } // parent type == this type
	| { kind: "column"; column: string } // denormalised ancestor id
	| { kind: "closure"; entity: EntityTarget; ancestor: string; descendant: string }
	| { kind: "recursive"; entity: EntityTarget; parentColumn: string; idColumn: string };
```

`TypeOrmScalarKind` is `string | long | bool | datetime | duration | decimal | ipaddr`.

**Cedar's `in` is reflexive** — `X in X` is true — so a hierarchy over a parent whose type equals the
resource type compiles to `id = $p`, not `parent_col = $p`. That is the `{ kind: "self" }` case, and
getting it wrong is a silent over-block on the very query a role-grant system exists for. A mapping
for the parent type is **required** even then: writing `{ kind: "self" }` is asserting "this type
does not nest under itself", which the compiler has no other way to learn.

Prior art: the property-path resolution is what `@ucast/sql/typeorm` does. It was studied, not
depended upon — its AST has no tokenised `LIKE`, no `inHierarchy` and no three-state plan.

### The fail-closed contract

> `planToSql` / `planToBrackets` compile **exactly** the `PlanNode` grammar. Anything a mapping does
> not cover raises a `PlanCompilationError` before any SQL is produced. There is no configuration in
> which an uncompilable node becomes `TRUE`.

Each of these **throws**, never degrades — `PlanCompilationError.reason` is the discriminant:

| `reason`                   | when                                                                                                                  |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `unmapped-attribute`       | the plan reads an attribute the mapping does not declare, or a mapping names a property path the entity does not have |
| `unmapped-hierarchy`       | an `inHierarchy` node names a parent type with no strategy                                                            |
| `unorderable-comparison`   | `<`/`<=`/`>`/`>=` over a kind Cedar does not order (a string, above all)                                              |
| `contains-on-scalar`       | `contains`/`isEmpty` against a scalar column                                                                          |
| `entity-column-mismatch`   | an entity constant against a non-entity column, or vice versa                                                         |
| `case-insensitive-like`    | `like` against a column declared `collation: "case-insensitive"`                                                      |
| `permissive-approximation` | the plan widens and the caller has not opted in                                                                       |
| `resource-type-mismatch`   | `plan.resourceType` is not the mapping's                                                                              |
| `value-kind-mismatch`      | a `PlanValue` kind the mapped column cannot hold                                                                      |
| `invalid-mapping`          | a structurally unusable mapping, or an unknown entity                                                                 |

A permissive approximation needs **both** halves of the opt-in: `allowPermissiveApproximations: true`
_and_ a `plan.postFilter` to re-check the rows. `ALWAYS_DENY` is exempt — it selects nothing.

Compilation happens **eagerly**, at the `planToBrackets`/`applyPlan` call, not lazily inside
TypeORM's query builder: a failed compile leaves your builder exactly as it was rather than
half-filtered, and the stack trace points at your call site.

`isPlanCompilationError(value)` matches on `code`/`reason` rather than on the class, so it works
across bundle duplication _and_ across the two drivers: an application using both catches one shape.

### Why NULL is safe here

The assembled condition is `OR(permits) AND NOT(OR(forbids))`. SQL's three-valued logic makes any
NULL-touching subterm propagate to NULL, and a top-level NULL excludes the row. Under this shape
that is _uniformly restrictive_: a NULL inside a permit drops the row, and a NULL inside a forbid
makes `NOT NULL` NULL, which also drops the row. A nullable column mapped to a Cedar optional
attribute is therefore fail-closed by construction — and it agrees with Cedar, where reading an
absent attribute errors the policy into `false`, and with core's reference interpreter, which is
three-valued for exactly this reason.

Two consequences, both load-bearing: **never wrap the compiled condition in `COALESCE(…, true)`**,
and **never emit `NOT IN` against a nullable subquery**. Every negation this compiler emits is
`NOT (…)` over an expression it produced, and every membership test is a bound literal list.

### Value binding

Every value is a bind parameter; nothing is concatenated. The casts are the interesting part, and
they are identical to the Drizzle driver's:

| kind                        | binding                                     | why                                                                                                                                                                  |
| --------------------------- | ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `string`, `bool`, entity id | `:p` — no cast                              | an explicit `::text` breaks on `citext`, an enum or a `uuid`; Postgres resolves an unknown-typed parameter from the column                                           |
| `long`, `duration`          | `:p::bigint`, value as text                 | `PlanValue.long` is a `bigint`; `Number(value)` rounds silently past 2^53                                                                                            |
| `datetime`                  | `:p::timestamptz`, ISO-8601                 | a `Date` handed to a driver renders in whatever timezone it feels like                                                                                               |
| `decimal`                   | `:p::numeric`, Cedar literal text           | `decimal("1.5") == decimal("1.50")` is true in Cedar; `numeric` agrees, text does not                                                                                |
| `ipaddr`                    | `:p::inet`, Cedar literal text              | Cedar's `==` compares address **and** prefix (errata 21); `inet` has exactly those semantics, text equality gets five of nine documented cases wrong                 |
| set                         | `col @> ARRAY[…]::t AND col <@ ARRAY[…]::t` | Cedar sets are unordered and duplicate-insensitive; array `=` is ordered and element-wise                                                                            |
| `like`                      | `col LIKE :p ESCAPE :e`, both bound         | Cedar has no `\%` escape at all, so `%`/`_` reach the driver as ordinary text                                                                                        |
| jsonPath                    | `(col #>> :p::text[])::<cast>`              | the path is **one** bound `text[]`, never spliced per element; `#>>` yields SQL NULL for both a missing key and a JSON `null`, which is what "absent" means to Cedar |

### Parameter names

TypeORM parameters are **query-builder-global** — a `Brackets` factory receives a child builder whose
`expressionMap.parameters` is the _same object_ as the parent's. A reused name is not an error
anywhere in TypeORM: the second write wins and _both_ placeholders resolve to it, producing a
syntactically perfect query that selects the wrong rows.

Names are `${prefix}_${n}` with `prefix` defaulting to `nestmp`, and the counter is **seeded from the
builder's existing parameters**, so two `applyPlan` calls on one builder — or one beside a
hand-written `.andWhere("x = :p")` — cannot collide. `tests/unit/parameter-collision.test.ts` pins
it, including nesting inside your own `Brackets`. Pass `parameterPrefix` if you want the generated
names to be visibly yours.

## NestJS

```ts
@Module({
	imports: [
		TypeOrmModule.forRoot({/* …, entities: [policy, link, scopeVersion] */}),
		PermissionsTypeOrmModule.forRootAsync({
			inject: [DataSource],
			useFactory: (dataSource: DataSource) => ({ dataSource, store: { entities } }),
		}),
		PermissionsModule.forRoot({ vocabulary, store: { useExisting: TypeOrmPolicyStore } }),
	],
})
export class AppModule {}
```

The module provides and exports one `TypeOrmPolicyStore` under its class token and is **global** by
default (a second instance means a second poller and a second `LISTEN` connection). Its
`onApplicationShutdown` disposes the store and leaves the `DataSource` alone — destroying someone
else's pool at shutdown turns a graceful stop into a stack of "connection terminated" errors.

## Entry points

| entry       | contents                                                               | pulls in                             |
| ----------- | ---------------------------------------------------------------------- | ------------------------------------ |
| `.`         | entities, migrations, store, compiler, errors                          | `typeorm`, `@nestm/permissions-core` |
| `./nestjs`  | `PermissionsTypeOrmModule`                                             | `+ @nestjs/common`                   |
| `./testing` | conformance harness, `typeormStoreFactory`, core's oracles re-exported | `+ @nestm/permissions-core/testing`  |

`tests/unit/exports.test.ts` asserts the base entry imports no `@nestjs/*` and does not instantiate
the Cedar WASM.

## Limitations

- **Postgres only.** The compiler emits `@>`, `cardinality`, `#>>`, `inet` and `WITH RECURSIVE`.
  `buildPermissionsMigration` throws for `mysql`/`sqlite` rather than emitting statements no plan
  could filter; tier 1 works for any dialect TypeORM supports, but the compiler will not.
- **TypeORM 1.1+ only.** `0.3.x` (dist-tag `legacy`) is out of scope.
- **`EntitySchema`, not decorated classes.** `dataSource.getRepository(entities.policy)` is fully
  typed; there is no `@Entity()` class to extend.
- **Depth-1 attributes.** A compiled plan never reads deeper; nested access needs a join the planner
  cannot know about and is rejected upstream.
- **Longs outside ±2^53** cannot cross the plan's JSON boundary at all (core errata 11/24).
- **No reverse queries** ("who can act on this row").

## Testing

`@nestm/permissions-typeorm/testing` exports core's `PolicyStore` conformance suite plus a factory
that provisions real tables through `buildPermissionsMigration` — so every conformance assertion is
also an assertion about the shipped migration.

```ts
import {
	runPolicyStoreConformanceSuite,
	typeormStoreFactory,
} from "@nestm/permissions-typeorm/testing";

runPolicyStoreConformanceSuite("TypeOrmPolicyStore", typeormStoreFactory(process.env.PG_URL));
```

This package's own suites need a real Postgres 16 (`docker compose up -d` from the repository root,
then `PG_URL=…`). They are differential by design — a missing server is a **failure**, not a skip;
`PG_SKIP=1` opts out deliberately. Everything is provisioned into a unique Postgres **schema** per
worker, so parallel files and the Drizzle driver's suites can share one server.

The flagship is `tests/property/differential.test.ts`: for each generated policy set it computes
three row sets — real `cedar-wasm` `check()` per row, core's reference interpreter over the same
rows, and `SELECT … WHERE <compiled>` against Postgres — and asserts **all three are equal**, across
three mappings (column+recursive, closure+recursive, and every scalar through a `jsonb` document).
Tune with `TYPEORM_DIFFERENTIAL_RUNS` and `TYPEORM_LIKE_FUZZ_RUNS`.

## Errors

`PlanCompilationError` (with `UnmappedAttributeError` / `UnmappedHierarchyError` subclasses) for the
compiler; core's `PermissionsError` with code `POLICY_STORE` for everything the store raises, so a
caller branches on one code.

## License

BSD-3-Clause.
