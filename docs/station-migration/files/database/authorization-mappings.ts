// ===========================================================================
// COPY-IN DESTINATION: packages/database/src/authorization-mappings.ts
//
// Also required (S8, mechanical):
//   - packages/database/package.json -> dependencies: "@nestm/permissions-drizzle"
//   - packages/database/src/index.ts  -> export * from "./authorization-mappings.js"
//
// Style matches `packages/database/src/*.ts`: 2-space indent, double quotes,
// semicolons, `.js` extensions on relative imports.
// ===========================================================================
//
// A mapping binds one Cedar resource type to one table. It lives here and not
// in `packages/platform` for one reason: it names drizzle `PgColumn`s, and
// `dependency-cruiser.config.mjs` forbids `packages/platform` from reaching
// `drizzle-orm` at all (`platform-does-not-import-database-infrastructure`).
//
// `@nestm/permissions-drizzle`'s barrel imports no `@nestjs/*` — the framework
// wiring lives behind the `./nestjs` subpath — so importing it here does not
// violate `framework-free-packages-do-not-import-nest` either. Both rules are
// checked by `pnpm dependencies:check`.
//
// WHAT A MAPPING PROMISES. Every claim it makes is verified before any SQL is
// produced, and an unmapped attribute or hierarchy parent raises a typed
// `PlanCompilationError` rather than degrading to `TRUE`. There is no
// configuration in which an uncompilable plan node becomes "select every row".

import type { DrizzleResourceMapping } from "@nestm/permissions-drizzle";

import { projects } from "./schema.js";

/**
 * `Station::Project` -> `projects`.
 *
 * This is the whole of `permissionReach` expressed as data. What the compiler
 * does with it:
 *
 * - an org-wide `project:read` grant leaves the residual
 *   `resource in Station::Organization::"<org>"`, which compiles through the
 *   `Organization` hierarchy entry to `projects.organization_id = $org` —
 *   `permissionReach`'s `{ kind: 'organization' }`, including Projects created
 *   later, which is the property a materialised id list loses;
 * - a project-scoped grant leaves `resource in Station::Project::"<p>"`, and
 *   because Cedar's `in` is reflexive (`X in X` is true) the `Project` entry is
 *   `{ kind: 'self' }` and compiles to `projects.id = $p`, NOT to a parent
 *   lookup. Getting that one wrong is a silent over-block on the exact query
 *   this mapping exists for;
 * - a Member holding both gets the two OR-ed, which is
 *   `permissionReach`'s `{ kind: 'projects' }` unioned with the org-wide reach;
 * - no grant at all is `ALWAYS_DENY`, which compiles to the literal `false` —
 *   `tenancy.service.ts`'s hand-written `reach.kind === 'none' ⇒ return []`
 *   becomes structural.
 *
 * Row-level security still runs underneath as the second wall; the explicit
 * `organization_id` predicate in `listProjects` stays too, because correctness
 * must not depend on a helper never being handed a non-application connection.
 */
export const projectResourceMapping = {
  resourceType: "Project",
  table: projects,
  id: projects.id,
  attributes: {
    // Matches `Project.attrs.organization` in the platform vocabulary. Present
    // so a future policy can say `resource.organization == principal.organization`
    // and still be pushed into SQL.
    organization: {
      kind: "entity",
      column: projects.organizationId,
      entityType: "Organization",
    },
  },
  hierarchy: {
    // Denormalised ancestor id on the row itself.
    Organization: { kind: "column", column: projects.organizationId },
    // Reflexive `in`. See the note above.
    Project: { kind: "self" },
  },
} as const satisfies DrizzleResourceMapping<"Project">;

// ---------------------------------------------------------------------------
// NO OTHER RESOURCE IS LIST-FILTERED TODAY.
//
// Every other collection endpoint in `apps/api` is gated by an Organization-
// wide Permission and returns the whole Organization's rows, so its plan is
// `ALWAYS_ALLOW` after the `organization_id` predicate and there is nothing for
// a mapping to narrow:
//
//   GET /organizations/:id/members        member:read, org scope
//   GET /organizations/:id/invitations     member:read, org scope
//   GET /organizations/:id/roles           role:read,   org scope
//   GET /organizations/:id/role-grants     member:read, org scope
//   GET /organizations/:id/audit-entries   audit:read,  org scope
//   GET /organizations                     the membership bootstrap; filtered
//                                          by N batched `check()` calls, not a
//                                          plan — there is no single table to
//                                          push a filter into, because the
//                                          candidate set comes from the
//                                          identity lens
//
// `repositories` has no list endpoint yet. When it gets one, it is the second
// mapping, and the shape is already determined by the schema:
//
//   export const repositoryResourceMapping = {
//     resourceType: "Repository",
//     table: repositories,
//     id: repositories.id,
//     attributes: {
//       organization: { kind: "entity", column: repositories.organizationId,
//                       entityType: "Organization" },
//       project:      { kind: "entity", column: repositories.projectId,
//                       entityType: "Project" },
//     },
//     hierarchy: {
//       Project:      { kind: "column", column: repositories.projectId },
//       Repository:   { kind: "self" },
//       // VERIFY: `Organization` needs `{ kind: "column", column:
//       // repositories.organizationId }` too — a Repository is transitively in
//       // its Organization through its Project, and the compiler cannot infer
//       // a two-hop path from a one-hop mapping. Omitting it makes an org-wide
//       // grant throw `UnmappedHierarchyError` rather than over-select, which
//       // is the fail-closed direction, but it is still a bug.
//       Organization: { kind: "column", column: repositories.organizationId },
//     },
//   } as const satisfies DrizzleResourceMapping<"Repository">;
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// S8 — the `listProjects` diff this mapping is for.
//
// `packages/database/src/projects.ts`, replacing the `projectIds` option. The
// caller (`TenancyService.listProjects`) compiles the plan with
// `planToSql(plan, projectResourceMapping)` and passes the resulting `SQL`.
//
//   import type { SQL } from "drizzle-orm";
//
//   export interface ListProjectsOptions {
//     /**
//      * A compiled authorization filter — `planToSql(plan,
//      * projectResourceMapping)`. Total by construction: `ALWAYS_ALLOW` is
//      * `true`, `ALWAYS_DENY` is `false`, and there is no value that means
//      * "no filter", because an omitted WHERE is every row.
//      */
//     readonly authorizationFilter?: SQL | undefined;
//   }
//
//   return withOrganizationContext(database, parsedOrganizationId, (transaction) =>
//     transaction
//       .select()
//       .from(projects)
//       .where(
//         and(
//           eq(projects.organizationId, parsedOrganizationId),
//           options.authorizationFilter,
//         ),
//       )
//       .orderBy(projects.name),
//   );
//
// Keep `projectIds` alongside it for the duration of shadow mode so the legacy
// path stays compiled and covered; delete it at S10.
// ---------------------------------------------------------------------------
