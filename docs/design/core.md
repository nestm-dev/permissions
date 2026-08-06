> Every Cedar behaviour asserted below was executed against `@cedar-policy/cedar-wasm@4.12.0` (nodejs build) on Node 24.18 in the scratchpad on 2026-07-30. Nothing is from memory or docs.

# `@nestm/permissions-core` — design

## 0. Live findings that shape the whole design

| Finding | Evidence | Consequence |
|---|---|---|
| `nodejs/package.json` contains `"type": "commonjs"` (nested override of the root `"type":"module"`); the file uses `exports.name = name` | extracted tarball | **Named ESM imports work natively.** `import { isAuthorizedPartial } from '@cedar-policy/cedar-wasm/nodejs'` runs unmodified on Node 22/24 and typechecks under `moduleResolution: nodenext` with tsc 6.0.2 (verified with both `verbatimModuleSyntax` values); the repository also typechecks with tsc 7.0.2. **No community fork needed.** |
| `nodejs/cedar_wasm.js` ends with `require('fs').readFileSync(`${__dirname}/cedar_wasm_bg.wasm`)` + `new WebAssembly.Module` | source | Load is **synchronous**, no `await init()`. But it uses `__dirname`/`require` ⇒ **must be marked external in tsdown**, never bundled. |
| `statefulIsAuthorized` = **0.136 ms/op** vs `isAuthorized` = **1.98 ms/op** (40 policies) | benchmark | Preparse is a **14.6× win**. Mandatory. |
| `isAuthorizedPartial` = **2.28 ms/op**, and `PartialAuthorizationCall` has **no `preparsedPolicySetId` field** | `.d.ts` + benchmark | Query plans **cannot** use the preparse cache. A JS-side plan cache is not an optimisation, it is a requirement (~17× a stateful check). |
| 500 extra irrelevant entities: 0.136 → **2.79 ms/op** | benchmark | Never pass a whole entity graph. Pass principal + ancestors + resource only. |
| 2000 distinct preparsed set ids (20 policies each) = **+126 MB RSS**; re-preparsing the *same* id 2000× = **+6 MB** | benchmark | There is **no unregister API**. Ids must be **stable per tenant**, never versioned. |
| `preparsePolicySet(id, { staticPolicies: {} })` frees the slot: refilling 1500 ids after eviction cost **+3 MB** vs +101 MB cold | benchmark | **Eviction = overwrite with an empty policy set.** This is the LRU primitive. WASM linear memory never returns pages to the OS, so peak is sticky, but the working set is bounded. |
| `statefulIsAuthorized` with an unregistered id → `{type:"failure", errors:[{message:"preparsed policy set 'nope' not found"}]}` | run | Detectable, fail-closed. |
| Partial residuals encode unknowns as the extension call `{"unknown":[{"Value":"resource"}]}`; the residual's `principal`/`action`/`resource` constraints are always flattened to `{op:"All"}` and folded into `conditions` | run | The plan compiler reads **only `conditions`**, and must recognise `unknown` as an `ExtFuncCall`. |
| `decision` is `"allow"` / `"deny"` / `null` and `nontrivialResiduals` is empty in the determined cases | run | Cedar hands us the **three-state plan directly** — we do not infer it. |
| `>` is normalised to `!(x <= k)`, `>=` to `!(x < k)` | run | Negation pushdown is required, not optional. |
| `like "a\*b*_%c"` → `pattern:[{Literal:"a"},{Literal:"*"},{Literal:"b"},"Wildcard",{Literal:"_"},{Literal:"%"},{Literal:"c"}]` | run | Patterns arrive **tokenised**. Never re-serialise to a string — carry tokens into the AST so drivers do their own `%`/`_` escaping. |
| A policy that errors (missing attribute on the *known* side) lands in `errored[]` **and gets a `{"Value":false}` residual** | run | An **errored `forbid` silently disappears**. This is the sharpest security edge in the whole feature. |
| `templateLinks` are honoured by `isAuthorizedPartial` (link `L1` produced a residual) | run | Templates are usable as the role-grant primitive in both `check` and `plan`. |
| `isAuthorizedPartial` accepts `schema` + `validateRequest:true`; `principal:null` also works | run | Validated planning is available; reverse ("who can act on this row") is a real future feature. |

---

## 1. Public API — class-based

**Recommendation: class.** The engine owns three caches, a WASM handle, a policy-store subscription and a `dispose()` contract. A functional API would force that state into module globals — fatal for tests and for the NestJS module which must support multiple registrations. Ship one functional convenience (`createEngine`) as the constructor.

`packages/permissions-core/src/engine.ts`:

```ts
export class PermissionsEngine<V extends AnyVocabulary> {
  static create<V extends AnyVocabulary>(o: EngineOptions<V>): Promise<PermissionsEngine<V>>;

  check<A extends ActionOf<V>>(req: CheckRequest<V, A>): Promise<CheckResult>;
  checkMany(reqs: readonly CheckRequest<V, ActionOf<V>>[]): Promise<CheckResult[]>;

  plan<A extends ActionOf<V>, R extends ResourceTypeFor<V, A>>(
    req: PlanRequest<V, A, R>,
  ): Promise<QueryPlan<R>>;

  warm(scope: PolicyScopeId): Promise<void>;
  invalidate(scope: PolicyScopeId | '*'): Promise<void>;
  validatePolicies(scope: PolicyScopeId): Promise<PolicyValidationReport>;
  stats(): EngineStats;
  dispose(): Promise<void>;          // evicts every owned preparsed id
}

export interface EngineOptions<V extends AnyVocabulary> {
  readonly vocabulary: V;
  readonly policyStore: PolicyStore;
  readonly entityProvider?: EntityProvider<V>;
  readonly namespace?: string;                       // defaults to vocabulary.namespace
  readonly instanceId?: string;                      // prefix for WASM pset ids; default random
  readonly policySetCache?: { maxScopes?: number };  // default 256
  readonly planCache?: { max?: number; ttlMs?: number }; // default 2000 / 30_000
  readonly validateOnLoad?: boolean;                 // default true — cedar `validate()` at preparse
  readonly validateRequests?: boolean;               // default true — pass schema per call
  readonly unsupportedResidual?: UnsupportedResidualPolicy; // default 'error'
  readonly onDecision?: (e: DecisionEvent) => void;
  readonly clock?: () => Date;
  readonly cedar?: CedarBinding;                     // test seam
}

export interface CheckRequest<V, A extends ActionOf<V>> {
  readonly scope: PolicyScopeId;
  readonly principal: EntityRef<PrincipalTypeFor<V, A>>;
  readonly action: A;
  readonly resource: EntityRef<ResourceTypeFor<V, A>>;
  readonly context?: ContextFor<V, A>;
  readonly entities?: EntityGraph;   // pre-resolved; skips EntityProvider
}

export interface CheckResult {
  readonly allowed: boolean;
  readonly decision: 'allow' | 'deny';
  readonly determiningPolicyIds: readonly string[];   // Cedar diagnostics.reason
  readonly policyErrors: readonly PolicyEvaluationError[];
  readonly scope: PolicyScopeId;
  readonly policySetVersion: string;
  readonly durationMs: number;
  readonly cache: 'hit' | 'miss';
}
```

`EntityRef<T> = { readonly type: T; readonly id: string }`. Everything is `readonly`; no class instances cross the boundary, so results are structurally cloneable and safe to log.

**Generics.** `V` is the phantom-carrying output of `defineVocabulary`. `ActionOf<V>` is a string-literal union; `ResourceTypeFor<V, A>` narrows the resource union to what the action's `appliesTo` declares, so `engine.check({ action: 'run:dispatch', resource: { type: 'Project', ... } })` is a **compile error**. This union is what downstream `@RequirePermission('run:dispatch')` type-checks against.

---

## 2. Vocabulary authoring — typed builder (recommended)

Raw Cedar schema strings lose all type information and force downstream decorators back to `string`. Codegen from `.cedarschema` files adds a build step to every consumer. The builder wins: **one source, two outputs** (Cedar `SchemaJson`, TS unions), zero build step.

`src/vocabulary/define-vocabulary.ts`:

```ts
export function defineVocabulary<const D extends VocabularyDef>(def: D): Vocabulary<D>;

export interface Vocabulary<D extends VocabularyDef> {
  readonly namespace: string;
  readonly def: D;
  readonly cedarSchemaJson: SchemaJson<string>;   // fed to preparseSchema
  toCedarSchemaText(): string;                    // via schemaToText — docs/debug only
  actionUid(action: ActionOf<this>): EntityUid;   // 'run:dispatch' -> Station::Action::"run:dispatch"
  entityUid(ref: EntityRef<string>): EntityUid;
}

// attribute combinators
export const t: {
  string(): AttrSpec<'String'>;  long(): AttrSpec<'Long'>;  bool(): AttrSpec<'Boolean'>;
  set<A extends AttrSpec>(el: A): AttrSpec<'Set'>;
  record<R extends Record<string, AttrSpec>>(r: R): AttrSpec<'Record'>;
  ref<N extends string>(entity: N): AttrSpec<'Entity'>;
  ext(name: 'datetime' | 'duration' | 'ipaddr' | 'decimal'): AttrSpec<'Extension'>;
  optional<A extends AttrSpec>(a: A): A & { required: false };
};
```

Usage (station's real vocabulary):

```ts
export const stationVocabulary = defineVocabulary({
  namespace: 'Station',
  entities: {
    Organization: {},
    Role: {},
    Project: { memberOf: ['Organization'], attrs: { organization: t.ref('Organization'), archived: t.bool() } },
    Member:  { memberOf: ['Role', 'Organization'],
               attrs: { organization: t.ref('Organization'), identitySubject: t.string() } },
    Run:     { memberOf: ['Project'],
               attrs: { project: t.ref('Project'), status: t.string(), createdBy: t.ref('Member') } },
  },
  actions: {
    'run:dispatch': { principal: ['Member'], resource: ['Run'], context: { mfa: t.optional(t.bool()) } },
    'run:read':     { principal: ['Member'], resource: ['Run'] },
    'project:manage': { principal: ['Member'], resource: ['Project'] },
  },
} as const);

export type StationAction = ActionOf<typeof stationVocabulary>;      // 'run:dispatch' | 'run:read' | ...
export type StationResource = ResourceOf<typeof stationVocabulary>;  // 'Run' | 'Project' | ...
```

Action ids keep station's existing `noun:verb` strings verbatim — Cedar action ids are arbitrary `SmolStr`, verified. That makes the station migration a rename-free mapping of `permissionKeys` → vocabulary actions.

`defineVocabulary` runs `checkParseSchema` eagerly and throws `SchemaValidationError` with Cedar's `DetailedError[]` attached.

Files: `vocabulary/{define-vocabulary,types,to-cedar-schema,validate-vocabulary}.ts`.

---

## 3. Policy store SPI

`src/policy/policy-store.ts`:

```ts
export type PolicyScopeId = string;   // '' = global; otherwise tenant key, e.g. 'org:8f3e…'

export interface PolicyRecord {
  readonly id: string;
  readonly scope: PolicyScopeId;
  readonly kind: 'static' | 'template';
  readonly cedarJson: PolicyJson;      // canonical persisted form
  readonly description?: string;
  readonly annotations?: Record<string, string>;
  readonly enabled: boolean;
  readonly updatedAt: Date;
}

export interface TemplateLinkRecord {
  readonly id: string;                 // becomes Cedar `newId`
  readonly scope: PolicyScopeId;
  readonly templateId: string;
  readonly values: Readonly<Record<'?principal' | '?resource', EntityRef<string>>>;
  readonly updatedAt: Date;
}

export interface PolicyBundle {
  readonly scope: PolicyScopeId;
  readonly version: string;            // opaque; monotonic per scope (e.g. max(updatedAt)+count)
  readonly policies: readonly PolicyRecord[];
  readonly links: readonly TemplateLinkRecord[];
}

export interface PolicyStore {
  load(scope: PolicyScopeId): Promise<PolicyBundle>;
  currentVersion(scope: PolicyScopeId): Promise<string>;   // cheap freshness probe
  save(policies: readonly PolicyRecord[]): Promise<void>;
  delete(scope: PolicyScopeId, ids: readonly string[]): Promise<void>;
  linkTemplate(link: TemplateLinkRecord): Promise<void>;
  unlinkTemplate(scope: PolicyScopeId, linkId: string): Promise<void>;
  watch?(listener: (e: PolicyChangeEvent) => void): () => void;  // LISTEN/NOTIFY, poll, …
}
```

Persisted form is **`PolicyJson`, not text** — `policyToJson`/`policyToText` round-trip verified. JSON is `jsonb`-queryable ("which policies reference `Run`?"), and `policy-codec.ts` exposes `parsePolicyText`, `renderPolicyText`, `formatPolicyText` (via `formatPolicies`) for the admin UI.

**Multi-tenant caching** (`runtime/policy-set-cache.ts`):

- WASM id = `` `${instanceId}:${scope}` `` — **stable, never version-suffixed** (measured: versioned ids leak ~3 KB/policy forever).
- JS-side `Map<scope, { version, preparedAt, lastUsedAt }>` + LRU of `maxScopes` (default 256).
- `check()` path: resolve entry → if absent or `version` stale, `load()` + `preparsePolicySet(id, set)` → `statefulIsAuthorized`.
- Write path: `save/delete/link` → `invalidate(scope)` → re-`preparsePolicySet` under the **same id** (verified to free the old).
- LRU eviction: `preparsePolicySet(id, { staticPolicies: {} })` then drop the JS entry (verified to free the slot).
- Single-flight: concurrent misses on one scope share one in-flight promise (`util/single-flight.ts`) so a cold tenant never preparses N times.
- `preparseSchema(vocabHash, schema)` once per engine; `preparsedSchemaName` passed on every stateful call.

`memory-policy-store.ts` is the v1 driver: a `Map` + a synchronous `watch` emitter, used by tests and by the NestJS quick-start.

---

## 4. Principal & entity model

`src/entities/entity-provider.ts`:

```ts
export type EntityGraph = readonly EntityJson[];   // cedar's own shape, re-exported

export interface EntityResolutionRequest<V> {
  readonly scope: PolicyScopeId;
  readonly principal: EntityRef<string>;
  readonly action: ActionOf<V>;
  readonly resource?: EntityRef<string>;
  readonly resourceType?: EntityNameOf<V>; // present when planning without a resource instance
}

export interface EntityProvider<V extends AnyVocabulary> {
  /** principal + its transitive parents (roles, groups, org). */
  resolvePrincipal(req: EntityResolutionRequest<V>): Promise<EntityGraph>;
  /** the single resource + the parents its policies traverse. */
  resolveResource?(req: EntityResolutionRequest<V>): Promise<EntityGraph>;
  /** extra entities some action needs (rare). */
  resolveAdditional?(req: EntityResolutionRequest<V>): Promise<EntityGraph>;
}
```

`entity-builder.ts` gives a typed constructor so apps do not hand-write `CedarValueJson`:

```ts
export function entity<V, N extends EntityNameOf<V>>(
  v: V, type: N, id: string,
  init: { attrs: AttrsFor<V, N>; parents?: readonly EntityRef<string>[]; tags?: Record<string, unknown> },
): EntityJson;
```
It converts `EntityRef` values to `{__entity:{type,id}}`, `Date` to `{__extn:{fn:'datetime',arg:iso}}`, and rejects attributes absent from the vocabulary (catches the `Value:false`-on-error trap at construction time instead of at evaluation time).

**Role grants = template links.** `permit(principal == ?principal, action in [Station::Action::"run:dispatch", …], resource in ?resource);` is stored once as a template; each `(member, role, scope)` row becomes a `TemplateLinkRecord`. This is the direct analogue of station's `role_grants` and keeps grant rows narrow.

**Entity cost.** Measured at 500 irrelevant entities → 20× slowdown, so `entity-cache.ts` is a two-tier memo: (1) a per-request `Map` (the guard resolves the principal graph once and reuses it for check + plan), (2) an optional process LRU keyed `` `${scope}:${type}:${id}:${version}` `` with TTL, invalidated by `PolicyChangeEvent` and by an app-callable `engine.invalidateEntity(ref)`.

---

## 5. Query-plan API — the security-critical part

### 5.1 Three-state plan

```ts
export type QueryPlan<R extends string> =
  | { readonly kind: 'ALWAYS_ALLOW';  readonly diagnostics: PlanDiagnostics }
  | { readonly kind: 'ALWAYS_DENY';   readonly diagnostics: PlanDiagnostics }
  | { readonly kind: 'CONDITIONAL';   readonly resourceType: R;
      readonly condition: PlanNode;
      readonly approximations: readonly PlanApproximation[];
      readonly postFilter?: (rows: readonly unknown[]) => Promise<readonly unknown[]>;
      readonly diagnostics: PlanDiagnostics };

export interface PlanDiagnostics {
  readonly residualPolicyIds: readonly string[];
  readonly erroredPolicyIds: readonly string[];
  readonly policySetVersion: string;
  readonly cache: 'hit' | 'miss';
  readonly durationMs: number;
  explain(): string;
}
```

Mapping is direct, no inference: `decision === 'allow'` → `ALWAYS_ALLOW`; `'deny'` → `ALWAYS_DENY`; `null` → compile `nontrivialResiduals`.

### 5.2 The neutral condition AST (`src/plan/plan.ts`)

```ts
export type AttrRoot = 'resource' | 'principal';
export interface AttrPath { readonly root: AttrRoot; readonly path: readonly string[] }  // depth 1 = column

export type PlanValue =
  | { readonly kind: 'string';  readonly value: string }
  | { readonly kind: 'long';    readonly value: bigint }
  | { readonly kind: 'bool';    readonly value: boolean }
  | { readonly kind: 'entity';  readonly value: EntityRef<string> }
  | { readonly kind: 'datetime';readonly value: Date }
  | { readonly kind: 'duration';readonly value: number }   // ms
  | { readonly kind: 'set';     readonly value: readonly PlanValue[] };

export type LikeToken = { readonly literal: string } | { readonly wildcard: true };

export type PlanNode =
  | { readonly op: 'true' }
  | { readonly op: 'false' }
  | { readonly op: 'and'; readonly nodes: readonly PlanNode[] }
  | { readonly op: 'or';  readonly nodes: readonly PlanNode[] }
  | { readonly op: 'not'; readonly node: PlanNode }
  | { readonly op: 'cmp'; readonly cmp: 'eq'|'ne'|'lt'|'lte'|'gt'|'gte';
      readonly attr: AttrPath; readonly value: PlanValue }
  | { readonly op: 'in';        readonly attr: AttrPath; readonly values: readonly PlanValue[] }
  | { readonly op: 'contains';  readonly attr: AttrPath; readonly value: PlanValue }
  | { readonly op: 'like';      readonly attr: AttrPath; readonly pattern: readonly LikeToken[] }
  | { readonly op: 'exists';    readonly attr: AttrPath }
  | { readonly op: 'isEmpty';   readonly attr: AttrPath }
  | { readonly op: 'isType';    readonly entityType: string }
  | { readonly op: 'inHierarchy'; readonly attr: AttrPath | null; readonly parent: EntityRef<string> };
```

Design notes that matter: `like` carries **tokens**, never a string (Cedar hands us tokens; re-serialising is how you get `%`/`_` injection). `cmp.value` is a typed variant, never `unknown` (drivers must bind parameters, never interpolate). `inHierarchy.attr === null` means *the row itself* is in `parent` — the driver must have a declared hierarchy mapping; **absent mapping is a fail-closed error, not a silent `TRUE`**.

### 5.3 Compilation pipeline (`plan/compile-residuals.ts`)

1. **Partition** residuals by `effect`: `permits[]`, `forbids[]`.
2. **Normalise** each `conditions[]` (`expr-normalize.ts`): fold `Value:true/false` through `&&`/`||`/`!` (Cedar emits a lot of these), push `!` inward over `<`/`<=` to recover `>`/`>=`, flatten nested `&&`/`||`, and detect the unknown marker `{"unknown":[{"Value":"<var>"}]}`.
3. **Translate** (`expr-to-plan.ts`) against the pushdown table below.
4. **Assemble**: `condition = or(permits) and not(or(forbids))`. `unless` clauses become `not(body)`. Multiple clauses in one policy are `and`-ed.
5. **Simplify**: absorb `true`/`false`, collapse single-child `and`/`or`.
6. `ALWAYS_ALLOW`/`ALWAYS_DENY` are re-derived if simplification bottoms out at `true`/`false` (belt-and-braces on top of Cedar's own `decision`).

### 5.4 Pushdown table — exactly what is supported

Supported (`resource` root, path length 1, unless noted):

| Cedar residual node | → PlanNode |
|---|---|
| `{"Value": true/false}` | `true` / `false` |
| `{"&&"}`, `{"||"}`, `{"!"}` | `and`, `or`, `not` |
| `{"=="}`, `{"!="}` with one unknown-attr side and one constant side | `cmp eq/ne` |
| `{"<"}`, `{"<="}` (and their `!`-negations) | `cmp lt/lte/gt/gte` |
| `{"is": {left: unknown(resource), entity_type}}` | `isType` → folded to `true` when it equals the planned resource type, `false` otherwise |
| `{"in": {left: unknown(resource), right: entity literal}}` | `inHierarchy{attr:null}` |
| `{"in": {left: <attr>, right: entity literal}}` | `inHierarchy{attr}` |
| `{"contains": {left: Set literal, right: <attr>}}` | `in` |
| `{"contains": {left: <attr>, right: constant}}` | `contains` |
| `{"like": {left: <attr>, pattern}}` | `like` |
| `{"has": {left: unknown(resource), attr}}` | `exists` |
| `{"isEmpty": {arg: <attr>}}` | `isEmpty` |
| `{"if-then-else"}` | `or(and(if,then), and(not(if),else))` — only when all three branches translate |
| `{"Set":[…]}`, `{"Value": …}`, `{"<ext>":[{"Value":…}]}` on the **constant** side | `PlanValue` (incl. `datetime`, `duration`, `decimal`, `ipaddr`) |

**Not pushdown-able — every one of these triggers the fail-closed path:**

- nested attribute access on an unknown (`resource.owner.dept` — verified to appear as `.` over `.`): needs a join the core cannot know about.
- `unknown` on **both** sides of a binary op.
- arithmetic (`+ - *`), `getTag`/`hasTag`, `containsAll`/`containsAny` over an unknown attr.
- extension **calls applied to an unknown** (e.g. `ip(resource.addr).isInRange(…)`).
- `unknown("principal")` appearing while planning over resources (or vice versa).
- `Record` literals, set-valued unknown compared to set-valued unknown.
- any `in` whose right side is not a concrete entity literal.

### 5.5 The fail-closed contract (state this verbatim in the README)

> A query plan is **sound** iff the row set selected by `condition` equals the set of rows for which `check()` would return `allow`. `@nestm/permissions-core` never returns an unsound plan silently.

Direction analysis, which is the whole trick — the assembled condition is `OR(permits) AND NOT(OR(forbids))`:

- An untranslatable subterm inside a **permit** must be replaced by `true`, which **widens** `OR(permits)` ⇒ the result is a **superset** of the authorized rows ⇒ **unsafe**. Requires a post-filter or an error.
- An untranslatable subterm inside a **forbid** must be replaced by `true`, which widens `OR(forbids)` ⇒ `NOT(...)` **narrows** ⇒ the result is a **subset** ⇒ **safe** (over-blocks, never over-shares). Recorded as a `PlanApproximation` with `direction: 'restrictive'` and a warning; never silently discarded.
- Replacing an untranslatable forbid subterm by `false` would be the classic vulnerability. `approximation.ts` makes the direction a typed, tested function of `(effect, polarity)` where polarity flips under each enclosing `not`/`unless`, so this cannot be got wrong by accident.

```ts
export type UnsupportedResidualPolicy =
  | 'error'         // DEFAULT — throw UnsupportedResidualError
  | 'post-filter'   // widen permits to true, attach plan.postFilter
  | ((ctx: UnsupportedResidualContext) => PlanNode | 'error' | 'post-filter');

export interface PlanApproximation {
  readonly policyId: string;
  readonly effect: 'permit' | 'forbid';
  readonly direction: 'permissive' | 'restrictive';
  readonly reason: 'nested-attribute' | 'arithmetic' | 'unknown-both-sides'
                 | 'extension-on-unknown' | 'unmapped-hierarchy' | 'errored-policy' | 'other';
  readonly expr: Expr;      // the offending Cedar sub-expression, for the audit log
}
```

**Errored policies.** Verified: a policy that errors gets a `{"Value":false}` residual and an entry in `errored[]`. An errored *forbid* therefore vanishes. Default behaviour: if `errored[]` is non-empty, `plan()` **throws** `ErroredPolicyError`. Opt-out is `onErroredPolicy: 'error' | 'deny-all' | 'ignore'` (`'ignore'` documented as unsafe).

**Post-filter escape hatch.** `plan.postFilter(rows)` maps each row to an `EntityRef` via a caller-supplied `rowToResource`, batches through `checkMany` (0.136 ms/check), and drops non-allowed rows. It is correct but O(n) and breaks DB-side pagination — so it throws `PostFilterOverflowError` past `maxPostFilterRows` (default 500) rather than melting the DB. The README says plainly: post-filter is a migration aid, not a steady state.

### 5.6 Plan caching

`plan()` is ~2.28 ms and cannot use the preparse cache. Cache key: `sha256(instanceId, scope, policySetVersion, principalUid, hash(principalAncestorUids), action, resourceType, canonicalJson(context), vocabHash)`. LRU + TTL. `invalidate(scope)` clears both caches for that scope. `stats()` reports hit rates so the NestJS layer can expose them as metrics.

### 5.7 Reference interpreter (`plan/evaluate-plan.ts`)

```ts
export function evaluatePlanNode(node: PlanNode, row: Readonly<Record<string, unknown>>,
                                 opts: { hierarchy?: HierarchyResolver }): boolean;
```
Exported from `@nestm/permissions-core/testing`. This is how the TypeORM and Drizzle drivers get their own differential test: run the SQL, run the interpreter over the same fixture rows, assert set equality. Shipping it is what makes driver correctness testable at all.

---

## 6. WASM/ESM loading

Verified: **no shim is needed for correctness.** `src/cedar/loader.ts` exists for control, not compatibility:

```ts
export interface CedarBinding {
  isAuthorized(c: AuthorizationCall): AuthorizationAnswer;
  statefulIsAuthorized(c: StatefulAuthorizationCall): AuthorizationAnswer;
  isAuthorizedPartial(c: PartialAuthorizationCall): PartialAuthorizationAnswer;
  preparsePolicySet(id: string, p: PolicySet): CheckParseAnswer;
  preparseSchema(name: string, s: Schema): CheckParseAnswer;
  validate(c: ValidationCall): ValidationAnswer;
  policyToJson(p: Policy): PolicyToJsonAnswer;
  policyToText(p: Policy): PolicyToTextAnswer;
  templateToJson(t: Template): PolicyToJsonAnswer;
  schemaToText(s: Schema): SchemaToTextAnswer;
  checkParseSchema(s: Schema): CheckParseAnswer;
  formatPolicies(c: FormattingCall): FormattingAnswer;
  getCedarLangVersion(): string;
}

export async function loadCedar(): Promise<CedarBinding>;  // memoised dynamic import
```

- `await import('@cedar-policy/cedar-wasm/nodejs')` inside `loadCedar()`. Dynamic keeps ~4.11 MiB out of the module graph until `PermissionsEngine.create()` runs and gives the NestJS module a clean async `useFactory`.
- `tsdown.config.ts` must set `deps: { neverBundle: [/^@cedar-policy\//] }` — non-negotiable, the file relies on `__dirname` and `require('fs')`.
- `@cedar-policy/cedar-wasm` is a **`dependency`**, not a peer: zero transitive deps, Apache-2.0, and consumers must not be able to drift onto an untested minor.
- `loadCedar()` asserts `getCedarLangVersion()` starts with `4.` and throws `CedarVersionError` otherwise.
- The `CedarBinding` seam lets unit tests stub the engine and leaves room for a future worker-thread or `/web` binding without touching call sites.
- `package.json` pins `"@cedar-policy/cedar-wasm": "4.12.0"` exactly during alpha (partial eval is experimental; a patch bump could change residual shapes — the corpus tests are the tripwire).

---

## 7. Errors, diagnostics, audit

`src/diagnostics/errors.ts` — one base, discriminated by `code`:

```ts
export class PermissionsError extends Error {
  readonly code: PermissionsErrorCode;
  readonly details?: readonly DetailedError[];   // raw Cedar diagnostics
  readonly scope?: PolicyScopeId;
}
export type PermissionsErrorCode =
  | 'ENGINE_INIT' | 'CEDAR_VERSION' | 'SCHEMA_INVALID' | 'POLICY_PARSE' | 'POLICY_INVALID'
  | 'POLICY_SET_NOT_PREPARED' | 'POLICY_STORE' | 'ENTITY_RESOLUTION'
  | 'EVALUATION_FAILED' | 'UNSUPPORTED_RESIDUAL' | 'ERRORED_POLICY' | 'POST_FILTER_OVERFLOW';
```

Every error carries Cedar's `DetailedError[]` (message + help + `sourceLocations`), which is what makes an admin policy editor able to draw squiggles.

`diagnostics/decision-event.ts`:

```ts
export type DecisionEvent =
  | ({ readonly type: 'check' } & CheckResult & { readonly principal: EntityRef<string>;
        readonly action: string; readonly resource: EntityRef<string>; readonly context?: unknown })
  | { readonly type: 'plan'; readonly scope: PolicyScopeId; readonly action: string;
      readonly resourceType: string; readonly kind: QueryPlan<string>['kind'];
      readonly approximations: readonly PlanApproximation[]; readonly diagnostics: PlanDiagnostics };
```

`onDecision` is **synchronous, never awaited, and wrapped in try/catch** — an audit sink must never be able to fail or slow an authorization decision. Context is passed through `redactContext?: (ctx) => unknown` (default: keys only, values elided) so PII does not land in logs by default. The NestJS package will bridge this onto station's `audit_entries`.

---

## 8. Testing strategy

1. **Cedar conformance corpus.** Vendor `cedar-policy/cedar-integration-tests` under `references/cedar-corpus/` (Apache-2.0, matches the family's existing `references/` convention). A generated suite drives every corpus case through `engine.check()` and asserts the decision **and** the determining-policy set match the corpus expectation. This is what proves the wrapper does not change semantics.
2. **Plan soundness — property-based, the flagship test.** With `fast-check`: generate a random vocabulary, a random population of 50–200 resource entities, and a random policy set drawn from the pushdown-able grammar. Compute `authorized = entities.filter(e => check(e).allowed)` by brute force; compute `plan()`; evaluate `condition` with `evaluatePlanNode` over the same entities. **Assert set equality.** Then mutate one policy into a non-pushdown-able form and assert `plan()` **throws** rather than returning a plan. Both directions are needed: soundness and fail-closed-ness.
3. **Direction-analysis unit table.** Exhaustive matrix over `(effect ∈ {permit,forbid}) × (polarity ∈ {+,−}) × reason` asserting the chosen approximation, since this is the one function where a sign error is a CVE.
4. **LIKE fuzz.** Random strings through Cedar `like` → tokens → `evaluatePlanNode`, asserting agreement with Cedar's own decision. Guards the `%`/`_`/`*` escaping trap.
5. **Cache/lifecycle tests.** Version-stale invalidation re-preparses under the same id; LRU eviction issues the empty-set overwrite; a `statefulIsAuthorized` "policy set not found" is retried once then surfaces as `POLICY_SET_NOT_PREPARED`; `dispose()` empties every owned id.
6. **Type-level tests.** `expectTypeOf` asserting `ActionOf`/`ResourceTypeFor` narrow correctly and that a mismatched action/resource pair is a compile error (`@ts-expect-error`).
7. **Barrel-export test** (`tests/unit/exports.test.ts`) — better-auth convention.
8. **Benchmarks** under `tests/bench/` (vitest bench), tracking the four numbers measured above so a Cedar upgrade that regresses them is visible.

Layout: better-auth style — `tests/{unit,conformance,property,bench}/**/*.test.ts`, vitest 4 with `globals: true`. No `reflect-metadata` setup file (no decorators in core).

---

## 9. File-by-file package layout

```
packages/permissions-core/
├── package.json          @nestm/permissions-core, type:module, sideEffects:false,
│                         engines.node>=22.12, exports { ".", "./testing", "./package.json" },
│                         dependencies: { "@cedar-policy/cedar-wasm": "4.12.0" }, ZERO peers
├── tsconfig.json / tsconfig.build.json     extends root; verbatimModuleSyntax:false (family rule)
├── tsdown.config.ts      entry [src/index.ts, src/testing.ts], esm, dts, fixedExtension,
│                         deps.neverBundle:[/^@cedar-policy\//]
├── vitest.config.ts
├── README.md / CHANGELOG.md
├── references/cedar-corpus/            vendored, git-ignored from lint/format
└── src/
    ├── index.ts                         barrel (grouped, `type`-prefixed exports)
    ├── testing.ts                       secondary entry: evaluatePlanNode, corpus helpers, fixtures
    ├── engine.ts                        PermissionsEngine
    ├── engine.options.ts                EngineOptions + resolveOptions defaults
    ├── cedar/
    │   ├── binding.ts                   CedarBinding interface
    │   ├── loader.ts                    memoised dynamic import + lang-version assert
    │   ├── answers.ts                   Answer union → CheckResult / throw
    │   └── uid.ts                       EntityRef ⇄ EntityUid ⇄ 'Ns::Type::"id"'
    ├── vocabulary/
    │   ├── define-vocabulary.ts  types.ts  to-cedar-schema.ts  validate-vocabulary.ts
    ├── policy/
    │   ├── policy-store.ts  memory-policy-store.ts  policy-codec.ts  policy-set-builder.ts
    ├── runtime/
    │   ├── policy-set-cache.ts          stable ids, LRU, evict-by-empty, single-flight
    │   ├── schema-cache.ts              preparseSchema registry
    │   └── plan-cache.ts
    ├── entities/
    │   ├── entity-provider.ts  entity-builder.ts  entity-cache.ts
    ├── plan/
    │   ├── plan.ts                      QueryPlan + PlanNode AST + PlanValue
    │   ├── compile-residuals.ts         ResidualResponse → QueryPlan
    │   ├── expr-normalize.ts            constant folding, negation pushdown, unknown detection
    │   ├── expr-to-plan.ts              the pushdown table
    │   ├── approximation.ts             polarity/direction analysis + fail-closed policy
    │   └── evaluate-plan.ts             reference interpreter
    ├── diagnostics/
    │   ├── errors.ts  decision-event.ts  explain.ts
    └── util/
        ├── lru.ts  hash.ts  single-flight.ts  assert.ts
```

## 10. Ordered implementation task list

| # | Task | Files | Days |
|---|---|---|---|
| 1 | Package skeleton, tsdown/vitest/tsconfig, barrel + export test | root configs, `index.ts` | 0.5 |
| 2 | `CedarBinding` + `loadCedar` + `uid.ts` + `answers.ts`; assert named-import works in the built `dist/index.mjs` under Node 22 **and** 24 | `cedar/*` | 0.5 |
| 3 | Vocabulary builder + `to-cedar-schema` + `checkParseSchema` validation + type-level tests | `vocabulary/*` | 2.0 |
| 4 | `PolicyStore` SPI, `policy-codec`, `policy-set-builder`, `MemoryPolicyStore` | `policy/*` | 1.0 |
| 5 | `policy-set-cache` (stable ids, LRU, evict-by-empty, single-flight) + `schema-cache` | `runtime/*` | 1.0 |
| 6 | `EntityProvider` SPI, typed `entity()` builder, entity cache | `entities/*` | 1.0 |
| 7 | `check()` / `checkMany()`, error taxonomy, `onDecision`, `stats()` | `engine.ts`, `diagnostics/*` | 1.0 |
| 8 | **PlanNode AST + normalizer + `expr-to-plan` + `approximation` + `compile-residuals`** | `plan/*` | 3.0 |
| 9 | `evaluate-plan` reference interpreter + `./testing` entry | `plan/evaluate-plan.ts`, `testing.ts` | 1.0 |
| 10 | Property-based soundness + fail-closed harness; LIKE fuzz; direction matrix | `tests/property/*` | 2.0 |
| 11 | Cedar corpus vendoring + conformance runner | `references/`, `tests/conformance/*` | 1.0 |
| 12 | Benchmarks + README (incl. the verbatim fail-closed contract and a Limitations section) | `tests/bench/*`, `README.md` | 1.0 |
| | **Total** | | **≈ 15 engineer-days** |

Steps 1–7 are the shippable "check-only" milestone (~7 days) and unblock `@nestm/permissions` immediately. Steps 8–11 are the query-plan milestone and unblock both ORM drivers; step 9's interpreter is a hard prerequisite for the driver packages' own tests, so land it before either driver starts.

## 11. Station migration hooks (for the integration plan owner)

- `stationVocabulary` maps `permissionKeys` 1:1 onto action ids — **no rename**, so `@RequirePermission('run:dispatch')` keeps its string.
- `packages/platform/src/authorization.ts` is dependency-free by policy; `@nestm/permissions-core` has **zero NestJS deps and one Apache-2.0 dependency**, so it can land there without breaking `dependency-cruiser`.
- `role_grants` rows → `TemplateLinkRecord`s; `roles` + `role_permissions` → one Cedar template per role.
- `PermissionReach` (`{organization} | {projects} | {none}`) is precisely the three-state plan — `ALWAYS_ALLOW` / `CONDITIONAL(project_id IN …)` / `ALWAYS_DENY`. The migration is a shape-preserving swap.
- Postgres FORCE-RLS remains the second wall; the plan's `condition` is additive to `withOrganizationContext`, never a replacement.

## Out of scope for this slice

NestJS module/guards/decorators (`@nestm/permissions`), the TypeORM/Drizzle `PlanNode → WHERE` compilers and their column/hierarchy mapping DSL, the policy-admin HTTP API, monorepo/changesets/CI scaffolding, and the station cutover sequencing.
