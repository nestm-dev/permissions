# Examples

Each example is its own pnpm workspace project (`examples/*`) and is never published. They are
excluded from the root `tsc -b` solution and from lint, deliberately: an example is documentation
that happens to run, and it must never be able to break a package's build.

| Example                                | What it shows                                                                                                                                                                                                              |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`station-fastify`](./station-fastify) | Fastify + `PermissionsModule.forRoot()`: a seeded policy store, roles as Cedar groups with a template-link grant, the three `ResourceRef` shapes, the 404-vs-403 denial strategy, and a query-plan-filtered list endpoint. |

```sh
pnpm install
pnpm --filter @nestm/example-station-fastify start
```

A database-backed store (`@nestm/permissions-drizzle` / `-typeorm`) replaces the seeded in-memory one
in a later phase; `station-fastify` is written so that swap is a one-line change to `store`.
