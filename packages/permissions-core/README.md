# @nestm/permissions-core

> [!CAUTION]
> Alpha. Published under the `alpha` tag; every release may break. Do not use this in production.

Typed, multi-tenant authorization for Node, built on [Cedar](https://www.cedarpolicy.com/) — AWS's
formally verified policy language — with **zero framework dependencies**.

You describe your domain once as a **vocabulary**; you get a Cedar schema for the engine and
TypeScript string-literal unions for your call sites, so `check({ action: "run:dispatch", resource:
{ type: "Project", … } })` is a **compile error** rather than a guaranteed `deny` discovered in
production. Policies live in a `PolicyStore` you control (in-memory here, Postgres in the ORM driver
packages) and are editable at runtime, per tenant, without a deploy.

This package has zero NestJS dependencies — enforced statically by
`scripts/assert-core-framework-free.mjs` and black-box by the `core-framework-free` CI job — so it
runs anywhere Node does. The 4.1 MiB Cedar WASM stays behind a lazy dynamic import, so importing the
vocabulary builder from a browser bundle costs nothing.

## Install

```sh
npm install @nestm/permissions-core@alpha
```

`@cedar-policy/cedar-wasm` is a hard dependency, exact-pinned during alpha. Node >= 22.12, ESM only.

## Quick start

```ts
import {
	createEngine,
	defineVocabulary,
	entity,
	loadCedar,
	MemoryPolicyStore,
	policyRecordFromText,
	t,
} from "@nestm/permissions-core";

// 1. One vocabulary: the Cedar schema and your TypeScript unions, from one source.
const vocabulary = defineVocabulary({
	namespace: "Station",
	entities: {
		Project: {},
		Member: { attrs: { identitySubject: t.string() } },
		Run: { memberOf: ["Project"], attrs: { status: t.string() } },
	},
	actions: {
		"run:read": { principal: ["Member"], resource: ["Run"] },
	},
});

// 2. Policies. A template is the role-grant primitive: one template, one link per grant.
const cedar = await loadCedar();
const scope = "org:acme";

const policyStore = new MemoryPolicyStore({
	policies: [
		policyRecordFromText(cedar, {
			id: "role:reader",
			scope,
			text: `permit(principal == ?principal, action == Station::Action::"run:read", resource in ?resource);`,
		}),
		policyRecordFromText(cedar, {
			id: "forbid:archived",
			scope,
			text: `forbid(principal, action == Station::Action::"run:read", resource is Station::Run) when { resource.status == "archived" };`,
		}),
	],
	links: [
		{
			id: "grant:alice-nightly",
			scope,
			templateId: "role:reader",
			values: {
				"?principal": { type: "Member", id: "alice" },
				"?resource": { type: "Project", id: "nightly" },
			},
			updatedAt: new Date(),
		},
	],
});

// 3. Entities. Return the principal's ancestors and the resource's parents — never more.
const entityProvider = {
	async resolvePrincipal({ principal }) {
		return [
			entity(vocabulary, "Member", principal.id, {
				attrs: { identitySubject: `auth0|${principal.id}` },
			}),
		];
	},
	async resolveResource({ resource }) {
		if (resource === undefined) return [];
		return [
			entity(vocabulary, "Run", resource.id, {
				attrs: { status: resource.id === "run-2" ? "archived" : "queued" },
				parents: [{ type: "Project", id: "nightly" }],
			}),
		];
	},
};

// 4. The engine.
const engine = await createEngine({ vocabulary, policyStore, entityProvider });

const granted = await engine.check({
	scope,
	principal: { type: "Member", id: "alice" },
	action: "run:read",
	resource: { type: "Run", id: "run-1" },
});
console.log(granted.allowed, granted.determiningPolicyIds); // true [ 'grant:alice-nightly' ]

const forbidden = await engine.check({
	scope,
	principal: { type: "Member", id: "alice" },
	action: "run:read",
	resource: { type: "Run", id: "run-2" }, // archived: forbid always beats permit
});
console.log(forbidden.allowed, forbidden.determiningPolicyIds); // false [ 'forbid:archived' ]

const stranger = await engine.check({
	scope,
	principal: { type: "Member", id: "bob" }, // no grant: Cedar denies by default
	action: "run:read",
	resource: { type: "Run", id: "run-1" },
});
console.log(stranger.allowed, stranger.determiningPolicyIds); // false []

await engine.dispose();
```

Revoking that grant is `policyStore.unlinkTemplate(scope, "grant:alice-nightly")`. The engine picks
it up on the next check — no restart, no cache to flush by hand.

### Just the vocabulary

A vocabulary is the artefact an application shares with everything that _talks about_ its
permissions rather than enforcing them: an admin UI, a code generator, a docs build, a test fixture,
a package of shared types. Those consumers want `defineVocabulary` and nothing else, so it has its
own entry:

```ts
import { defineVocabulary, entity, entityGraph, t } from "@nestm/permissions-core/vocabulary";
```

`defineVocabulary` is pure TypeScript — Cedar validation happens on demand and at engine creation,
never in the builder — so this entry reaches neither the engine, nor the policy-store SPI, nor the
4.1 MiB Cedar WASM. `tests/unit/vocabulary-entry.test.ts` asserts that with the same
`__cedarLoaded()` probe `./plan` uses. `validateVocabulary`, `assertVocabularyValid`, `schemaOf` and
`renderVocabularySchemaText` are deliberately **not** here: each asks Cedar whether a schema is
valid, so the WASM is the whole point of them, and they stay on the main barrel.

## API

| Member                          | What it does                                                                                                            |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `check(request)`                | One decision. Action-typed: principal, resource and context all narrow to what it declares.                             |
| `checkMany(requests)`           | Many decisions in order, sharing one policy-set lookup per scope and one principal resolution per `(scope, principal)`. |
| `checkUnsafe(request)`          | `check` with plain strings. The escape hatch for an action id that is only a `string` at the call site.                 |
| `plan(request)`                 | Which rows of a resource type the principal may act on, as a three-state [`QueryPlan`](#query-plans).                   |
| `warm(scope)`                   | Preloads a scope's policy set, probing the store's version first.                                                       |
| `invalidate(scope \| '*')`      | Marks a scope stale in every cache; compiled plans are dropped outright, not served stale.                              |
| `invalidateEntity(ref, scope?)` | Drops one cached entity graph. For membership changes no policy event describes.                                        |
| `validatePolicies(scope)`       | Cedar's validator over a scope, as a report. What an admin UI calls before saving.                                      |
| `stats()`                       | Counters for every cache the engine owns, plus check/allow/deny/errored totals.                                         |
| `dispose()`                     | Releases every WASM policy-set id. Terminal: later checks throw `ENGINE_INIT`.                                          |

### Options

| Option                | Default                                    | Notes                                                                                                                     |
| --------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| `vocabulary`          | —                                          | Required. The output of `defineVocabulary`.                                                                               |
| `policyStore`         | —                                          | Required. `MemoryPolicyStore`, `CompositePolicyStore`, or your own.                                                       |
| `entityProvider`      | —                                          | Optional only if every request passes `entities`. Neither is an `ENTITY_RESOLUTION` error, never an implicit empty graph. |
| `namespace`           | `vocabulary.namespace`                     | Cedar namespace used to qualify types.                                                                                    |
| `instanceId`          | `perm-` + random hex                       | Prefix of every WASM policy-set id. Must be unique per engine in the process.                                             |
| `policySetCache`      | `{ maxScopes: 256, staleAfterMs: 30_000 }` | `staleAfterMs` applies only when the store cannot `watch`.                                                                |
| `planCache`           | `{ max: 2000, ttlMs: 30_000 }`             | Compiled-plan LRU. A requirement, not an optimisation: partial evaluation cannot use the preparse cache.                  |
| `unsupportedResidual` | `'error'`                                  | What `plan()` does when dropping a subterm would **widen** the result. See [the fail-closed contract](#query-plans).      |
| `onErroredPolicy`     | `'error'`                                  | What `plan()` does when Cedar reports errored policies. `'deny-all'` is the safe alternative; `'ignore'` is unsafe.       |
| `maxPostFilterRows`   | `500`                                      | Circuit breaker on `plan.postFilter`, which runs one Cedar decision per row.                                              |
| `entityCache`         | `false`                                    | Cross-request principal-graph cache. Opt-in; see [below](#the-entity-cache-is-off-by-default).                            |
| `validateOnLoad`      | `true`                                     | Cedar `validate()` on every policy-set load; a failure **rejects the load**.                                              |
| `validateRequests`    | `true`                                     | Passes the schema per call so Cedar rejects a malformed request instead of quietly denying.                               |
| `onDecision`          | —                                          | Synchronous audit sink. Never awaited; a throw is swallowed.                                                              |
| `redactContext`       | keys only                                  | Applied to the request context before it reaches `onDecision`.                                                            |
| `clock`               | `Date.now`                                 | Milliseconds. Used for cache freshness and `durationMs`. Pass `() => performance.now()` for a meaningful `durationMs`.    |
| `cedar`               | `loadCedar()`                              | Binding seam, for unit tests and future worker-thread bindings.                                                           |

## What happens at runtime

Every design decision below follows from behaviour measured against `cedar-wasm@4.12.0`, recorded in
[`docs/design/core.md`](../../docs/design/core.md) §0.

**Policy sets are preparsed, once per scope.** `statefulIsAuthorized` against a preparsed set is
0.136 ms/op; the stateless call is 1.98 ms/op — a 14.6x difference, so preparsing is mandatory rather
than an optimisation. The WASM id is `` `${instanceId}:${scope}` ``, **stable forever and never
version-suffixed**: 2000 distinct ids cost +126 MB RSS with no unregister API, while re-preparsing
the _same_ id 2000 times costs +6 MB. Staleness is handled by overwriting in place.

**Freshness is event-driven.** A store that implements `watch` is trusted: the engine never calls
`currentVersion` on the check path, because a database round-trip per check would erase the whole
0.136 ms number. A store without `watch` falls back to revalidating after `staleAfterMs`.

**Eviction is an overwrite with an empty policy set.** That is the only primitive cedar-wasm offers,
and it is what `maxScopes` pressure, `evict` and `dispose` all use. The consequence is worth stating
plainly: an evicted id stays **registered** and answers `deny` — fail-closed, never fail-open — so a
policy set that has been released can never accidentally authorize. It also means "id not found"
cannot be used to detect eviction; that failure only ever means "never preparsed in this WASM
instance", which is why `check()` retries it exactly once (re-preparse, retry) before surfacing
`POLICY_SET_NOT_PREPARED`.

**Pass a narrow entity graph.** Adding 500 irrelevant entities to a request took the same check from
0.136 ms to 2.79 ms. `EntityProvider` is split into `resolvePrincipal` / `resolveResource` /
`resolveAdditional` precisely so you return the principal plus its ancestors, the resource plus the
parents its policies traverse, and nothing else. During `plan()`, there is no resource instance;
the request instead carries `resourceType`, so additional resolution can still select the right
dependencies without loading an arbitrary row.

**A failed reload never empties a tenant.** If a load, a compile or `validateOnLoad` fails, the
previously prepared policy set stays resident and keeps answering; the error reaches the caller that
triggered the reload. A bad policy write degrades to "the new policies did not take effect", never to
"the tenant lost all policies".

**An invalidation cannot disappear behind an in-flight load.** Per-scope and global generations are
captured before every load. If `watch()` reports a change before that bundle is preparsed, the same
single-flight retries and every waiting caller receives a post-invalidation snapshot.

### The errored-policy trap, and the two things that close it

A Cedar policy whose condition reads an attribute the entity does not carry does **not** evaluate to
`false` — it _errors_, and an errored `forbid` is dropped from the decision entirely. A typo silently
disables a deny rule. Two defences ship on by default:

- **`entity()`** refuses to build an entity whose attributes disagree with the vocabulary — unknown
  name, missing required attribute, wrong type, or a parent type the schema does not allow. The typo
  becomes a `SchemaValidationError` thrown by the line that wrote it.
- **`validateOnLoad`** runs Cedar's validator over every policy set as it loads and rejects the load
  on any error. That catches the policy side: an unknown entity type, an attribute the schema does
  not declare, and — worth knowing before it surprises you — an **unguarded read of an optional
  attribute**. `context.mfa == true` is a validation error; write `context has mfa && context.mfa ==
true`.

When a policy errors anyway, `CheckResult.policyErrors` is non-empty. Treat that as an alert, not as
debug output: on an `allow`, it means the allow may be wrong.

### The entity cache is off by default

`entityCache` is a cross-request LRU over resolved principal graphs, and enabling it is an explicit
trade. Graphs are reused for `ttlMs` (default 30 s), so a role granted elsewhere becomes visible to
Cedar only after the entry expires. Policy changes invalidate it automatically; **membership changes
do not** — call `engine.invalidateEntity(ref)` from whatever writes them.

Per-request reuse is a different tier and is the caller's job: resolve the principal once per HTTP
request and pass `entities` explicitly, or batch through `checkMany`, which shares one resolution per
`(scope, principal)` without any cache at all.

## Query plans

`check()` answers "may this principal act on **this** row". `plan()` answers "**which** rows", by
leaving the resource unknown and compiling Cedar's residuals into a driver-neutral filter.

```ts
const plan = await engine.plan({
	scope: "org:8f3e",
	principal: { type: "Member", id: "m1" },
	action: "run:read",
	resourceType: "Run",
});

switch (plan.kind) {
	case "ALWAYS_DENY":
		return [];
	case "ALWAYS_ALLOW":
		return db.select().from(runs);
	case "CONDITIONAL":
		// planToSql / planToBrackets ship with the ORM driver packages.
		return db.select().from(runs).where(planToSql(plan.condition, mapping));
}
```

The three states come from Cedar directly (`decision: 'allow' | 'deny' | null`); nothing is inferred.
`plan.condition` is a small AST — `and`/`or`/`not`/`cmp`/`in`/`contains`/`like`/`exists`/`isEmpty`/
`isType`/`inHierarchy` — with typed `PlanValue` operands, so a driver **binds** parameters and never
interpolates. `like` carries Cedar's own **tokens** rather than a rendered pattern, because
re-serialising them is how a literal `%` in a policy becomes a wildcard in SQL; render them with
`likeTokensToPattern` from `@nestm/permissions-core/plan`.

### The fail-closed contract

> A query plan is **sound** iff the row set selected by `condition` equals the set of rows for which
> `check()` would return `allow`. `@nestm/permissions-core` never returns an unsound plan silently.

The assembled condition is `OR(permits) AND NOT(OR(forbids))`, and a subterm that cannot be pushed
into a query is replaced by `true`. Which way that moves the result depends on the policy's effect
and on how many `not`s enclose the subterm:

| Subterm in | Polarity | Effect of replacing it with `true`    | Verdict                 |
| ---------- | -------- | ------------------------------------- | ----------------------- |
| `permit`   | positive | widens `OR(permits)` → superset       | **permissive** — unsafe |
| `permit`   | negative | `!true` drops the permit → subset     | restrictive — safe      |
| `forbid`   | positive | widens the forbid, `NOT()` → subset   | restrictive — safe      |
| `forbid`   | negative | `!true` deletes the forbid → superset | **permissive** — unsafe |

A restrictive approximation is taken silently-but-recorded: it over-blocks, which is never a leak, and
it lands in `plan.approximations` with a message. A **permissive** one is refused: `plan()` throws
`UnsupportedResidualError` (`UNSUPPORTED_RESIDUAL`) naming the policy and the offending expression.
Set `unsupportedResidual: 'post-filter'` to get a widened plan plus `plan.postFilter(rows, {
rowToResource })`, which re-checks every row through Cedar — correct, `O(n)`, and it breaks
database-side pagination, so it is capped at `maxPostFilterRows` and is a migration aid rather than a
steady state. A function gets to decide per subterm.

### What can be pushed down

Supported on a **depth-1 attribute of the resource**: `==`, `!=`, `<`, `<=`, `>`, `>=` (Cedar emits
the last two as `!(<=)` / `!(<)`; they are recovered), `resource is T`, `resource in Entity::"id"`
and `resource.attr in Entity::"id"`, `[…].contains(attr)` and `attr.contains(constant)`, `like`,
`has`, `isEmpty`, `if-then-else` (when all three branches translate), a bare boolean attribute, and
constants including `datetime`, `duration`, `decimal` and `ipaddr` literals.

Refused, every one of them fail-closed: nested attribute access (`resource.owner.dept` — that needs a
join the core cannot know about), unknowns on both sides, arithmetic, `getTag`/`hasTag`,
`containsAll`/`containsAny`, an extension function applied to the resource, record literals, `in`
with anything but one concrete entity, `resource == Entity::"id"` (row identity, which no plan node
expresses), and an unknown rooted at the wrong variable.

### Errored policies refuse to plan

The same trap as on the check path, sharper. An errored policy gets a `{"Value": false}` residual, so
an errored **`forbid` disappears from the plan entirely** and rows it was meant to hide come back.
`plan()` therefore throws `ErroredPolicyError` (`ERRORED_POLICY`) whenever Cedar reports any errored
policy. `onErroredPolicy: 'deny-all'` is the safe alternative; `'ignore'` exists, is documented as
unsafe, and records a `permissive` approximation for every forbid it drops.

### Plan caching

`isAuthorizedPartial` is 2.28 ms/op and `PartialAuthorizationCall` has no `preparsedPolicySetId`
field, so a plan cannot use the preparse cache at all — roughly 17 stateful checks per plan. The
plan LRU is therefore a requirement. Its key covers the instance, scope, policy-set version, action,
resource type, canonical context, vocabulary hash **and the whole resolved entity graph** — not just
the principal's ancestors, because a residual folds `principal.<attr>` into a literal. A policy change
drops the affected plans rather than marking them stale.

## Testing oracles (`@nestm/permissions-core/testing`)

Correctness here is only checkable **differentially**, so the oracles ship as part of the package.
Driver authors import them; this package runs them against itself.

### `evaluatePlanNode` — the reference plan interpreter

Run your generated SQL over a fixture table, run this over the same rows, assert set equality. If the
two disagree, exactly one of them is selecting rows Cedar never authorized.

```ts
import { evaluatePlanNode, filterRowsByPlan } from "@nestm/permissions-core/testing";

const plan = await engine.plan({ scope, principal, action: "run:read", resourceType: "Run" });
if (plan.kind === "CONDITIONAL") {
	const expected = filterRowsByPlan(rows, plan.condition, {
		rowId: (row) => row.id,
		resourceType: "Run",
		hierarchy: ({ attr, rowId, parent }) => isDescendantOrSelf(attr, rowId, parent),
	});
	expect(new Set(sqlRows.map((r) => r.id))).toEqual(new Set(expected.map((r) => r.id)));
}
```

A `PlanRow` maps **depth-1** attribute names to JavaScript values. The rules a driver has to
reproduce:

| `PlanValue` kind | row value                                  | comparison                                                   |
| ---------------- | ------------------------------------------ | ------------------------------------------------------------ |
| `string`         | `string`                                   | code-unit exact, **case-sensitive**                          |
| `long`           | `number` (integer) or `bigint`             | exact, via `bigint`                                          |
| `bool`           | `boolean`                                  | identity                                                     |
| `entity`         | id `string`, or `{ type, id }`             | a bare string compares against the id alone                  |
| `datetime`       | `Date`, ISO-8601 `string`, or epoch millis | instant                                                      |
| `duration`       | `number` / `bigint` milliseconds           | signed milliseconds                                          |
| `decimal`        | `string`, `number` or `bigint`             | fixed-point at Cedar's 4 fractional digits — `1.5 == 1.50`   |
| `ipaddr`         | `string`                                   | parsed to (family, address bytes, prefix length) — see below |
| `set`            | `readonly unknown[]`                       | unordered and duplicate-insensitive — `[1,2,2] == [2,1]`     |

Three behaviours are load-bearing and were each verified against `cedar-wasm@4.12.0`:

- **Three-valued, like SQL.** A leaf reading an attribute the row does not have (`undefined`, `null`,
  or an absent key) is UNKNOWN, not `false`, and UNKNOWN propagates by Kleene's rules before
  collapsing to `false` at the top — exactly what `WHERE <expr>` does to a NULL. Two-valued logic
  would disagree with every driver on `NOT(col = 'x')` over a nullable column.
- **Cedar `in` is reflexive.** `inHierarchy` is descendant-**or-self**, so a driver's `self` mapping
  compiles to `id = $1`, not to an ancestor lookup. Getting this wrong is a silent over-block.
- **`ipaddr` equality compares the address, not the network.** `ip("1.2.3.4") == ip("1.2.3.4/32")` is
  true; `ip("1.2.3.0/24") == ip("1.2.3.1/24")` is false. Zero-compression and hex case are not
  significant. `<`/`<=` never reach an `ipaddr` — `assertOrderable` rejects the kind.

A row value whose JavaScript type cannot represent the constant it is compared against **throws**
rather than answering `false`: this is a test oracle, and a silent `false` would hide a
fixture/vocabulary mismatch behind a passing differential. Per **D7**, a tree containing `inHierarchy`
with no `hierarchy` resolver throws too — eagerly, before any row is read, so a short-circuited branch
cannot hide the misconfiguration.

### `runPolicyStoreConformanceSuite` — the shared store contract

The `PolicyStore` SPI _is_ this suite. `MemoryPolicyStore` runs it here; the TypeORM and Drizzle
stores run the same function, so "conformant" means one thing rather than three.

```ts
import { runPolicyStoreConformanceSuite } from "@nestm/permissions-core/testing";

runPolicyStoreConformanceSuite("DrizzlePolicyStore", async () => {
	const db = await freshDatabase();
	return { store: new DrizzlePolicyStore(db), teardown: () => db.destroy() };
});
```

`describe`/`it`/`expect` default to the ambient globals and can be injected as a third argument. Each
case builds its own store through the factory and tears it down afterwards, so no `beforeEach` is
needed and state cannot leak between cases. Return `supportsGlobalScope: false` (a `NOT NULL` tenant
column has no row for `''`), `supportsWatch: false`, or `readOnly: true` to have those groups
announce themselves as skipped rather than fail.

`readOnly: true` is for a store whose policies are managed elsewhere. Every case in the suite seeds
its own fixture through `save`/`linkTemplate`, so a store that cannot write has nothing to say about
round-trips, versions, isolation or change events — and asserting them anyway would fail a store
behaving exactly as designed. The flag skips those groups and runs the read-only contract instead:
`load` is well-shaped, `currentVersion` agrees with it, and all four write methods **reject**.

It covers: load/save/delete/link/unlink round-trips, version monotonicity and the composite
`g<n>:s<m>` semantics, cross-scope isolation, the global ∪ scope union including the id-collision
throw, **D6** partial slot values, `watch` emission per scope and as `'*'`, defensive-copy semantics
in both directions, and dangling links surfacing at build time instead of as a silent revocation.

### Externally-managed policies: `readOnlyPolicyStore`

`PolicyStore` has seven members and the engine calls **two** on the authorization path: `load` and
`currentVersion`. The other four exist for consumers who administer policies through this package —
and a large class of deployments does not. When policies and links are a _projection_ of your own
tables, written by the transaction that writes the source row, a write arriving through the SPI is
not merely unused: it is a second, unsynchronised write path.

```ts
import { readOnlyPolicyStore } from "@nestm/permissions-core";

const store = readOnlyPolicyStore(
	{
		load: (scope) => projection.bundleFor(scope),
		currentVersion: (scope) => projection.revisionOf(scope),
		watch: (listener) => projection.onChange(listener), // optional
	},
	{ name: "StationPolicyProjection", hint: "Write roles/role_grants instead." },
);
```

Three methods instead of seven, and the four write methods **reject** with `POLICY_STORE` rather
than resolving. That is the whole point: a hand-written `async save() {}` reports success to its
caller, the next `load()` does not show the record, and the difference surfaces much later as an
authorization decision that should have changed and did not. `save([])` and `delete(scope, [])`
reject too — a writable store treats an empty batch as a no-op, which would make "nothing to do" and
"this store cannot write" the same observation.

`watch` is forwarded only when the source has one. Synthesising a never-firing `watch` would stop
the cache polling `currentVersion` (D1) and freeze every decision at its first value.

`ReadOnlyPolicyStore` is structurally `PolicyStore` minus the writes, so every existing store already
satisfies it — wrapping a writable store is how you freeze one.

### Test-suite knobs

| Variable                    | Default | Effect                                                                  |
| --------------------------- | ------- | ----------------------------------------------------------------------- |
| `PLAN_PROPERTY_RUNS`        | `75`    | fast-check runs for the plan-soundness property (~2 s; 600 takes ~13 s) |
| `LIKE_FUZZ_RUNS`            | `60`    | fast-check runs for the LIKE fuzz                                       |
| `CEDAR_CORPUS_LIMIT`        | unset   | caps the auto-generated Cedar corpus cases; reported, never silent      |
| `CEDAR_CORPUS_ENGINE_LIMIT` | `500`   | caps the engine-level corpus subset                                     |

`pnpm bench` runs the four §0 benchmarks; `vitest.config.ts` scopes `benchmark.include` to
`tests/**/*.bench.ts` so they never join a normal `pnpm test`.

## Limitations

- **No `WHERE`-clause compilers yet.** `planToSql` / `planToBrackets` ship with
  `@nestm/permissions-typeorm` and `@nestm/permissions-drizzle`.
- **Longs above 2^53 have already been rounded.** Cedar longs are i64, but a residual crosses the WASM
  boundary as JSON, so `9007199254740993` arrives as `...992`. `PlanValue` carries a `bigint` to keep
  the driver side exact; it cannot undo the rounding.
- **Plans model Cedar's total semantics, not its error semantics.** A policy that can error on some
  rows cannot be planned soundly — which is what `validateOnLoad` and the errored-policy gate exist to
  prevent.
- **Single process, single WASM instance.** Cedar's preparse registry is process-global with no
  unregister API, and WASM linear memory never returns pages to the OS — peak RSS is sticky even
  after eviction. Two physical copies of this package in one process means two registries and
  sporadic "policy set not found"; the loader logs an error when it detects that, and `check()`
  recovers by re-preparsing once, but the fix is deduplicating your lockfile.
- **Sizing `maxScopes`.** Budget roughly **3 KB per policy** of resident WASM memory (measured: 2000
  ids × 20 policies = +126 MB). The default `maxScopes: 256` is therefore about 16 MB for tenants
  averaging 20 policies. Raise it when your tenant count is small and policies are few; lower it when
  tenants are numerous or policy sets are large. Eviction is cheap to undo — refilling 1500 evicted
  ids cost +3 MB against +101 MB for a cold fill — so a too-small `maxScopes` costs latency, not
  memory.
- **Reverse planning** ("who can act on this row") is verified to work in Cedar and is deferred to a
  later release.
- **Entity tags** are accepted by `entity()` but the vocabulary builder does not model them yet, so
  Cedar rejects them whenever `validateRequests` is on.

## Entry points

| Entry                                | Contents                                                                                                                                                                                         |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `@nestm/permissions-core`            | engine, vocabulary, stores, entity model, query-plan compiler, error taxonomy                                                                                                                    |
| `@nestm/permissions-core/vocabulary` | `defineVocabulary`, `t`, the vocabulary types, `entity`/`entityGraph`/`toCedarValue`, the UID helpers and the pure Cedar-schema-JSON builders. **No WASM, no engine, no store.**                 |
| `@nestm/permissions-core/plan`       | query-plan AST types + pure utilities (`walkPlanNode`, `likeTokensToPattern`, `planValueKindOf`, `assertOrderable`, `simplifyPlanNode`). **No WASM, no engine** — this is what a driver imports. |
| `@nestm/permissions-core/testing`    | `evaluatePlanNode` + `filterRowsByPlan` + `matchLikeTokens`, `runPolicyStoreConformanceSuite`, and the `testVocabulary` / policy-record fixtures. **No WASM at import time.**                    |

## Errors

Everything this package throws is a `PermissionsError` carrying a machine-readable `code` and, when
the failure came from Cedar, its `DetailedError[]` with source offsets — which is what lets an admin
policy editor draw squiggles in the right place. Branch on `code`, never on `instanceof` across a
package boundary. `isPermissionsError(value)` performs that structural check (known `code` plus a
string `message`), so it also recognizes an error created by a separately bundled package copy.

`ENGINE_INIT` · `CEDAR_VERSION` · `SCHEMA_INVALID` · `POLICY_PARSE` · `POLICY_INVALID` ·
`POLICY_SET_NOT_PREPARED` · `POLICY_STORE` · `ENTITY_RESOLUTION` · `EVALUATION_FAILED` ·
`UNSUPPORTED_RESIDUAL` · `ERRORED_POLICY` · `POST_FILTER_OVERFLOW` · `PLAN_EVALUATION`

Design: [`docs/design/core.md`](../../docs/design/core.md), with live-verified corrections in
[`docs/design/errata.md`](../../docs/design/errata.md).
