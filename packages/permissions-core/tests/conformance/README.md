# Cedar corpus conformance

`cedar-corpus.test.ts` runs the Cedar project's own integration-test corpus against this package.

Every other suite in `tests/` asserts what _we_ believe Cedar does. This one asserts it against
the reference implementation's own expectations, so a `@cedar-policy/cedar-wasm` bump that changes
an answer fails here — with the offending case file, request description and got-vs-want printed —
rather than shipping.

## What the corpus is

[`cedar-policy/cedar-integration-tests`](https://github.com/cedar-policy/cedar-integration-tests) is
the test data the Cedar language team runs its own implementations against. Each **case** is a JSON
file naming a policy set, a schema and an entity store (paths relative to the corpus root), plus a
list of requests carrying the `decision`, the determining policies (`reason`) and the errored
policies (`errors`) Cedar produces for them.

| Location                                            | Contents                                                                                                                                       |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/{decimal,example_use_cases,ip,multi}/*.json` | 24 handwritten cases (78 requests), plus the `policies_*.cedar` / `*.cedarschema` side files they reference                                    |
| `sample-data/{sandbox_a,sandbox_b}/`                | the entity stores and schemas the handwritten cases share                                                                                      |
| `corpus-tests/` (from `corpus-tests.tar.gz`)        | 7 600 machine-generated cases (60 800 requests), `<sha>.json` + `<sha>.cedar` + `<sha>.cedarschema` + `<sha>.entities.json`; ~133 MB extracted |

A `.json` file is a case iff it does **not** end in `.entities.json` and parses to an object with a
`requests` array — `tests/example_use_cases/` also holds `policies_2a.cedar.json` and
`schema_2a.json`, which are side files the cases point at, not cases.

## Fetching and refreshing it

`references/` is gitignored (root `.gitignore`), so the corpus is a **build-time fetch**, not vendored
source. A checkout without it makes the suite fail loudly with these commands in the message — it
never skips, because a green run that checked nothing is the exact failure mode a conformance suite
exists to prevent.

```
cd packages/permissions-core/references
rm -rf cedar-corpus
git clone --depth 1 https://github.com/cedar-policy/cedar-integration-tests cedar-corpus
cd cedar-corpus && tar xzf corpus-tests.tar.gz
```

The numbers quoted in this file and asserted in the suite were measured at:

```
75989795c75d861270ce6cac38ef9d9e5b220a0c  2026-07-24 14:36:06 -0400
```

Re-print it after a refresh with `git -C references/cedar-corpus log -1 --format='%H %ci'`, and expect
the totals block to move. The suite asserts _proportions_, not exact counts, so a refresh that adds
cases stays green while a refresh that starts skipping everything fails.

The corpus is Apache-2.0 (see `references/cedar-corpus/LICENSE`). It is fetched, never redistributed:
nothing under `references/` is committed here or included in the published package (`files` in
`package.json` is `dist`, `README.md`, `CHANGELOG.md`, `LICENSE`).

## The two levels

### Binding level — the conformance claim

Drives every discovered case through `CedarBinding.isAuthorized` and asserts, per request:

- `decision` matches,
- `diagnostics.reason` matches `reason` **as a set**,
- `diagnostics.errors[].policyId` matches `errors` **as a set**.

Cedar text goes in unmodified: `StaticPolicySet` accepts a policy-set string and then names the
policies `policy0`, `policy1`, … in source order, which is exactly what the corpus `reason` lists,
and `Schema` accepts `.cedarschema` text directly. Nothing in this package touches the values on the
way through — that is the point.

Every discovered case is attempted — all 24 handwritten and all 7 600 generated. At the pinned commit:
**7 540 of 7 624 cases and 60 206 of 60 878 requests ran, 0 mismatched**, the shortfall being the
`i64-precision` skips described below.

### Engine level — the transparency claim

Drives the mappable subset through `PermissionsEngine.checkUnsafe` and asserts that the decision and
the determining-policy set are unchanged. This is what catches a wrapper bug — namespace
qualification, policy-id naming, context coercion, entity passthrough — as opposed to a Cedar bug.

**The mapped subset is small, and that is expected.** `resolveEngineOptions` requires a non-empty
namespace, and only ~15% of generated corpus cases declare one; the other ~85% live in Cedar's empty
namespace and cannot be expressed as an engine at all. That shortfall is _reported_ in the totals
block (`no-namespace: 6502`), never hidden. A case is mappable iff:

- its `.cedarschema` declares exactly one top-level `namespace <Name> { … }` block, and
- every request's `principal.type` and `resource.type` start with `<Name>::`, and
- `action.type === "<Name>::Action"`, and
- the policy text contains no template slots (`?principal` / `?resource`), and
- the schema and policies survive conversion (`schemaToJson`, `policySetTextToParts`).

At the pinned commit 1 096 cases (8 768 requests) are mappable and **0 mismatch**. No handwritten case
is mappable — the `sample-data` schemas declare no namespace.

## Environment variables

| Variable                    | Default           | Effect                                                                                       |
| --------------------------- | ----------------- | -------------------------------------------------------------------------------------------- |
| `CEDAR_CORPUS_LIMIT`        | unset — all 7 600 | Caps the **generated** cases the _binding_ sweep runs. Handwritten cases always run in full. |
| `CEDAR_CORPUS_ENGINE_LIMIT` | `500`             | Caps the **mapped** cases the _engine_ sweep instantiates an engine for.                     |

Both are reported caps: when either holds cases back, the totals block says so
(`LIMITED by CEDAR_CORPUS_ENGINE_LIMIT=500 — 596 eligible cases (4 768 requests) were not run`), so a
shortened run can never be mistaken for a full one. A non-integer or non-positive value throws.

`CEDAR_CORPUS_LIMIT` does not shrink the engine sweep's _scan_ — it still classifies all 7 624 cases,
which costs ~2 s and is what keeps the "mapping still matches something" guard meaningful. And the
two statistical guards below (`ran / (ran + skipped) > 0.95`, skips `< 2%`) are asserted only on an
unlimited binding run: `CEDAR_CORPUS_LIMIT` takes a prefix of a sha-ordered list, the i64 cases are
not spread evenly through it, and asserting a proportion of an arbitrary sample would make the smoke
run flaky for no gain.

```
# smoke run, ~5 s
CEDAR_CORPUS_LIMIT=200 CEDAR_CORPUS_ENGINE_LIMIT=25 pnpm --filter @nestm/permissions-core exec vitest run tests/conformance

# sweep every mappable case at engine level too
CEDAR_CORPUS_ENGINE_LIMIT=2000 pnpm --filter @nestm/permissions-core exec vitest run tests/conformance
```

`CEDAR_CORPUS_ENGINE_LIMIT` defaults to 500 rather than "everything" because each mapped case builds,
preparses and disposes a whole engine. All 1 096 take 2.9 s here, so 500 lands at ~1.5 s and leaves an
order of magnitude of headroom on a slow CI box — while the binding sweep above already runs all
7 600, and the mapped set is homogeneous enough (one machine-written policy over a machine-written
schema, every time) that the marginal case teaches very little.

## Skips, and why they are not failures

Skips are counted, named and printed; nothing is silently dropped. Two reasons are legitimate:

- **`i64-precision`** — Cedar's `Long` is an i64 and the generated corpus exercises both ends of it.
  JavaScript has no i64: `JSON.parse` turns `9223372036854775807` into the float
  `9223372036854775808`, which cedar-wasm's `RawCedarValueJson` then refuses. Passing a `BigInt`
  instead does not help either — serde-wasm-bindgen throws outright. This is a limitation of the
  **JSON harness**, not a disagreement about Cedar, so the affected cases are skipped under a reason
  that says so. 84 cases / 672 requests (1.1%) at the pinned commit. The same check runs over parsed
  `PolicyJson` at engine level, where a policy holding an out-of-range literal cannot survive the
  text → JSON → WASM round trip the policy store requires (it passes through untouched as text).
- **`entity-deserialization`** — the corpus deliberately contains entity stores Cedar refuses to
  deserialize. Currently 0, because `i64-precision` catches every instance first; the classifier is
  kept so a refresh that introduces a genuine one is skipped rather than counted as a mismatch.

Any **other** `failure` answer from Cedar is a mismatch, not a skip.

Two assertions stop a future refresh from passing vacuously: binding-level `ran / (ran + skipped)`
must exceed 0.95, and skipped requests must stay under 2% of those attempted.

## Reading the output

```
[cedar-corpus] binding · generated
  cases    : 7600 discovered | ran 7516 | skipped 84 (i64-precision: 84)
  requests : 60800 discovered | ran 60128 | skipped 672 (i64-precision: 672) | mismatched 0
  limit    : none — CEDAR_CORPUS_LIMIT unset
  elapsed  : 35542 ms
```

There is one `it()` per corpus group, not one per case: 7 600 vitest tests is minutes of reporter
overhead for the same assertion. The structured tally is what replaces the per-test names. On failure
the first ten offenders are asserted as an array, so vitest's diff prints them verbatim —
`<case file> :: <request description> :: got <decision> reason=[…] errors=[…], want …` — and a
separate assertion on the total count catches a regression wider than ten.

Whole-suite wall time at the pinned commit: **~39 s** (0.1 s handwritten, 35.5 s generated binding,
3.4 s engine).
