# @nestm/permissions-core

## 0.1.0-alpha.4

### Patch Changes

- 5afc225: Compile Cedar entity-set membership over the planned resource identity. Policies such as
  `principal.allowedResources.contains(resource)` now produce an exact primary-key `IN` plan,
  including a constant-deny plan for empty sets, with matching TypeORM, Drizzle, and reference
  interpreter behavior.

## 0.1.0-alpha.3

## 0.1.0-alpha.2

### Patch Changes

- ece4c40: Make Drizzle policy reads and writes composable with request-aware RLS executors, including
  repeatable-read bundle snapshots and post-commit invalidation. Preserve custom scope-column builder
  types on the generated Drizzle tables so tenant/RLS helpers can consume them without casts.
  Re-resolve handler-side authorization entities when providers are available, expose options on
  `can`, recognize permissions errors across package copies, and report guard-time operational
  failures as engine-unavailable responses. Await delayed sibling providers used by `useExisting` or
  `useFactory.inject` before constructing the authorization engine.
- ece4c40: Prevent invalidations that race an in-flight policy load from being lost, and include the planned
  resource type in entity-resolution requests. Wrap Nest entity-provider failures as structural
  permissions errors so guard-time outages consistently map to the engine-unavailable response.

  Replace Drizzle's timestamp-watermark invalidation poll with monotonic per-scope version comparison,
  including out-of-order commit safety. Declare isolation level and commit-ownership requirements on
  every executor call, and reject the default executor when it receives an ambient Drizzle transaction
  whose savepoint cannot satisfy those guarantees. Newly generated schemas omit the now-unused
  `scope_versions.updated_at` index; existing deployments may drop that index separately.

## 0.1.0-alpha.1

### Patch Changes

- 27c4567: Initial alpha release of the `@nestm/permissions` family — Cedar-backed, policy-based authorization for NestJS 12.

  - `@nestm/permissions-core`: framework-free engine wrapping `@cedar-policy/cedar-wasm` (pinned 4.12.0) — typed vocabulary builder with action groups, multi-tenant policy stores (memory/composite/read-only) with preparse caching, `check`/`checkMany`, and the three-state query-plan compiler (`ALWAYS_ALLOW` / `ALWAYS_DENY` / `CONDITIONAL`) with a fail-closed contract, reference interpreter, and store-conformance suite on `./testing`; WASM-free `./plan` and `./vocabulary` subpaths.
  - `@nestm/permissions`: the NestJS module — `forRoot`/`forRootAsync`/`forFeature`, typed `@RequirePermission` with param/literal/resolver/unspecified resource refs, fail-closed guard with layered 404-vs-403 denial strategy, principal-resolver interop (`not-in-scope` 404 path), boot-time route audit, interop keys for incremental adoption alongside a legacy guard, and per-scope cache invalidation.
  - `@nestm/permissions-drizzle` / `@nestm/permissions-typeorm`: policy storage drivers (runtime-editable policies in your own Postgres, RLS-compatible schema factories, poll/NOTIFY invalidation) and query-plan→`WHERE` compilers (`planToSql` / `planToBrackets`) so list endpoints fetch only authorized rows — differentially tested against the engine on real Postgres.

Not released yet. Entries are appended by Changesets when the first `0.1.0-alpha.x` is published.
