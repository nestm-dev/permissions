// ===========================================================================
// COPY-IN DESTINATION: packages/platform/src/authorization/entities.ts
//
// Also required (S2, mechanical):
//   - packages/platform/src/index.ts -> export * from './authorization/entities.js'
// ===========================================================================
//
// Typed constructors over core's `entity()`. The whole point is to move one
// specific failure from evaluation time to construction time: a Cedar policy
// condition touching an attribute an entity does not carry does not evaluate to
// `false`, it *errors*, the policy lands in `errored[]`, and an errored `forbid`
// is dropped from the decision entirely (core.md §0). `entity()` refuses to
// build an entity whose attributes disagree with the vocabulary, so a typo is a
// `SchemaValidationError` thrown by the line that wrote it.
//
// Every builder returns Cedar's `EntityJson`. Types are written
// vocabulary-local (`'Member'`, never `'Station::Member'`); `entity()` qualifies
// on the way out, including parents and entity-typed attributes.
//
// These are pure functions over already-loaded rows. They perform no I/O — the
// I/O lives in `apps/api/src/authorization/authorization-engine.module.ts`,
// which is where the database is.
//
// IMPORT FROM THE `/vocabulary` SUBPATH, same reason as `vocabulary.ts`:
// `entity` and `entityGraph` are VALUE imports, and taking them from the main
// barrel drags the engine, the plan compiler, the policy-store SPI and the
// 4.1 MiB Cedar WASM into anything that transitively imports
// `@station/platform` — `packages/web` included. The subpath is pure
// TypeScript and asserted to be so upstream
// (`packages/permissions-core/tests/unit/vocabulary-entry.test.ts`).
//
// `EntityJson` is the one name here that is NOT on the subpath (it lives on the
// main barrel only). It is a type, and `import type` is erased at compile time,
// so it costs nothing at runtime — but keep the `type` keyword on it. A plain
// `import { EntityJson }` under a non-erasing setting would re-import the whole
// barrel and undo the split silently.

import type { EntityJson } from '@nestm/permissions-core'
import {
  entity,
  entityGraph,
  type EntityRef,
} from '@nestm/permissions-core/vocabulary'

import {
  OPERATORS_GROUP_ID,
  STATION_INSTANCE_ID,
  stationVocabulary,
} from './vocabulary.js'

/** Row shape `members` produces. Structural: `@station/database` supplies it. */
export interface MemberEntityInput {
  readonly id: string
  readonly organizationId: string
  readonly identitySubject: string
}

/** Row shape `projects` produces. */
export interface ProjectEntityInput {
  readonly id: string
  readonly organizationId: string
}

/** Row shape `repositories` produces. */
export interface RepositoryEntityInput {
  readonly id: string
  readonly organizationId: string
  readonly projectId: string
}

/** `Station::Organization::"<id>"`. No attributes, no parents. */
export function organizationEntity(organizationId: string): EntityJson {
  return entity(stationVocabulary, 'Organization', organizationId, {
    attrs: {},
  })
}

/**
 * `Station::Member::"<id>"`, parented to its Organization.
 *
 * The parent edge is what makes `resource in ?resource` reach an org-wide grant
 * without a second lookup, and it is also why the Organization entity must
 * travel in the same graph — Cedar resolves ancestors from the slice it is
 * given, never from a store.
 */
export function memberEntity(member: MemberEntityInput): EntityJson {
  return entity(stationVocabulary, 'Member', member.id, {
    attrs: {
      organization: { type: 'Organization', id: member.organizationId },
      identitySubject: member.identitySubject,
    },
    parents: [{ type: 'Organization', id: member.organizationId }],
  })
}

/** `Station::Project::"<id>"`, parented to its Organization. */
export function projectEntity(project: ProjectEntityInput): EntityJson {
  return entity(stationVocabulary, 'Project', project.id, {
    attrs: {
      organization: { type: 'Organization', id: project.organizationId },
    },
    parents: [{ type: 'Organization', id: project.organizationId }],
  })
}

/**
 * `Station::Repository::"<id>"`, parented to its Project.
 *
 * Note the chain: Repository -> Project -> Organization. Cedar's `in` is
 * transitive, so an org-wide grant reaches a Repository only when the Project
 * entity is also in the graph. `repositoryGraph` builds both.
 */
export function repositoryEntity(
  repository: RepositoryEntityInput,
): EntityJson {
  return entity(stationVocabulary, 'Repository', repository.id, {
    attrs: {
      organization: { type: 'Organization', id: repository.organizationId },
      project: { type: 'Project', id: repository.projectId },
    },
    parents: [{ type: 'Project', id: repository.projectId }],
  })
}

/** `Station::AuditEntry::"<id>"`, parented to its Organization. */
export function auditEntryEntity(auditEntry: {
  readonly id: string
  readonly organizationId: string
}): EntityJson {
  return entity(stationVocabulary, 'AuditEntry', auditEntry.id, {
    attrs: {
      organization: { type: 'Organization', id: auditEntry.organizationId },
    },
    parents: [{ type: 'Organization', id: auditEntry.organizationId }],
  })
}

/** `Station::Instance::"station"` — the singleton instance-scope resource. */
export function instanceEntity(): EntityJson {
  return entity(stationVocabulary, 'Instance', STATION_INSTANCE_ID, {
    attrs: {},
  })
}

/** `Station::Group::"operators"`. */
export function operatorsGroupEntity(): EntityJson {
  return entity(stationVocabulary, 'Group', OPERATORS_GROUP_ID, { attrs: {} })
}

/**
 * `Station::Identity::"<identitySubject>"`, in `Group::"operators"` when the
 * subject is a designated Operator (ADR-0015).
 *
 * A non-Operator gets an Identity with **no** parents rather than no entity at
 * all: the instance policy is `permit(principal in Group::"operators", …)`, so
 * an Identity absent from the slice would make Cedar error on the request
 * rather than deny it.
 */
export function identityEntity(
  identitySubject: string,
  options: { readonly operator: boolean },
): EntityJson {
  return entity(stationVocabulary, 'Identity', identitySubject, {
    attrs: {},
    parents: options.operator
      ? [{ type: 'Group', id: OPERATORS_GROUP_ID }]
      : [],
  })
}

// ---------------------------------------------------------------------------
// Graphs
//
// A *graph* is the narrow slice one decision needs. Narrow is not a style
// preference: entity-graph size dominates Cedar latency (500 irrelevant
// entities is a 20x regression, core.md §0), and `entityGraph()` deduplicates
// by uid because Cedar rejects a slice listing the same uid twice and
// principal/resource graphs routinely share the Organization.
// ---------------------------------------------------------------------------

/** The principal graph for an Organization-scoped decision. */
export function memberGraph(member: MemberEntityInput): readonly EntityJson[] {
  return entityGraph(
    memberEntity(member),
    organizationEntity(member.organizationId),
  )
}

/** The principal graph for an instance-scoped decision (ADR-0015). */
export function identityGraph(
  identitySubject: string,
  options: { readonly operator: boolean },
): readonly EntityJson[] {
  return options.operator
    ? entityGraph(
        identityEntity(identitySubject, options),
        operatorsGroupEntity(),
      )
    : entityGraph(identityEntity(identitySubject, options))
}

/** The resource graph for one Project. */
export function projectGraph(
  project: ProjectEntityInput,
): readonly EntityJson[] {
  return entityGraph(
    projectEntity(project),
    organizationEntity(project.organizationId),
  )
}

/** The resource graph for one Repository — Repository, Project, Organization. */
export function repositoryGraph(
  repository: RepositoryEntityInput,
): readonly EntityJson[] {
  return entityGraph(
    repositoryEntity(repository),
    projectEntity({
      id: repository.projectId,
      organizationId: repository.organizationId,
    }),
    organizationEntity(repository.organizationId),
  )
}

/** The resource graph for the instance singleton. */
export function instanceGraph(): readonly EntityJson[] {
  return entityGraph(instanceEntity())
}

/**
 * Narrows an `EntityRef` to a Station entity type without asserting.
 *
 * Used by the API's entity provider to branch on `request.resource?.type`,
 * which arrives as a bare `string` from the guard.
 */
export function isStationEntityType(
  type: string,
): type is keyof typeof stationVocabulary.def.entities {
  return type in stationVocabulary.def.entities
}

/** Convenience for building an `EntityRef` the guard and the engine accept. */
export function stationRef(type: string, id: string): EntityRef {
  return { type, id }
}
