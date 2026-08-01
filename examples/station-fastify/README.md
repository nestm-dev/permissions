# station-fastify

A small but **real** Fastify application wired with `@nestm/permissions`. Nothing is stubbed: it
boots a Cedar engine, seeds a policy store, resolves an entity graph per request, and answers 200 /
400 / 401 / 403 / 404 from actual policy evaluation.

It exists to make four things concrete:

1. **Roles are Cedar groups, grants are template links.** `Member.memberOf: ["Organization", "Role"]`
   is what makes `principal in Station::Role::"admin"` work, and `grant:reader-nightly` is one row —
   the shape an admin UI writes and deletes.
2. **Three route shapes**, one per `ResourceRef`: `literal`, `param` (validated in the guard), and
   `unspecified` (a query plan).
3. **Guards run before pipes**, so a route parameter is validated by `parseAs` — here a hand-written
   [Standard Schema](https://standardschema.dev) validator, to show that the contract is structural
   and needs no dependency.
4. **404 vs 403.** `trudy` belongs to another organisation, so her principal resolves to
   `NOT_IN_SCOPE` and every route answers **404** — the same body an unknown tenant would get.
   `mallory` is a member with no roles and gets **403**.

## Run it

```sh
pnpm install                                     # once — this example is a new workspace project
pnpm --filter @nestm/example-station-fastify start
```

`start` builds with **tsdown** and runs `dist/main.mjs`. That indirection is not incidental: an
esbuild-based runner (`tsx`, `ts-node/swc`) silently drops `design:paramtypes`, and every constructor
injection in the app stops resolving. It is the same reason the packages themselves never use one.

The process prints a `curl` line for each behaviour below, and logs every authorization decision
through `hooks.onDecision`:

```text
[authz] RunsController.list deny(unauthenticated) principal=- action=run:read scope=org:acme 1ms
[authz] RunsController.list allow principal=alice action=run:read scope=org:acme 8ms
[authz] RunsController.find deny(forbidden) principal=alice action=run:read scope=org:acme 0ms
[authz] RunsController.find deny(invalid-resource-param) principal=alice action=run:read scope=org:acme 0ms
```

## What to try

| Request                                            | Answer  | Why                                                                      |
| -------------------------------------------------- | ------- | ------------------------------------------------------------------------ |
| `GET /runs`                                        | **401** | No `x-user` header → the principal resolver returns `null`.              |
| `GET /runs` with `x-user: alice`                   | **200** | A `CONDITIONAL` plan; the response shows the condition and the rows.     |
| `GET /runs/run-1` with `x-user: alice`             | **200** | `nightly` project, granted by the template link.                         |
| `GET /runs/run-4` with `x-user: alice`             | **403** | `release` project — no grant.                                            |
| `GET /runs/run-3` with `x-user: alice`             | **403** | Archived: a `forbid` always beats a `permit`.                            |
| `GET /runs/nope` with `x-user: alice`              | **400** | `parseAs` rejected the id in the guard, before Cedar saw it.             |
| `GET /runs` with `x-user: mallory`                 | **403** | A member with no roles: the plan is `ALWAYS_DENY`, so the guard refuses. |
| `POST /runs/nightly/dispatch` with `x-user: bob`   | **201** | `bob` holds `admin`; the resource is named literally.                    |
| `POST /runs/nightly/dispatch` with `x-user: alice` | **403** | `reader` does not dispatch.                                              |
| `GET /runs` with `x-user: trudy`                   | **404** | Another organisation. Never 403 — that would confirm the tenant exists.  |
| `GET /runs/whoami/me` with `x-user: mallory`       | **200** | `@RequireAuthenticated()`: a principal, no Cedar decision.               |

The list response is worth reading:

```text
{
  "kind": "CONDITIONAL",
  "condition": {
    "op": "and",
    "nodes": [
      { "op": "inHierarchy", "attr": null, "parent": { "type": "Project", "id": "nightly" } },
      { "op": "cmp", "cmp": "ne",
        "attr":  { "root": "resource", "path": ["status"] },
        "value": { "kind": "string", "value": "archived" } }
    ]
  },
  "approximations": 0,
  "runs": [ run-1, run-2 ]
}
```

That AST is the grant and the forbid, compiled into one filter: `inHierarchy` is
`resource in ?resource` from the template link, and the `ne` is the `forbid` — note that Cedar folded
`!(status == "archived")` into a single comparison rather than leaving a `not` wrapper, which is the
sort of thing a driver never has to think about.

`approximations: 0` means the plan is **exact**: the rows it selects are precisely the rows `check()`
would allow, with nothing dropped and nothing widened.

## Files

| File                                       | What it shows                                                                     |
| ------------------------------------------ | --------------------------------------------------------------------------------- |
| `src/authorization/vocabulary.ts`          | One vocabulary → Cedar schema + TypeScript unions, and the registry augmentation. |
| `src/authorization/policies.ts`            | A template, a static role permit, a conditional forbid, and one grant link.       |
| `src/authorization/identity.ts`            | `RequestPrincipalResolver` + the principal graph, resolved once per request.      |
| `src/authorization/run-entity.provider.ts` | An `@EntityProvider()` contributing the resource half of the graph.               |
| `src/runs/runs.controller.ts`              | The four route shapes.                                                            |
| `src/runs/run-id.schema.ts`                | A Standard Schema validator with no dependency.                                   |
| `src/runs/plan-filter.ts`                  | A **demo** `PlanNode` evaluator — see the warning below.                          |
| `src/main.ts`                              | The Fastify `onRequest` hook standing in for a real auth layer.                   |

> [!WARNING]
> `plan-filter.ts` evaluates the plan in JavaScript, over rows already in memory. **That is not how
> you filter a database.** `@nestm/permissions-drizzle` and `@nestm/permissions-typeorm` compile the
> very same `PlanNode` into a parameter-bound `WHERE` clause, which is the entire point of a query
> plan. It is written out here so the AST is visible, and because those driver packages ship in a
> later phase.

## Notes

- **Not part of `tsc -b`.** The example has its own self-contained `tsconfig.json` and is not a
  reference of the root solution config, so a broken example can never break the packages' typecheck.
  Check it with `pnpm --filter @nestm/example-station-fastify run typecheck`.
- **`routeAudit: { mode: "error" }`** is on. Delete a `@RequirePermission()` from the controller and
  the app refuses to boot, naming the endpoint.
- The store is the built-in in-memory one, seeded from `policies`/`links`. Swapping in a database
  store is `store: { useClass: … }` and nothing else in the app changes.
