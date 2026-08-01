# Contributing

Thank you for helping improve `@nestm/permissions`.

## Setup

```bash
corepack enable
pnpm install
```

Node >= 22.12 required. The repository is a pnpm workspace: `packages/*` are published,
`examples/*` are not.

## Workflow

```bash
pnpm run check           # oxlint + prettier --check + tsc -b
pnpm run lint            # oxlint --type-aware
pnpm run format          # prettier --write
pnpm run typecheck       # tsc -b (solution build over the four package projects)
pnpm run build           # tsdown → packages/*/dist
pnpm run test            # scripts/*.spec.mjs + every package suite
pnpm run verify:pack     # build + publint --strict, per package
node scripts/assert-core-framework-free.mjs
```

Scoped to one package:

```bash
pnpm --filter @nestm/permissions run test
pnpm --filter "...@nestm/permissions-drizzle" run build   # and its workspace deps
```

Every user-visible change needs a changeset: `pnpm changeset`.

## Ground rules

- ESM-only, NestJS 12-only. No CJS escape hatches.
- `experimentalDecorators` + `emitDecoratorMetadata` are load-bearing. **Never enable
  `verbatimModuleSyntax`** — type-only import erasure silently breaks `design:paramtypes` — and
  **never switch the build to an esbuild-based bundler**, which drops the same metadata. CI greps
  `design:paramtypes` out of `packages/permissions/dist/index.mjs` to catch both.
- Local imports carry `.ts` extensions (`allowImportingTsExtensions` +
  `rewriteRelativeImportExtensions`), matching tsdown.
- **`@nestm/permissions-core` stays framework-free.** Not one `@nestjs/*` import or dependency:
  `scripts/assert-core-framework-free.mjs` greps for it, and the `core-framework-free` CI job packs
  the tarball and imports it in a directory with zero `@nestjs` packages installed.
- The four packages are versioned in lockstep (Changesets `fixed` mode). Core is a plain
  `dependency` (`workspace:^`) of the other three, never a peer: a second physical copy of core
  means a second Cedar WASM instance and sporadic "unknown policy set" failures.
- `@cedar-policy/cedar-wasm` is exact-pinned while partial evaluation is experimental. A
  non-blocking CI canary tracks `@latest`; treat every bump as one reviewed change with a full
  differential run.
- Everything public is exported from a package's `src/index.ts`; `tests/unit/exports.test.ts` keeps
  it honest.
- No `console` in package sources.

## Fail-closed design guidelines

Authorization code is the wrong place for "probably fine". When in doubt, deny and throw:

- An undeclared route is **denied**, never allowed by default.
- A policy store that never reached `ready` yields **503**, never "no policies ⇒ allow".
- A policy that errors at evaluation must not silently disappear — an errored `forbid` that is
  dropped is the sharpest security edge in this design. Surface it as an error.
- Query-plan compilation is a **total function**: `ALWAYS_ALLOW → TRUE`, `ALWAYS_DENY → FALSE`, and
  every unmapped or untranslatable node throws a typed error. There must be no configuration in
  which an uncompilable node becomes `TRUE`, and no API that can return "no filter" — an absent
  `WHERE` clause is every row.
- Widening a `permit` is unsafe and must throw; narrowing a `forbid` is safe and is recorded as an
  explicit, tested approximation. That direction analysis is one function; a sign error in it is a
  CVE.
- Never interpolate a plan value into SQL. Bind parameters, and carry Cedar's tokenised `like`
  patterns into the AST rather than re-serialising them (that is the `%`/`_` injection trap).
- New security-relevant behaviour ships with a test that fails when the behaviour is reverted.

## Tests

- vitest 4, `pool: "forks"`, `globals: true`. Package suites live in `packages/*/tests`; the
  release and guard scripts are covered by `scripts/*.spec.mjs` from the workspace root.
- `tests/unit/exports.test.ts` is the barrel contract for each package.
- The NestJS package's e2e suites must pass on **both** the express and fastify adapters.
- Driver suites are differential: brute-force Cedar `check()` vs core's reference plan interpreter
  vs real Postgres rows, set-equality asserted.

Keep tests isolated and deterministic. A test should not depend on execution order or shared
mutable state.

## Pull requests

Keep each pull request limited to one coherent change. In the description:

- explain the problem and the chosen behaviour;
- call out any public API or peer dependency change;
- list the checks you ran; and
- update the package `README.md` and add a changeset when user-visible behaviour changes.

## Releasing

Changesets on `main` create or update the release pull request. Merging it publishes through npm
Trusted Publishing (OIDC, with provenance), tags each package and creates the GitHub release. The
release wrapper `scripts/publish.mjs` refuses to run outside GitHub Actions on `main`, refuses a
dirty worktree, refuses a version set that has drifted out of the Changesets `fixed` group, and
refuses a version whose prerelease identifier disagrees with `.changeset/pre.json`.

### One-time npm bootstrap (per package)

npm only lets maintainers configure a trusted publisher after the package exists. The first
prerelease of **each** of the four packages must therefore be published interactively from a clean
checkout of `main`:

```sh
pnpm --filter @nestm/permissions-core run build
cd packages/permissions-core && npm publish --access public --tag alpha
```

Repeat for `@nestm/permissions`, `@nestm/permissions-typeorm` and `@nestm/permissions-drizzle`.
Complete npm's browser or two-factor flow locally; never add an npm token to this repository. Then
bind each package to the release workflow:

```sh
for PKG in @nestm/permissions-core @nestm/permissions @nestm/permissions-typeorm @nestm/permissions-drizzle; do
  npm trust github "$PKG" \
    --file release.yml \
    --repository nestm-dev/permissions \
    --environment release \
    --allow-publish
done
```

After that one-time setup, merging the Changesets release pull request lets GitHub Actions publish
the next alpha through OIDC with provenance. Once prerelease mode is exited, publishing falls back
to Changesets' normal stable behaviour automatically.

## Reporting security issues

Do not open a public issue for a suspected vulnerability. Follow [SECURITY.md](./SECURITY.md).
