// Core's shared `PolicyStore` conformance suite, run twice.
//
// Once against the **default** schema (a `text` scope column that holds `''`),
// and once against a **station-shaped** one: a `uuid` column named
// `organization_id` with `supportsGlobalScope: false`, whose `fromScope` throws
// for the global scope. The second run is not a variation on the first — it takes
// a different branch through `load` (no global union), through `currentVersion`
// (the global half pinned at 0) and through every write (`''` rejected), and it is
// the shape the design's migration target actually has.
//
// The suite is core's, not this package's, so "conformant" means the same thing
// for `MemoryPolicyStore`, `DrizzlePolicyStore` and this store.

import { beforeAll, describe } from "vitest";

import { runPolicyStoreConformanceSuite, typeormStoreFactory } from "../../src/testing.ts";
import { PG_SKIPPED, PG_URL, assertPostgresReachable } from "../fixtures/pg.ts";
import { stationScopeColumn } from "../fixtures/station-scope.ts";

describe.skipIf(PG_SKIPPED)("TypeOrmPolicyStore conformance", () => {
	// One reachability probe for the file; the suite's own cases each provision
	// their tables and would otherwise report the same connection error 25 times.
	beforeAll(async () => {
		await assertPostgresReachable();
	});

	runPolicyStoreConformanceSuite(
		"TypeOrmPolicyStore (default text scope)",
		typeormStoreFactory(PG_URL),
	);

	runPolicyStoreConformanceSuite(
		"TypeOrmPolicyStore (station-shaped uuid scope)",
		typeormStoreFactory(PG_URL, {
			entities: { scopeColumn: stationScopeColumn() as never },
			supportsGlobalScope: false,
		}),
	);
});
