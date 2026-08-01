// ===========================================================================
// COPY-IN DESTINATION: merge into packages/database/src/schema.ts
//
// This is NOT a standalone module. It is written to be pasted at the END of
// `packages/database/src/schema.ts`, because it references `organizations` and
// `roleGrants` and because drizzle-kit only sees `PgTable`s that are top-level
// exports of a file listed in `drizzle.config.ts` (`./src/schema.ts`).
// Splitting it into its own file works too, but then the file must be added to
// `drizzle.config.ts:schema`, and the `roleGrants` import becomes a cycle risk.
//
// Style matches `packages/database/src/schema.ts`: 2-space indent, double
// quotes, semicolons, `.js` extensions on relative imports.
// ===========================================================================
//
// TWO EDITS ARE REQUIRED ELSEWHERE IN schema.ts BEFORE THIS COMPILES.
//
// (1) Extend the import from "drizzle-orm/pg-core" — `uuid`, `foreignKey`,
//     `pgPolicy`, `unique` and `sql` are already imported; nothing new is
//     needed. Add the `@nestm/permissions-drizzle` import at the top:
//
//         import {
//           assertTablesReady,
//           createPermissionsSchema,
//         } from "@nestm/permissions-drizzle";
//
// (2) Add the composite unique key `permission_policy_links` points at.
//     `role_grants` today has `id` as its PRIMARY KEY and two partial unique
//     indexes; a composite FK needs a UNIQUE on exactly `(organization_id, id)`.
//     Every other Organization-scoped table already carries the same
//     constraint under the same naming convention, so this is one line in the
//     existing `roleGrants` extras array:
//
//     --- packages/database/src/schema.ts
//         export const roleGrants = pgTable(
//           "role_grants",
//           { … },
//           (table) => [
//     +      unique("role_grants_organization_id_id_unique").on(
//     +        table.organizationId,
//     +        table.id,
//     +      ),
//             foreignKey({
//               name: "role_grants_organization_member_fk",
//     …
//
// ===========================================================================
// WHY `linkIdColumn` IS SET TO `uuid`
//
// The factory's default is `text("link_id")`. Station reuses `role_grants.id`
// (a `uuid`) as the link id, and PostgreSQL refuses a foreign key between
// `text` and `uuid` ("foreign key constraint cannot be implemented …
// incompatible types").
//
// `linkIdColumn` is a first-class option on both drivers and this is exactly
// what it is for. It is called ONCE PER TABLE IT APPEARS ON (only `links`) and
// must return a FRESH builder each time, like `scopeColumn.column`. The SQL
// name is yours; the drizzle PROPERTY name stays `linkId`, because that is how
// the store reads the column.
//
// A previous revision of this file reached the same result by naming `linkId`
// in `extraColumns.links` and relying on `extraColumns` being spread last in
// the factory's column map. That worked by accident of spread ordering rather
// than by contract. Do not reintroduce it: `linkIdColumn` is the documented
// seam and `extraColumns` should carry only columns the factory does not
// already declare.
//
// ===========================================================================
// HOW `extraTableConfig` IS CALLED — AND WHY THE OLD GUARDS ARE GONE
//
// The factory calls `extraTableConfig(tables)` EXACTLY ONCE PER SCHEMA, with
// all three tables' columns already populated, and builds each key's entries at
// most once. It primes the three `pgTable` config callbacks itself at
// construction, so `tables.policies`, `tables.links` and `tables.scopeVersions`
// are all present by the time this callback runs — which is what lets the
// `links` entries below reference `tables.policies` for the composite FK.
//
// `assertTablesReady(raw)` drops the (now vestigial) optionality in one call
// and throws if a table really is missing, rather than letting entries be
// silently dropped from the generated DDL.
//
// An earlier revision of this file guarded every branch
// (`tables.policies === undefined ? [] : […]`) against the previous release,
// which called the callback once PER TABLE and evaluated the whole returned
// object three times against a progressively-filled `tables`. Those guards were
// not merely obsolete, they were DANGEROUS: drizzle extracts each table's
// config independently and in no guaranteed order, so a `links` entry guarded
// on `tables.policies` returned `[]` whenever the links table was serialised
// first — its composite foreign key and its RLS isolation policy simply absent
// from the migration, with no error anywhere. See
// `docs/design/errata.md` § "drivers-and-station.md (station-readiness pass —
// the Drizzle schema factory)" item 2. A silently unprotected tenant table is
// the exact failure this file exists to prevent; do not reintroduce the guards.
//
// Entries may also be a THUNK (`links: () => [...]`) when something must be
// built late — a `foreignKey` pointing at a table declared after this factory
// runs. Not needed here: `organizations` and `roleGrants` are both declared
// above this block in `schema.ts`.
//
// ===========================================================================
// WHY THE COLUMN IS `t.policies["scope"]` AND NOT `.organizationId`
//
// The factory's column map keys the tenant column by the drizzle PROPERTY name
// `scope`, whatever its SQL name. `scopeColumn.name` only sets the SQL name
// (`organization_id`). `design/drivers-and-station.md` §4e said
// `t.policies.organizationId`; the driver README said the same and has since
// been corrected. The failure is silent, not loud: `t.policies.organizationId`
// is `undefined`, and a `pgPolicy` built by interpolating `undefined` into a
// `sql` template is a policy over nothing — an RLS policy that protects no
// column, on a tenant table. Pinned by
// `packages/permissions-drizzle/tests/unit/schema-factory.test.ts > the scope
// column's property name` and by
// `packages/permissions-drizzle/tests/integration/{rls,drizzle-kit-roundtrip}.test.ts`.
// ===========================================================================

/**
 * The Cedar policy store, bound to Station's tenancy (ADR-0020).
 *
 * The destructuring into top-level `export const`s is load-bearing:
 * drizzle-kit's `prepareFromExports` walks `Object.values(module)` and keeps
 * only values that pass `is(value, PgTable)`. An exported object *containing*
 * the tables passes nothing, so `drizzle-kit generate` emits an empty migration
 * — successfully, with no warning anywhere.
 */
export const {
  permissionPolicies,
  permissionPolicyLinks,
  permissionScopeVersions,
} = createPermissionsSchema<string>({
  // Station's tenant key is `organization_id uuid NOT NULL`, so there is no
  // value meaning "every tenant". `supportsGlobalScope: false` makes the store
  // reject writes to the global scope and skip the global half of the load
  // union entirely — the NULL-tenant escape hatch never exists.
  scopeColumn: {
    name: "organization_id",
    // Called once per table: it must return a FRESH builder each time, because
    // drizzle column builders carry per-table state and reusing one silently
    // attaches the column to whichever table was built last.
    column: () => uuid("organization_id").notNull(),
    toScope: (organizationId) => `org:${organizationId}`,
    fromScope: (scope) => {
      if (!scope.startsWith("org:")) {
        throw new Error(
          `"${scope}" is not an Organization policy scope; permission_* tables ` +
            "carry a NOT NULL organization_id and cannot hold the global scope.",
        );
      }

      return scope.slice(4);
    },
    supportsGlobalScope: false,
  },

  // See "WHY `linkIdColumn` IS SET TO `uuid`" above. Called once, for the
  // `links` table only, and must return a FRESH builder.
  linkIdColumn: () => uuid("link_id").notNull(),

  // Called ONCE, with all three tables populated. No guards — see the banner.
  extraTableConfig: (raw) => {
    const t = assertTablesReady(raw);

    return {
      policies: [
        foreignKey({
          name: "permission_policies_organization_id_organizations_id_fk",
          columns: [t.policies["scope"]],
          foreignColumns: [organizations.id],
        }).onDelete("cascade"),
        pgPolicy("permission_policies_isolation_policy", {
          as: "permissive",
          for: "all",
          to: "public",
          using: sql`${t.policies["scope"]} = nullif(current_setting('station.organization_id', true), '')::uuid`,
          withCheck: sql`${t.policies["scope"]} = nullif(current_setting('station.organization_id', true), '')::uuid`,
        }),
      ],

      links: [
        // A link may only instantiate a template in its own Organization.
        // The driver deliberately emits no FK here (deleting a template must
        // not silently delete every grant under it); Station wants it, because
        // Station's templates are a projection of `roles` and a dangling link
        // is drift, not data.
        //
        // This entry is the one that reaches ACROSS tables — `t.links` and
        // `t.policies` in the same `foreignKey`. It is exactly the shape the
        // old per-table invocation could not express, and exactly the shape a
        // guard on `t.policies` silently dropped.
        foreignKey({
          name: "permission_policy_links_template_fk",
          columns: [t.links["scope"], t.links["templateId"]],
          foreignColumns: [t.policies["scope"], t.policies["policyId"]],
        }).onDelete("cascade"),
        // The projection invariant, enforced by the database rather than by
        // application discipline: `role_grants` is the source of truth, and a
        // link cannot outlive the grant it projects. This is the FK that needs
        // `linkIdColumn` to be `uuid`.
        foreignKey({
          name: "permission_policy_links_role_grant_fk",
          columns: [t.links["scope"], t.links["linkId"]],
          foreignColumns: [roleGrants.organizationId, roleGrants.id],
        }).onDelete("cascade"),
        pgPolicy("permission_policy_links_isolation_policy", {
          as: "permissive",
          for: "all",
          to: "public",
          using: sql`${t.links["scope"]} = nullif(current_setting('station.organization_id', true), '')::uuid`,
          withCheck: sql`${t.links["scope"]} = nullif(current_setting('station.organization_id', true), '')::uuid`,
        }),
      ],

      // NO pgPolicy — the approved carve-out (ADR-0020, docs/SECURITY.md).
      //
      // The invalidation poller runs
      //   SELECT organization_id, version FROM permission_scope_versions
      //   WHERE updated_at > $1
      // with NO Organization context, because it does not know which tenants
      // changed until it reads. Under RLS that predicate is NULL for every row,
      // the poller sees nothing, and no replica ever invalidates its policy
      // cache — a grant revoked on one replica stays effective on the others
      // indefinitely. The table holds no Organization *data*: one monotonic
      // counter keyed by an Organization id `station_app` already knows. What a
      // tenant can learn from it is "something changed in Organization X", and
      // nothing else.
      //
      // The FK still cascades, so deleting an Organization still removes its
      // row.
      scopeVersions: [
        foreignKey({
          name: "permission_scope_versions_organization_id_organizations_id_fk",
          columns: [t.scopeVersions["scope"]],
          foreignColumns: [organizations.id],
        }).onDelete("cascade"),
      ],
    };
  },
});
