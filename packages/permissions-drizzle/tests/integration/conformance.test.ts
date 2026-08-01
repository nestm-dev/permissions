// Core's shared `PolicyStore` conformance suite, twice.
//
// Twice because the two shapes exercise genuinely different code paths, not
// different formatting:
//
//   * the **default** schema — `text('scope')`, identity codec, global scope
//     supported — runs every group, including the `global ∪ scope` union, the
//     id-collision throw and the `{ scope: '*' }` broadcast (D2);
//   * the **station-shaped** schema — `uuid NOT NULL`, a non-identity codec,
//     `supportsGlobalScope: false` — makes the store reject writes to `''` and
//     skip the global half of the union entirely. The suite announces those
//     groups as skipped rather than quietly not running them, which is the only
//     way "we do not support this" stays visible in the output.

import { beforeAll, describe } from "vitest";

import { drizzleStoreFactory, runPolicyStoreConformanceSuite } from "../../src/testing.ts";
import { PG_SKIPPED, PG_URL, assertPostgresReachable } from "../fixtures/pg.ts";
import { stationScopeColumn } from "../fixtures/station-scope.ts";

describe.skipIf(PG_SKIPPED)("DrizzlePolicyStore conformance", () => {
	beforeAll(assertPostgresReachable);

	runPolicyStoreConformanceSuite(
		"DrizzlePolicyStore (default text scope column)",
		drizzleStoreFactory(PG_URL),
	);

	runPolicyStoreConformanceSuite(
		"DrizzlePolicyStore (station-shaped uuid scope column, no global scope)",
		drizzleStoreFactory(PG_URL, {
			schema: { scopeColumn: stationScopeColumn() } as never,
		}),
	);
});
