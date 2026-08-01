// ===========================================================================
// COPY-IN DESTINATION: packages/platform/src/authorization/vocabulary.ts
//
// Also required (S2, mechanical):
//   - packages/platform/package.json  -> dependencies: "@nestm/permissions-core"
//   - packages/platform/src/index.ts  -> export * from './authorization/vocabulary.js'
//
// Style matches `packages/platform/src/authorization.ts`: 2-space indent,
// single quotes, no semicolons, `.js` extensions on relative imports.
// ===========================================================================
//
// The Cedar vocabulary is a *projection* of the closed Zod enums in
// `@station/contracts`, never a second source of truth (ADR-0004). Action ids
// are `permissionKeys` verbatim, so `scripts/assert-contracts-clean.mjs`, the
// OpenAPI contract and the generated web client are untouched by this file.
// `vocabulary.test.ts` (staged alongside) asserts the equivalence and fails the
// build if a Permission is added to the enum without an action here.
//
// WHAT DIVERGES FROM design §4a, AND WHY (the tree moved since the design):
//
//   1. `Approval` is dropped. No `approvals` table exists, and no permission
//      key names it, so declaring it would be an entity type nothing can ever
//      construct.
//   2. Entity **attributes** are declared only where a real column backs them
//      today. Design §4a gave `Run { status, project }` and `Gate { status }`;
//      neither table exists, so nothing could populate them. A declared-but-
//      never-populated attribute is precisely the errored-forbid trap
//      (core.md §0): a policy reading it errors, and an errored `forbid` is
//      dropped from the decision. They are listed in DEFERRED below and go in
//      with the tables.
//   3. `Board`, `WorkItem`, `Workflow`, `Run`, `Gate`, `Artifact`, `Secret`
//      have NO backing table today, but their permission keys are in the closed
//      enum, so Cedar needs the entity types to type the actions. They are
//      declared with `memberOf` only. Nothing resolves them yet; the first
//      route that guards one needs an `EntityProvider` in the same change.
//   4. Action groups are declared for `run:*` and `gate:*` only. Groups are
//      excluded from `ActionOf<V>` (they are not requestable) so they cannot
//      break the enum-equivalence test. They are dead weight until a policy
//      names one; the reason to add them now is that retrofitting a group into
//      persisted policies is a migration, whereas adding one now is free.
//
// The `memberOf` chain is the one intended behaviour change on a security
// boundary: Cedar's `in` is transitive AND reflexive, so a project-scoped grant
// reaches Runs/Gates/Artifacts under that Project, which station today cannot
// express. Shadow mode (S6) surfaces that as a divergence class that must be
// reviewed and accepted with a test — see VERIFICATION.md.
//
// ===========================================================================
// WHY THE IMPORT IS `@nestm/permissions-core/vocabulary` AND NOT THE BARREL
//
// A vocabulary is the one artefact station shares with everything that talks
// about its permissions: the API that enforces them, the web client that renders
// them, the contract test that pins them. Most of those never authorize
// anything — and the main barrel hands them the engine, the plan compiler, the
// policy-store SPI and a module graph whose only reason for existing is a
// 4.1 MiB Cedar WASM binary.
//
// The `/vocabulary` subpath is the schema-authoring surface alone, and
// everything reachable from it is pure TypeScript. The upstream package asserts
// that rather than documenting it: `tests/unit/vocabulary-entry.test.ts` probes
// `__cedarLoaded()` after importing the entry.
//
// This is what makes the S2 bundle gate winnable instead of a hope, and it is
// the concrete answer to `dependency-cruiser`'s
// `framework-free-packages-do-not-import-nest` question about what
// `packages/platform` is actually pulling in.
//
// What is deliberately NOT on the subpath: `validateVocabulary`,
// `assertVocabularyValid`, `schemaOf` and `renderVocabularySchemaText`. Every
// one of them asks CEDAR whether a schema is valid, so the WASM is the whole
// point of them and they stay on the main barrel. `vocabulary.test.ts` imports
// `validateVocabulary` from there, dynamically, for exactly that reason — that
// one test is allowed to pay the 4.1 MiB, and nothing else in this package is.
// ===========================================================================

import { defineVocabulary, t } from '@nestm/permissions-core/vocabulary'

export const stationVocabulary = defineVocabulary({
  namespace: 'Station',
  entities: {
    // ---------------------------------------------------------------------
    // Instance scope (ADR-0015). No tables: `Instance` is the singleton
    // resource, `Group::"operators"` is the code-owned membership set, and
    // `Identity` is the JWT subject. Membership comes from an EntityProvider
    // reading the existing global `operators` table.
    // ---------------------------------------------------------------------
    Instance: {},
    Group: {},
    Identity: { memberOf: ['Group'] },

    // ---------------------------------------------------------------------
    // Organization scope. Every type below is a real table today except where
    // noted.
    // ---------------------------------------------------------------------

    /** `organizations` */
    Organization: {},

    /** `projects` */
    Project: {
      memberOf: ['Organization'],
      attrs: {
        // -> projects.organization_id
        organization: t.ref('Organization'),
      },
    },

    /** `members` */
    Member: {
      memberOf: ['Organization'],
      attrs: {
        // -> members.organization_id
        organization: t.ref('Organization'),
        // -> members.identity_subject (ADR-0012: issuer-format string, not a uuid)
        identitySubject: t.string(),
      },
    },

    /** `repositories` */
    Repository: {
      memberOf: ['Project'],
      attrs: {
        // -> repositories.organization_id
        organization: t.ref('Organization'),
        // -> repositories.project_id (composite FK to projects)
        project: t.ref('Project'),
      },
    },

    /** `audit_entries` */
    AuditEntry: {
      memberOf: ['Organization'],
      attrs: {
        // -> audit_entries.organization_id
        organization: t.ref('Organization'),
      },
    },

    // ---------------------------------------------------------------------
    // Declared for the closed permission enum; NO table today. Attributes go
    // in with the tables — see DEFERRED at the bottom of this file.
    // ---------------------------------------------------------------------
    Board: { memberOf: ['Project'] },
    WorkItem: { memberOf: ['Board'] },
    Workflow: { memberOf: ['Repository'] },
    Run: { memberOf: ['Project'] },
    Gate: { memberOf: ['Run'] },
    Artifact: { memberOf: ['Run'] },
    Secret: { memberOf: ['Project'] },
  },

  actions: {
    // ---------------------------------------------------------------------
    // Action groups. Not requestable; excluded from `ActionOf<typeof
    // stationVocabulary>`, so they are invisible to the enum-equivalence test.
    // ---------------------------------------------------------------------
    'run:*': {},
    'gate:*': {},

    // ---------------------------------------------------------------------
    // Instance scope — `instancePermissionKeys` (ADR-0015).
    // ---------------------------------------------------------------------
    'organization:create': { principal: ['Identity'], resource: ['Instance'] },

    // ---------------------------------------------------------------------
    // Organization scope — `permissionKeys`, in catalog order. The order is
    // load-bearing for readability only; `Vocabulary.actionNames` preserves it.
    // ---------------------------------------------------------------------
    'organization:read': { principal: ['Member'], resource: ['Organization'] },
    'organization:manage': {
      principal: ['Member'],
      resource: ['Organization'],
    },
    'project:read': { principal: ['Member'], resource: ['Project'] },
    // Creating a Project acts on the Organization; managing one acts on the
    // Project. Both spellings are declared, and every call site names which.
    'project:manage': {
      principal: ['Member'],
      resource: ['Organization', 'Project'],
    },
    'member:read': { principal: ['Member'], resource: ['Organization'] },
    'member:manage': { principal: ['Member'], resource: ['Organization'] },
    'role:read': { principal: ['Member'], resource: ['Organization'] },
    'role:manage': { principal: ['Member'], resource: ['Organization'] },
    'repository:read': {
      principal: ['Member'],
      resource: ['Project', 'Repository'],
    },
    'repository:manage': {
      principal: ['Member'],
      resource: ['Project', 'Repository'],
    },
    'board:read': { principal: ['Member'], resource: ['Project', 'Board'] },
    'board:manage': { principal: ['Member'], resource: ['Project', 'Board'] },
    'work-item:read': { principal: ['Member'], resource: ['Board', 'WorkItem'] },
    'work-item:create': { principal: ['Member'], resource: ['Board'] },
    'workflow:read': {
      principal: ['Member'],
      resource: ['Repository', 'Workflow'],
    },
    'run:read': {
      memberOf: ['run:*'],
      principal: ['Member'],
      resource: ['Project', 'Run'],
    },
    'run:dispatch': {
      memberOf: ['run:*'],
      principal: ['Member'],
      resource: ['Project', 'Run'],
    },
    'run:cancel': {
      memberOf: ['run:*'],
      principal: ['Member'],
      resource: ['Run'],
    },
    'gate:approve-product': {
      memberOf: ['gate:*'],
      principal: ['Member'],
      resource: ['Gate'],
    },
    'gate:approve-technical': {
      memberOf: ['gate:*'],
      principal: ['Member'],
      resource: ['Gate'],
    },
    'gate:approve-quality': {
      memberOf: ['gate:*'],
      principal: ['Member'],
      resource: ['Gate'],
    },
    'secret:manage': {
      principal: ['Member'],
      resource: ['Organization', 'Project', 'Secret'],
    },
    'artifact:read': { principal: ['Member'], resource: ['Run', 'Artifact'] },
    'audit:read': { principal: ['Member'], resource: ['Organization'] },
    'metrics:read': { principal: ['Member'], resource: ['Organization'] },
  },
})

export type StationVocabulary = typeof stationVocabulary

/**
 * The policy scope every Organization-scoped decision is made in.
 *
 * The `org:` prefix is not decoration: it is what `scopeFrom: { kind: 'param',
 * param: 'organizationId', prefix: 'org:' }` produces in the guard, what
 * `ScopeColumnOptions.toScope` produces in the Drizzle schema, and what keeps
 * a tenant scope textually distinguishable from {@link INSTANCE_SCOPE} in a
 * `CompositePolicyStore` route table and in a WASM policy-set id.
 */
export const ORGANIZATION_SCOPE_PREFIX = 'org:'

/** `'8f3e…'` -> `'org:8f3e…'`. */
export function organizationScope(organizationId: string): string {
  return `${ORGANIZATION_SCOPE_PREFIX}${organizationId}`
}

/** `'org:8f3e…'` -> `'8f3e…'`. Throws on anything else, including `''`. */
export function organizationIdFromScope(scope: string): string {
  if (!scope.startsWith(ORGANIZATION_SCOPE_PREFIX)) {
    throw new Error(
      `"${scope}" is not an Organization policy scope. Station's scope column ` +
        'is a NOT NULL uuid with no value meaning "every tenant", so the global ' +
        'scope has no representation here.',
    )
  }

  return scope.slice(ORGANIZATION_SCOPE_PREFIX.length)
}

/**
 * The instance policy scope (ADR-0015). Served by a code-owned
 * `MemoryPolicyStore` behind a `CompositePolicyStore`, never by the database —
 * `operators` is a global table with no Organization context and no RLS.
 */
export const INSTANCE_SCOPE = 'instance'

/** The singleton `Station::Instance` id. */
export const STATION_INSTANCE_ID = 'station'

/** The `Station::Group` every designated Operator is `in`. */
export const OPERATORS_GROUP_ID = 'operators'

// ---------------------------------------------------------------------------
// DEFERRED — add with the table, never before
// ---------------------------------------------------------------------------
//
// Run:      attrs { project: t.ref('Project'), status: t.string() }
// Gate:     attrs { run: t.ref('Run'), status: t.string() }
// Board:    attrs { project: t.ref('Project') }
// WorkItem: attrs { board: t.ref('Board') }
// Workflow: attrs { repository: t.ref('Repository') }
// Artifact: attrs { run: t.ref('Run') }
// Secret:   attrs { project: t.ref('Project') }
//
// Each of these is only safe once an EntityProvider populates it for every
// entity of that type that can reach a decision. `entity()` refuses to build an
// entity whose attributes disagree with the vocabulary, which is what turns a
// half-done rollout into a construction-time throw instead of a silently
// dropped `forbid`.
