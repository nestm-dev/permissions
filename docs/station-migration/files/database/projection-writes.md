# S4 — transactional projection writes

`role_grants` stays the source of truth. `permission_policies` (templates) and
`permission_policy_links` (links) are a **projection**, written in the *same
database transaction* as the row they project. Same database, so this is not a
distributed dual-write and there is nothing to reconcile: either both land or
neither does.

Three properties this preserves, and each one is why the shape is what it is:

- the `Role`/`RoleGrant` OpenAPI contract and the generated web client are
  **byte-identical** — no request or response shape changes;
- the `pg_advisory_xact_lock` "last administrator" protection in
  `revokeRoleGrant` keeps working, because the lock is still the *first*
  statement in the transaction and the projection write is inside it;
- a link cannot outlive its grant, structurally: the composite FK
  `permission_policy_links(organization_id, link_id) -> role_grants(organization_id, id)`
  is `ON DELETE CASCADE`.

---

## New file: `packages/database/src/authorization-projection.ts`

Also required (mechanical):

- `packages/database/package.json` → `dependencies`: `"@nestm/permissions-core"`
  (for the `PolicyJson` type; nothing here loads the Cedar WASM — `loadCedar()`
  is the only reachable `import("@cedar-policy/cedar-wasm")` and it is never
  called from this package);
- `packages/database/src/index.ts` → `export * from "./authorization-projection.js"`.

```ts
import type { PermissionKey, OrganizationId, RoleId } from "@station/contracts";
import type { PolicyJson } from "@nestm/permissions-core";
import { and, eq, sql } from "drizzle-orm";

import type { OrganizationScopedTransaction } from "./organization-context.js";
import {
  permissionPolicies,
  permissionPolicyLinks,
  permissionScopeVersions,
  permissions,
  rolePermissions,
} from "./schema.js";

/** The Cedar namespace `@station/platform`'s vocabulary declares. */
const CEDAR_NAMESPACE = "Station";

/**
 * The `permission_policies.policy_id` of one Role's template.
 *
 * Derived from `roles.id` rather than stored, so the projection needs no extra
 * column and the backfill is idempotent by construction.
 */
export function roleTemplatePolicyId(roleId: string): string {
  return `role:${roleId}`;
}

/**
 * One Role bundle as a Cedar **template**, in Cedar's canonical JSON form:
 *
 *     permit(
 *       principal == ?principal,
 *       action in [Station::Action::"organization:read", …],
 *       resource in ?resource
 *     );
 *
 * Built structurally rather than parsed from policy text on purpose: parsing
 * text needs the Cedar binding, which means the 4.1 MiB WASM, and
 * `@station/database` is a framework-free package that a migration script and a
 * seed both import. The shape is pinned by `cedar-wasm@4.12.0`'s own `.d.ts`
 * (`PolicyJson`, `EqConstraint = { entity } | { slot }`,
 * `ActionInConstraint = { entity } | { entities }`) and is asserted by
 * `authorization-projection.test.ts` (below).
 *
 * `?resource` carries the grant scope: `Station::Organization::"<org>"` for an
 * org-wide grant, `Station::Project::"<project>"` for a project-scoped one.
 * Cedar's `in` is reflexive AND transitive, which is what makes one template
 * serve both — and is also the intended reach widening this migration ships.
 */
export function roleTemplateCedarJson(
  roleId: string,
  roleKey: string,
  permissionKeys: readonly PermissionKey[],
): PolicyJson {
  return {
    effect: "permit",
    principal: { op: "==", slot: "?principal" },
    action: {
      op: "in",
      entities: permissionKeys.map((key) => ({
        type: `${CEDAR_NAMESPACE}::Action`,
        id: key,
      })),
    },
    resource: { op: "in", slot: "?resource" },
    conditions: [],
    // NOT `@id`: the policy id lives in the `policy_id` column, and a Cedar
    // annotation that shadows it is one more thing that can disagree. These two
    // exist so an operator reading the table can join back to `roles`.
    annotations: {
      station_role_id: roleId,
      station_role_key: roleKey,
    },
  };
}

/**
 * Bumps the Organization's invalidation counter.
 *
 * MUST be called in the same transaction as every projection write. Monotonic
 * and clock-skew-immune: replicas poll `updated_at > $since` and reload the
 * scopes whose counter moved.
 */
export async function bumpPermissionScopeVersion(
  transaction: OrganizationScopedTransaction,
  organizationId: OrganizationId,
): Promise<void> {
  await transaction
    .insert(permissionScopeVersions)
    .values({ scope: organizationId })
    .onConflictDoUpdate({
      target: permissionScopeVersions.scope,
      set: {
        version: sql`${permissionScopeVersions.version} + 1`,
        updatedAt: sql`now()`,
      },
    });
}

/**
 * Upserts one Role's template from `role_permissions`, and returns whether a
 * template now exists.
 *
 * Reads the bundle rather than taking it as an argument so there is exactly one
 * definition of "what this Role currently carries" — the same join
 * `listRoles` uses. That is what makes this function safe to call from the
 * grant path, from the seed path and from the backfill script with identical
 * results.
 *
 * A Role carrying **no** Permissions gets no template and any existing one is
 * deleted: `action in []` is valid Cedar but never satisfiable, and Cedar's
 * validator flags an unsatisfiable policy — carrying dead weight through
 * `validateOnLoad` on every cold load is worse than the row not existing.
 * A Role with no Permissions authorizes nothing either way.
 */
export async function syncRoleTemplateInTransaction(
  transaction: OrganizationScopedTransaction,
  organizationId: OrganizationId,
  role: { readonly id: RoleId | string; readonly key: string },
): Promise<boolean> {
  const policyId = roleTemplatePolicyId(role.id);

  const bundleRows = await transaction
    .select({ key: permissions.key })
    .from(rolePermissions)
    .innerJoin(permissions, eq(permissions.id, rolePermissions.permissionId))
    .where(
      and(
        eq(rolePermissions.organizationId, organizationId),
        eq(rolePermissions.roleId, role.id),
      ),
    )
    .orderBy(permissions.key);

  const permissionKeys = bundleRows.map((row) => row.key as PermissionKey);

  if (permissionKeys.length === 0) {
    await transaction
      .delete(permissionPolicies)
      .where(
        and(
          eq(permissionPolicies.scope, organizationId),
          eq(permissionPolicies.policyId, policyId),
        ),
      );

    return false;
  }

  const cedarJson = roleTemplateCedarJson(role.id, role.key, permissionKeys);

  await transaction
    .insert(permissionPolicies)
    .values({
      scope: organizationId,
      policyId,
      kind: "template",
      cedarJson,
      description: `Role bundle "${role.key}".`,
      annotations: {
        station_role_id: String(role.id),
        station_role_key: role.key,
      },
      enabled: true,
    })
    .onConflictDoUpdate({
      target: [permissionPolicies.scope, permissionPolicies.policyId],
      set: {
        cedarJson,
        description: `Role bundle "${role.key}".`,
        annotations: {
          station_role_id: String(role.id),
          station_role_key: role.key,
        },
        enabled: true,
        updatedAt: sql`now()`,
      },
    });

  return true;
}

/**
 * Writes the link projecting one `role_grants` row.
 *
 * `link_id` IS `role_grants.id`: the backfill is idempotent, and a revoke is a
 * delete by the same key. Slot values carry **vocabulary-local** entity types
 * (`"Member"`, not `"Station::Member"`); the engine namespace-qualifies them
 * when it builds the policy set.
 */
export async function writeRoleGrantLinkInTransaction(
  transaction: OrganizationScopedTransaction,
  organizationId: OrganizationId,
  grant: {
    readonly id: string;
    readonly memberId: string;
    readonly roleId: string;
    readonly scope: "organization" | "project";
    readonly projectId: string | null;
  },
): Promise<void> {
  const resource =
    grant.scope === "project"
      ? { type: "Project", id: grant.projectId }
      : { type: "Organization", id: organizationId };

  if (resource.id === null) {
    // Unreachable behind `role_grants_scope_project_check`; failing loudly beats
    // writing a link whose `?resource` slot is half-filled.
    throw new Error(
      "A project-scoped Role grant must reference a Project before it can be projected",
    );
  }

  await transaction
    .insert(permissionPolicyLinks)
    .values({
      scope: organizationId,
      linkId: grant.id,
      templateId: roleTemplatePolicyId(grant.roleId),
      principalType: "Member",
      principalId: grant.memberId,
      resourceType: resource.type,
      resourceId: resource.id,
    })
    .onConflictDoUpdate({
      target: [permissionPolicyLinks.scope, permissionPolicyLinks.linkId],
      set: {
        templateId: roleTemplatePolicyId(grant.roleId),
        principalType: "Member",
        principalId: grant.memberId,
        resourceType: resource.type,
        resourceId: resource.id,
        updatedAt: sql`now()`,
      },
    });
}

/**
 * Removes the link projecting one grant.
 *
 * Redundant while the composite FK is `ON DELETE CASCADE` — and deliberately
 * kept, so the projection is still correct if that constraint is ever dropped
 * (see the `link_id uuid` note in `schema-permissions.ts`).
 */
export async function deleteRoleGrantLinkInTransaction(
  transaction: OrganizationScopedTransaction,
  organizationId: OrganizationId,
  roleGrantId: string,
): Promise<void> {
  await transaction
    .delete(permissionPolicyLinks)
    .where(
      and(
        eq(permissionPolicyLinks.scope, organizationId),
        eq(permissionPolicyLinks.linkId, roleGrantId),
      ),
    );
}
```

---

## Diff 1 — `packages/database/src/seed.ts`, `createDefaultRoleBundles`

Writes each seeded bundle's template in the transaction that already writes the
`roles` and `role_permissions` rows. No new seeding path, and the existing
`onConflictDoNothing` idempotence is untouched.

```diff
 import type { StationDatabase } from "./client.js";
 import { withOrganizationContext } from "./organization-context.js";
 import { permissions, rolePermissions, roles } from "./schema.js";
+import {
+  bumpPermissionScopeVersion,
+  syncRoleTemplateInTransaction,
+} from "./authorization-projection.js";
@@
       const createdRoleKeys: DefaultRoleKey[] = [];
 
       for (const bundle of defaultRoleBundles) {
         const [createdRole] = await transaction
           .insert(roles)
           .values({
             organizationId,
             key: bundle.key,
             name: bundle.name,
             description: bundle.description,
           })
           .onConflictDoNothing({
             target: [roles.organizationId, roles.key],
           })
           .returning({ id: roles.id });
 
         if (!createdRole) {
           continue;
         }
 
         createdRoleKeys.push(bundle.key);
 
         await transaction.insert(rolePermissions).values(
           bundle.permissions.map((permissionKey) => {
             const permissionId = permissionIds.get(permissionKey);
 
             if (!permissionId) {
               throw new Error(
                 `Permission catalog is missing key: ${permissionKey}`,
               );
             }
 
             return {
               organizationId,
               roleId: createdRole.id,
               permissionId,
             };
           }),
         );
+
+        // Same transaction: a Role and the Cedar template projecting it are
+        // never observable apart. Reads `role_permissions` back rather than
+        // re-using `bundle.permissions`, so there is one definition of "what
+        // this Role carries" and the seed path cannot drift from the grant path.
+        await syncRoleTemplateInTransaction(transaction, organizationId, {
+          id: createdRole.id,
+          key: bundle.key,
+        });
       }
 
+      if (createdRoleKeys.length > 0) {
+        await bumpPermissionScopeVersion(transaction, organizationId);
+      }
+
       return {
         permissionCount: permissionIds.size,
         createdRoleKeys,
       };
```

---

## Diff 2 — `packages/database/src/authorization.ts`, `createRoleGrant`

Two additions inside the existing `withOrganizationContext` transaction, both in
the `if (created)` branch, **before** the audit write so a failed projection
aborts the whole grant rather than leaving an Audit Entry for a grant that did
not commit.

`syncRoleTemplateInTransaction` runs here and not only in the seed because the
link's `template_id` is a foreign key: granting a Role whose template does not
exist yet would fail with a bare constraint violation. Making the grant path
self-healing is what lets a Role created outside `createDefaultRoleBundles` —
which is exactly what `authorization.blackbox.test.ts:136-165` does with its
`release-manager` Role — work with **no change to the test**.

```diff
 import {
   members,
   permissions,
   projects,
   roleGrants,
   rolePermissions,
   roles,
 } from "./schema.js";
+import {
+  bumpPermissionScopeVersion,
+  deleteRoleGrantLinkInTransaction,
+  syncRoleTemplateInTransaction,
+  writeRoleGrantLinkInTransaction,
+} from "./authorization-projection.js";
@@ export async function createRoleGrant(
       const [role] = await transaction
-        .select({ id: roles.id, key: roles.key, name: roles.name })
+        .select({ id: roles.id, key: roles.key, name: roles.name })
         .from(roles)
@@
       if (created) {
+        // The projection, in this transaction. Order matters: the template must
+        // exist before the link's composite FK can reference it.
+        const templated = await syncRoleTemplateInTransaction(
+          transaction,
+          parsedOrganizationId,
+          { id: role.id, key: role.key },
+        );
+
+        if (templated) {
+          await writeRoleGrantLinkInTransaction(
+            transaction,
+            parsedOrganizationId,
+            {
+              id: created.id,
+              memberId: created.memberId,
+              roleId: created.roleId,
+              scope: created.scope,
+              projectId: created.projectId,
+            },
+          );
+        }
+
+        await bumpPermissionScopeVersion(transaction, parsedOrganizationId);
+
         if (options.audit) {
```

> A Role carrying no Permissions produces no template and therefore no link
> (`templated === false`). That grant authorizes nothing under either engine, so
> the projection is complete without it — and
> `scripts/assert-authz-projection.mjs` excludes empty-bundle Roles for exactly
> this reason.

---

## Diff 3 — `packages/database/src/authorization.ts`, `revokeRoleGrant`

The advisory lock stays the **first** statement; nothing below reorders it. The
link delete goes immediately after the grant delete, and the version bump after
both — inside the same transaction, so a rolled-back revoke rolls the
invalidation back with it.

```diff
       await transaction
         .delete(roleGrants)
         .where(
           and(
             eq(roleGrants.organizationId, parsedOrganizationId),
             eq(roleGrants.id, parsedRoleGrantId),
           ),
         );
 
+      // Redundant with the FK's ON DELETE CASCADE, and kept anyway: the
+      // projection stays correct if that constraint is ever dropped, and an
+      // explicit delete is what the drift script's invariant reads like.
+      await deleteRoleGrantLinkInTransaction(
+        transaction,
+        parsedOrganizationId,
+        parsedRoleGrantId,
+      );
+
+      await bumpPermissionScopeVersion(transaction, parsedOrganizationId);
+
       if (options.audit) {
```

**Do not** move the lock, and do not add a projection write before it. The
`last-administrator` check is check-then-delete; without the lock two concurrent
revokes of two different grants each see the other as the survivor and both
commit (write skew under READ COMMITTED), bricking the Organization.

---

## Staleness: resolved with `PermissionsService.invalidate(scope)`

`drivers-and-station.md` §4g says a revoke is "effective **immediately** on the
replica that performed the revoke". That holds when the write goes through
`DrizzlePolicyStore.save()`, which emits a change event synchronously after
commit. These writes go through `@station/database` instead — deliberately, so
they can share the grant's transaction and the advisory lock — so **no store
event is emitted**, and without an explicit invalidation every replica,
including the writer, would learn from the 5-second poller.

`PermissionsService.invalidate(scope)` is the primitive for exactly this case.
`RolesService.createRoleGrant` / `revokeRoleGrant` call it with the affected
Organization's scope **after the transaction commits**:

```ts
// apps/api/src/roles/roles.service.ts
async createRoleGrant(organizationId: OrganizationId, input: CreateRoleGrantInput) {
  const grant = await this.#roles.createRoleGrant(organizationId, input)

  // AFTER commit, never inside the transaction. The projection rows are not
  // visible to another connection until commit, so an invalidation issued
  // inside would drop the cache and let the very next check reload the OLD
  // bundle — leaving a stale entry with a fresh timestamp, which is strictly
  // worse than not invalidating at all.
  await this.#permissions.invalidate(organizationScope(organizationId))

  return grant
}
```

Same shape in `revokeRoleGrant`, after the repository call returns.

Why the scoped call rather than `reload()`:

- `reload()` is `engine.invalidate('*')` — it drops **every** tenant's cached
  policy set to publish one tenant's grant. On a busy instance that is a
  thundering herd against the policy store: every Organization served by that
  replica takes a cold load on its next request.
- `invalidate('org:<id>')` drops exactly the one scope that changed. Every other
  tenant keeps its warm cache.
- Compiled query plans for the scope are dropped outright rather than served
  stale (core's contract), so it is safe to call on the write path.

The poller remains the backstop for the *other* replicas, and the staleness
window never *widens* access: a stale policy set is the previous one, and the
version bump the projection writes is what makes the next poll notice.

**Gate:** the blackbox case `'grants and revokes a Role through the API and
access follows'` is what proves the call is present and correctly placed — it
asserts the change is observable within the request that follows, on the same
replica, which is precisely what the 5-second poller cannot deliver. If it
passes with the `invalidate` line deleted, the test is being satisfied by
something else and is not holding this line.

---

## Test to add: `packages/database/src/authorization-projection.test.ts`

Pure, no database — the Cedar JSON shape is the thing that must not drift.

```ts
import { describe, expect, it } from "vitest";

import {
  roleTemplateCedarJson,
  roleTemplatePolicyId,
} from "./authorization-projection.js";

describe("roleTemplateCedarJson", () => {
  it("emits a Cedar template with both slots", () => {
    expect(roleTemplateCedarJson("r1", "admin", ["run:read", "run:dispatch"]))
      .toEqual({
        effect: "permit",
        principal: { op: "==", slot: "?principal" },
        action: {
          op: "in",
          entities: [
            { type: "Station::Action", id: "run:read" },
            { type: "Station::Action", id: "run:dispatch" },
          ],
        },
        resource: { op: "in", slot: "?resource" },
        conditions: [],
        annotations: { station_role_id: "r1", station_role_key: "admin" },
      });
  });

  it("derives the policy id from the Role id", () => {
    expect(roleTemplatePolicyId("r1")).toBe("role:r1");
  });
});
```

And, in `packages/database/src/database.integration.test.ts` (which already runs
against real PostgreSQL under `station_app`):

- creating a grant writes exactly one link with the grant's own id;
- revoking it removes the link and leaves the template;
- deleting the `role_grants` row directly removes the link by cascade;
- the version counter is strictly greater after each of the three;
- a grant for a Role with an empty bundle writes no link and no template;
- a cross-Organization link write is refused with SQLSTATE `42501`
  (`new row violates row-level security policy` — note drizzle wraps the driver
  error, so that text is on `error.cause`, not on the thrown error's message).
