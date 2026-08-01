# `docs/SECURITY.md` — the exact edits

Four edits. Three are amendments to existing paragraphs; one is a new
subsection. Line references are to the working-tree copy of
`docs/SECURITY.md` read during S1 — re-locate by the quoted text, not by line
number, if the file has moved since.

Nothing here changes a claim that is already true. The only *new* statement is
the `permission_scope_versions` carve-out, and it is written to be read by
someone auditing the "every Organization-scoped table is RLS-forced" invariant
and finding one table that is not.

---

## Edit 1 — `## Database roles`, the `station_app` bullet

The bullet currently enumerates the role's privileges exhaustively ("Privileges
are exactly: …"), so adding tables without amending it makes the document
wrong.

```diff
 - **`station_app`** — the API's role. Privileges are exactly: `USAGE` on the
   schema, `SELECT` on `permissions`, `operators` (ADR-0015), and the
   `identity_profiles` view (ADR-0017), `SELECT, INSERT, UPDATE, DELETE` on
   eight of the nine Organization-scoped tables (including `invitations`),
-  and `SELECT, INSERT` only on `audit_entries` — no UPDATE or DELETE, so
-  Audit Entries are immutable through the API surface as a grant, not an
-  application promise (ADR-0018).
+  `SELECT, INSERT` only on `audit_entries` — no UPDATE or DELETE, so
+  Audit Entries are immutable through the API surface as a grant, not an
+  application promise (ADR-0018) — `SELECT, INSERT, UPDATE, DELETE` on the two
+  Cedar policy tables `permission_policies` and `permission_policy_links`, and
+  `SELECT, INSERT, UPDATE` on `permission_scope_versions` (ADR-0020). No DELETE
+  on the version table: a role that cannot delete a counter row cannot reset an
+  invalidation stamp backwards, which would make every replica believe its
+  policy cache is fresh.
```

---

## Edit 2 — `## Database roles`, the global-tables paragraph

```diff
 `permissions`, `operators`, and the five identity tables are the global
 tables: the application role treats `permissions` and `operators` as
 read-only and cannot read the identity tables at all — except through the
 three-column `identity_profiles` view (ADR-0017), which executes with its
 owner's privileges and exposes only display data. Roles, grants,
-invitations, and audit entries remain Organization-scoped with forced RLS.
+invitations, audit entries, and the two Cedar policy tables remain
+Organization-scoped with forced RLS. `permission_scope_versions` is the single
+documented exception and is covered in its own subsection below.
 Operator designation is an operational write (seeds, provisioning
 runbooks); no API request can create an Operator.
```

And, in the paragraph immediately after, make the standing rule's wording carry
its own exception clause rather than being quietly contradicted:

```diff
 Integration tests exercise two Organizations through a non-bypass role,
 including missing-context, cross-Organization read/write, pooled-connection
 reuse, `station_auth` visibility, identity-subject scoping, and
 lens-mutual-exclusion cases. A schema change that introduces
 Organization-scoped data must add equivalent RLS policies and isolation
-coverage in the same migration.
+coverage in the same migration. A table keyed by `organization_id` that carries
+no Organization data may be exempted only by an accepted ADR that names what the
+table exposes and why the poll or scan that requires the exemption cannot run
+inside an Organization context; `permission_scope_versions` (ADR-0020) is the
+only such table today.
```

---

## Edit 3 — new subsection, placed immediately after `## Database roles`

```markdown
## The Cedar policy store and its one row-level-security carve-out

Authorization policies live in three tables (ADR-0020).
`permission_policies` holds one Cedar template per `roles` row;
`permission_policy_links` holds one link per `role_grants` row, reusing the
grant's own identifier; `permission_scope_versions` holds one monotonic counter
per Organization. `roles` and `role_grants` remain the source of truth — the
policy tables are a projection written in the same database transaction as the
row they project, with a composite `ON DELETE CASCADE` foreign key from a link
back to its grant, so a link cannot outlive the grant it represents.
`scripts/assert-authz-projection.mjs` proves the reverse direction in CI.

`permission_policies` and `permission_policy_links` carry the same isolation
policy and the same `FORCE ROW LEVEL SECURITY` as every other
Organization-scoped table, comparing `organization_id` against the
transaction-local `station.organization_id` setting. Every read of them goes
through `withOrganizationContext`; the policy store opens one transaction per
cold load, because `set_config(..., true)` is transaction-local and a store
issuing its statements on a different pooled connection would read zero rows —
an empty policy set, which denies everything, which is fail-closed but wrong.

**`permission_scope_versions` deliberately has no row-level security.** It
exists so that a replica learns that another replica changed a grant: every
policy write bumps its Organization's counter in the same transaction, and each
replica polls `WHERE updated_at > $since` — one statement per tick regardless of
tenant count — to discover which Organizations to reload. That poll runs with no
Organization context, because the poller cannot know which tenants changed until
it reads. Under row-level security the predicate is NULL for every row, the poll
returns nothing, and no replica ever invalidates its cache: a revoked grant would
stay effective everywhere except the replica that performed the revoke.

What the table exposes across tenants is one integer and one timestamp per
Organization id — "something in Organization X changed, and this many times".
Not what changed, not who changed it, not whether the reader has any access to
it, and the Organization ids are ones the application role already holds for
every tenant it serves. The table carries no Organization data, so it does not
meet the condition of the rule above; the exemption is recorded here and in
ADR-0020 rather than inferred. The two tables that *do* hold policy content stay
invisible without a context, which is the half that matters. Deleting an
Organization still removes its counter: the foreign key cascades.

Two alternatives were considered and rejected. A SELECT policy permitting reads
when `station.organization_id` is unset — mirroring the identity lens — adds a
second lens to reason about for a table with nothing to protect, and every
future reader has to re-derive why it is safe. Polling per Organization inside a
context turns one query per tick into N transactions per tick, which is a cost
that grows with tenant count for a query whose whole design goal is that it does
not.
```

---

## Edit 4 — `## Permission enforcement`, the opening paragraph

The paragraph describes the guard as resolving "the caller's Member row and Role
grants in one Organization-context transaction". After the cutover it resolves
the Member row and evaluates Cedar against a cached policy set. The 404/403
split, the constant 404 body and the reach semantics are unchanged, and the
amendment should make that explicit rather than leave a reader to compare.

```diff
 Row-level security isolates Organizations; it does not authorize Members.
 Under an Organization context every Member can read all of that
 Organization's rows, so authorization is a distinct layer above RLS: every
 route declares the atomic Permission it enforces (ADR-0004), and a global
-guard resolves the caller's Member row and Role grants in one
-Organization-context transaction before any handler runs. A non-Member
+guard resolves the caller's Member row in one Organization-context transaction
+and evaluates the route's Permission against that Organization's Cedar policy
+set (ADR-0020) before any handler runs. A non-Member
 receives 404 with a body byte-identical to a missing Organization's — no
 response is a cross-tenant existence oracle — while a Member lacking the
 Permission receives 403. Grants are (Member, Role, scope): an org-wide
 grant reaches every Project, a project-scoped grant confines its
 Permissions to one Project, and list endpoints narrow rows to the grant's
 reach. `members.role` is Better Auth plumbing and is never read
 (ADR-0013). Every error serializes as an RFC 9457 problem detail with a
 constant 404 detail (ADR-0014). A boot-time audit refuses to start the API
 while any route lacks a declared Permission, an explicit
 authenticated-identity declaration (`@RequireAuthenticated`, reserved for
 `/me` self-description routes), or a public exemption.
+
+The 404 is not an authorization denial and never reaches the policy engine: it
+is the outcome of failing to resolve a Member row for the authenticated
+identity in that Organization, so no policy — present, future, or
+misconfigured — can make a non-Member's response distinguishable from an
+unknown Organization's. A Member's grants reach transitively through the
+entity hierarchy, so a project-scoped grant reaches records belonging to that
+Project rather than only the Project row itself; an org-wide grant reaches
+every Project, including Projects created after the grant. A policy set that
+cannot be loaded is a 503, never an allow, and a failed invalidation poll leaves
+the previous policy set in place rather than clearing it.
```

---

## Not changed, and worth stating in review

- `## PostgreSQL Organization context` — unchanged. The new policy tables use
  the same `withOrganizationContext` entry point and the same predicate.
- `## Identity subject context` — unchanged. The Cedar migration adds no new
  lens and no new use of `station.identity_subject`.
- The `station_auth` bullet — unchanged. Better Auth's role receives **no**
  privilege on any of the three new tables. Its one authorization path
  (`organizationHooks`, ADR-0016) runs through Station's application role, not
  its own.
- `## Secrets and transport` — unchanged.
