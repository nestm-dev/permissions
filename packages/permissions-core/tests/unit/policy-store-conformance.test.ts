import { describe, expect, it } from "vitest";

import { MemoryPolicyStore } from "../../src/policy/memory-policy-store.ts";
import { readOnlyPolicyStore } from "../../src/policy/read-only-policy-store.ts";
import { runPolicyStoreConformanceSuite } from "../../src/testing/policy-store-conformance.ts";

/**
 * The shared `PolicyStore` conformance suite, run against `MemoryPolicyStore`.
 *
 * This is the suite's own conformance proof: `MemoryPolicyStore` is the SPI's
 * reference implementation, so a case that the reference cannot pass is a bug in
 * the case rather than a contract the ORM stores should be held to. Phase 5's
 * TypeORM and Drizzle stores import the same function from
 * `@nestm/permissions-core/testing`, so "conformant" means one thing across all
 * three implementations instead of three.
 *
 * The hooks are passed explicitly rather than relying on `globals: true`, because
 * that is how the driver packages will call it — a suite that only works under
 * ambient globals would be a surprise the first time a driver used a different
 * runner configuration.
 */
runPolicyStoreConformanceSuite(
	"MemoryPolicyStore",
	async () => ({ store: new MemoryPolicyStore() }),
	{ describe, it, expect },
);

/**
 * The other half of the seam: the suite must also work with no hooks argument,
 * picking `describe`/`it`/`expect` off the global object. `vitest.config.ts` sets
 * `globals: true`, so this registers a second, ambient-hooked copy of the suite.
 */
runPolicyStoreConformanceSuite("MemoryPolicyStore (ambient hooks)", async () => ({
	store: new MemoryPolicyStore(),
}));

/**
 * The read-only shape, run through the same suite.
 *
 * `readOnly: true` skips every group that seeds its fixture through the write SPI
 * — which is all of them — and runs the read-only contract instead: `load` is
 * well-shaped, `currentVersion` agrees with it, and all four write methods
 * reject. Running it against `readOnlyPolicyStore(new MemoryPolicyStore())` is
 * the adapter's own conformance proof, and pins that the flag really does gate
 * the write cases rather than leaving them to fail.
 */
runPolicyStoreConformanceSuite(
	"readOnlyPolicyStore(MemoryPolicyStore)",
	async () => ({
		store: readOnlyPolicyStore(new MemoryPolicyStore(), { name: "MemoryPolicyStore (frozen)" }),
		readOnly: true,
		// The adapter forwards no `watch` because `MemoryPolicyStore`'s is only
		// meaningful for writes it will now refuse.
		supportsWatch: false,
	}),
	{ describe, it, expect },
);
