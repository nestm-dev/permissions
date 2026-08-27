# @nestm/permissions

Cedar-backed, policy-based authorization for NestJS — granular permissions with database-backed
policies and ORM query filtering.

> [!CAUTION]
> **Pre-alpha.** This repository is a scaffold: the packages below build and publish, but their
> public APIs do not exist yet. Everything is released under the `alpha` dist-tag, all four
> packages move in lockstep, and every release may break. Pin exact versions; do not use this in
> production.

## Packages

| Package                                                        | What it is                                                                                                              |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| [`@nestm/permissions-core`](./packages/permissions-core)       | Framework-free Cedar engine wrapper: typed vocabulary, `PolicyStore`/`EntityProvider` SPIs, the neutral query-plan AST. |
| [`@nestm/permissions`](./packages/permissions)                 | The NestJS 12 module: `PermissionsModule`, a fail-closed guard, `@RequirePermission`, 404-vs-403, route audit.          |
| [`@nestm/permissions-typeorm`](./packages/permissions-typeorm) | TypeORM policy store, `permission_*` schema + migrations, and the plan → SQL / `Brackets` compiler.                     |
| [`@nestm/permissions-drizzle`](./packages/permissions-drizzle) | Drizzle policy store, `createPermissionsSchema()` factory, and the plan → `SQL` compiler.                               |

`@nestm/permissions-core` is a plain dependency of the other three (never a peer), and all four are
versioned in lockstep — one physical copy of core is a correctness requirement, because Cedar's
WASM caches preparsed policy sets per module instance.

## Why

Policy-based authorization for NestJS with **runtime-editable, database-backed policies** and
**ORM row filtering**. Cedar (AWS's formally verified policy language) supplies `permit`/`forbid`,
default-deny, forbid-overrides-permit, conditions, entity hierarchies and schema validation;
partial evaluation supplies a three-state query plan (`ALWAYS_ALLOW` / `ALWAYS_DENY` /
`CONDITIONAL`) that the ORM drivers compile into a `WHERE` clause instead of loading rows and
filtering them in JavaScript.

Everything fails closed: an undeclared route is denied, an unready policy store returns 503, and a
query-plan node that cannot be pushed down throws rather than widening a result set.

## Status and roadmap

The full design is committed under [`docs/design/`](./docs/design):

- [`plan.md`](./docs/design/plan.md) — decisions, phasing, verification and top risks
- [`core.md`](./docs/design/core.md) — `@nestm/permissions-core`
- [`nestjs-module.md`](./docs/design/nestjs-module.md) — `@nestm/permissions` and this scaffold
- [`drivers-and-station.md`](./docs/design/drivers-and-station.md) — the ORM drivers and the migration of a real app
- [`risks.md`](./docs/design/risks.md)

## Development

```bash
corepack enable
pnpm install
pnpm run check   # oxlint + prettier + tsc -b
pnpm run build   # tsdown, per package
pnpm run test    # script specs + every package suite
```

Node >= 22.12 and pnpm 11.24 (pinned via `packageManager`) are required. See
[CONTRIBUTING.md](./CONTRIBUTING.md).

## License

[BSD-3-Clause](./LICENSE) © 2026 nestm
