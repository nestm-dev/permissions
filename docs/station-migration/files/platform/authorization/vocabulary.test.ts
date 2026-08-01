// ===========================================================================
// COPY-IN DESTINATION: packages/platform/src/authorization/vocabulary.test.ts
//
// This is the S2 gate. It is the reason `packages/contracts` stays the single
// source of truth for the permission catalog: adding a key to the closed Zod
// enum without adding an action here fails the build, and adding an action here
// that is not a Permission fails it too.
// ===========================================================================

import {
  instancePermissionKeys,
  permissionKeys,
  type InstancePermissionKey,
  type PermissionKey,
} from '@station/contracts'
// The `/vocabulary` subpath, matching `vocabulary.ts`. `ActionOf` is a type and
// would be erased either way, but importing it from the same entry the module
// under test uses is what keeps this file from being the one place that quietly
// reintroduces a barrel import.
import type { ActionOf } from '@nestm/permissions-core/vocabulary'
import { describe, expect, it } from 'vitest'

import { stationVocabulary } from './vocabulary.js'

type StationAction = ActionOf<typeof stationVocabulary>

/** Compile-time equality, both directions. Either half failing is a build error. */
type Assert<T extends true> = T
type Equals<A, B> =
  (<G>() => G extends A ? 1 : 2) extends <G>() => G extends B ? 1 : 2
    ? true
    : false

// eslint-disable-next-line @typescript-eslint/no-unused-vars -- type-level assertion
type _ActionsAreExactlyThePermissionCatalog = Assert<
  Equals<StationAction, PermissionKey | InstancePermissionKey>
>

describe('stationVocabulary', () => {
  it('declares exactly the closed Permission catalog as requestable actions', () => {
    expect([...stationVocabulary.actionNames].toSorted()).toEqual(
      [...permissionKeys, ...instancePermissionKeys].toSorted(),
    )
  })

  it('keeps action groups out of the requestable set', () => {
    // Cedar rejects a request naming a group directly, so a group leaking into
    // `actionNames` would be a permanent deny on a real route.
    expect([...stationVocabulary.actionGroupNames].toSorted()).toEqual([
      'gate:*',
      'run:*',
    ])

    for (const group of stationVocabulary.actionGroupNames) {
      expect(stationVocabulary.actionNames).not.toContain(group)
    }
  })

  it('groups only requestable Permissions', () => {
    expect([...stationVocabulary.actionsInGroup('run:*')].toSorted()).toEqual([
      'run:cancel',
      'run:dispatch',
      'run:read',
    ])
    expect([...stationVocabulary.actionsInGroup('gate:*')].toSorted()).toEqual([
      'gate:approve-product',
      'gate:approve-quality',
      'gate:approve-technical',
    ])
  })

  it('namespaces every entity type', () => {
    for (const name of stationVocabulary.entityTypeNames) {
      expect(name.startsWith('Station::')).toBe(true)
    }
  })

  it('qualifies uids the way the policy store and the guard expect', () => {
    expect(stationVocabulary.actionUid('run:dispatch')).toEqual({
      type: 'Station::Action',
      id: 'run:dispatch',
    })
    expect(
      stationVocabulary.entityUid({ type: 'Member', id: 'm1' }),
    ).toEqual({ type: 'Station::Member', id: 'm1' })
  })

  // This is the ONE assertion in the package that needs the Cedar WASM, so it
  // costs ~1 s and a 4.1 MiB load. Keep it here rather than in an integration
  // suite: it is the check that the generated schema is one Cedar accepts at
  // all, and `PermissionsEngine.create()` performs it unconditionally at API
  // boot — a failure here is a boot failure, and it should surface in the
  // package that owns the vocabulary.
  //
  // The `await import(...)` from the MAIN barrel is deliberate and is the only
  // barrel import in `packages/platform`. `validateVocabulary` is not on the
  // `/vocabulary` subpath precisely because asking Cedar is what it does. Kept
  // dynamic so the cost lands in this test's body rather than in the module
  // graph of every file that imports this one — a static top-level barrel
  // import here would put the WASM back into the package's graph and defeat the
  // subpath split that `vocabulary.ts` exists to preserve.
  it('produces a schema Cedar accepts', async () => {
    // `validateVocabulary` is async and returns a discriminated result:
    // `{ ok: true }` or `{ ok: false, errors: DetailedError[] }` — there is no
    // `errors` member on the success arm, so branch rather than index.
    const { validateVocabulary } = await import('@nestm/permissions-core')
    const result = await validateVocabulary(stationVocabulary)

    if (!result.ok) {
      throw new Error(
        `Cedar rejected the Station schema: ${result.errors
          .map((error) => error.message)
          .join('; ')}`,
      )
    }

    expect(result.ok).toBe(true)
  })
})
