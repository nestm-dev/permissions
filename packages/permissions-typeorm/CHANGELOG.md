# @nestm/permissions-typeorm

## 0.1.0-alpha.4

### Minor Changes

- 31b0aa4: Add a request-aware `TypeOrmPolicyStoreExecutor` seam. Foreground policy reads and writes now run on
  one pinned `EntityManager`, declare their exact scopes, access mode, isolation level, and commit
  ownership, and keep local watch events strictly post-commit. The default executor uses a dedicated
  TypeORM `QueryRunner`; tenant/RLS integrations can supply their context-derived transaction runner.
  Isolation requirements are exposed through the `TypeOrmPolicyStoreIsolationLevel` enum.

### Patch Changes

- 5afc225: Compile Cedar entity-set membership over the planned resource identity. Policies such as
  `principal.allowedResources.contains(resource)` now produce an exact primary-key `IN` plan,
  including a constant-deny plan for empty sets, with matching TypeORM, Drizzle, and reference
  interpreter behavior.
- Updated dependencies [5afc225]
  - @nestm/permissions-core@0.1.0-alpha.4

## 0.1.0-alpha.3

### Patch Changes

- @nestm/permissions-core@0.1.0-alpha.3

## 0.1.0-alpha.2

### Patch Changes

- Updated dependencies [ece4c40]
- Updated dependencies [ece4c40]
  - @nestm/permissions-core@0.1.0-alpha.2

## 0.1.0-alpha.1

### Patch Changes

- 27c4567: Initial alpha release of the `@nestm/permissions` family — Cedar-backed, policy-based authorization for NestJS 12.

  - `@nestm/permissions-core`: framework-free engine wrapping `@cedar-policy/cedar-wasm` (pinned 4.12.0) — typed vocabulary builder with action groups, multi-tenant policy stores (memory/composite/read-only) with preparse caching, `check`/`checkMany`, and the three-state query-plan compiler (`ALWAYS_ALLOW` / `ALWAYS_DENY` / `CONDITIONAL`) with a fail-closed contract, reference interpreter, and store-conformance suite on `./testing`; WASM-free `./plan` and `./vocabulary` subpaths.
  - `@nestm/permissions`: the NestJS module — `forRoot`/`forRootAsync`/`forFeature`, typed `@RequirePermission` with param/literal/resolver/unspecified resource refs, fail-closed guard with layered 404-vs-403 denial strategy, principal-resolver interop (`not-in-scope` 404 path), boot-time route audit, interop keys for incremental adoption alongside a legacy guard, and per-scope cache invalidation.
  - `@nestm/permissions-drizzle` / `@nestm/permissions-typeorm`: policy storage drivers (runtime-editable policies in your own Postgres, RLS-compatible schema factories, poll/NOTIFY invalidation) and query-plan→`WHERE` compilers (`planToSql` / `planToBrackets`) so list endpoints fetch only authorized rows — differentially tested against the engine on real Postgres.

- Updated dependencies [27c4567]
  - @nestm/permissions-core@0.1.0-alpha.1

Not released yet. Entries are appended by Changesets when the first `0.1.0-alpha.x` is published.
