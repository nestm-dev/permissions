# Not an ADR — a pointer

`docs/design/drivers-and-station.md` §4c/§5 and `docs/design/plan.md` both name
the Cedar-engine decision **ADR-0019**. That number is already taken in the
station working tree:

```
docs/adr/0019-framework-free-cores-concern-specific-nest-adapters.md
```

which landed after the design was written (it is the ADR that introduced
`@station/nestjs-database`, `IdentityModule`, `ApiHttpModule`, `ApiSecurityModule`
and the explicit `AccessTokenGuard` → `PermissionGuard` ordering).

The staged ADR is therefore **`adr/0020-cedar-authorization-engine.md`** in this
directory, destined for
`docs/adr/0020-cedar-authorization-engine.md` in station.

**Do not copy this file into station.** It exists so that a search for the path
the design promised lands somewhere that explains the renumber. If a different
number is assigned before merge, rename the ADR and update the references in
`adr/SECURITY-amendment.md`, `RUNBOOK.md`, `VERIFICATION.md` and the header
comment of `files/database/schema-permissions.ts`.
