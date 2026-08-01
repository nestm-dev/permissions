// `PermissionsService.invalidate(scope)` — one tenant's cache, not everyone's.
//
// The gap this closes: a grant-write flow has to tell the engine that a scope
// changed. A store that implements `watch` emits that event itself; a store that
// does not — a projection of the application's own tables, a composite over a
// read-only source, the built-in seeded memory store — leaves the code that wrote
// the grant holding the only knowledge that anything changed. `reload()` was the
// only way to say so, and it invalidates **every** scope: publishing one tenant's
// grant made every other tenant pay a cold load, which on a busy instance is a
// thundering herd against the policy store.
//
// Every assertion here is against `stats().policySets.loads` — the count of
// `store.load` calls — because "did this scope reload" is not otherwise
// observable from outside, and asserting on a decision changing would prove the
// invalidation happened without proving it was *scoped*.

import "reflect-metadata";
import { Controller, Get, Injectable, Module } from "@nestjs/common";
import { MemoryPolicyStore, policyRecordFromText, loadCedar } from "@nestm/permissions-core";
import request from "supertest";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { INestApplication } from "@nestjs/common";
import type { CedarBinding, EntityGraph, PolicyRecord, PolicyStore } from "@nestm/permissions-core";

import {
	EntityProvider,
	PermissionsService,
	RequirePermission,
	type FeatureEntityProvider,
} from "../../src/index.ts";
import { testHttpAdapter } from "../shared/http-adapter.ts";
import { createTestApp } from "../shared/test-app.ts";
import { HeaderPrincipalResolver, ROLE_HEADER, USER_HEADER } from "../shared/test-principal.ts";
import { IDS, runGraph, testVocabulary } from "../shared/test-vocabulary.ts";

const TENANT_A = "org:a";
const TENANT_B = "org:b";

@EntityProvider()
@Injectable()
class RunEntityProvider implements FeatureEntityProvider {
	resolveResource(): EntityGraph {
		return runGraph();
	}
}

@Module({ providers: [RunEntityProvider], exports: [RunEntityProvider] })
class RunModule {}

@Controller("t")
class TenantController {
	@Get(":org/dispatch")
	@RequirePermission(
		"run:dispatch",
		{ kind: "literal", type: "Run", id: IDS.run },
		{ scopeFrom: { kind: "param", param: "org", prefix: "org:" }, onDeny: "forbidden" },
	)
	dispatch(): { ok: true } {
		return { ok: true };
	}
}

let cedar: CedarBinding;

beforeAll(async () => {
	cedar = await loadCedar();
});

let app: INestApplication | undefined;

afterEach(async () => {
	await app?.close();
	app = undefined;
});

/** `permit` for `run:dispatch` in one scope. */
function dispatchPolicy(scope: string): PolicyRecord {
	return policyRecordFromText(cedar, {
		id: "dispatch",
		scope,
		text: `permit(
			principal in Test::Organization::"${IDS.organization}",
			action == Test::Action::"run:dispatch",
			resource
		);`,
		updatedAt: new Date("2026-07-31T00:00:00.000Z"),
	});
}

/**
 * A `MemoryPolicyStore` with `watch` removed.
 *
 * Not a contrivance — it is the shape of every externally-managed store, and the
 * exact shape that makes `invalidate` necessary. With `watch` present the engine
 * is event-driven (D1) and would reload on its own, which would make this suite
 * pass for the wrong reason.
 *
 * Written as a delegating object rather than a subclass because `watch` is
 * *optional* on `PolicyStore` and required on `MemoryPolicyStore`, so a subclass
 * cannot drop it without lying about its own base type.
 */
function unwatched(store: MemoryPolicyStore): PolicyStore {
	return {
		load: (scope) => store.load(scope),
		currentVersion: (scope) => store.currentVersion(scope),
		save: (policies) => store.save(policies),
		delete: (scope, ids) => store.delete(scope, ids),
		linkTemplate: (link) => store.linkTemplate(link),
		unlinkTemplate: (scope, linkId) => store.unlinkTemplate(scope, linkId),
	};
}

interface Harness {
	readonly app: INestApplication;
	readonly store: PolicyStore;
	readonly permissions: PermissionsService;
	loads(): number;
}

async function createHarness(): Promise<Harness> {
	const store = unwatched(new MemoryPolicyStore());
	await store.save([dispatchPolicy(TENANT_A), dispatchPolicy(TENANT_B)]);

	const created = await createTestApp({
		forRoot: {
			vocabulary: testVocabulary,
			store,
			principalResolver: new HeaderPrincipalResolver(),
			// A long staleness window, so nothing reloads on a timer and every reload
			// this suite observes is one it asked for.
			engine: { policySetCache: { staleAfterMs: 600_000 } },
		},
		metadata: { imports: [RunModule], controllers: [TenantController] },
	});
	app = created;

	const permissions = created.get(PermissionsService);
	return {
		app: created,
		store,
		permissions,
		loads: () => permissions.stats().policySets.loads,
	};
}

/** One guarded request against `scope`, expecting `status`. */
async function hit(harness: Harness, tenant: string, status: number): Promise<void> {
	await request(harness.app.getHttpServer())
		.get(`/t/${tenant}/dispatch`)
		.set(USER_HEADER, IDS.member)
		.set(ROLE_HEADER, "admin")
		.expect(status);
}

describe(`invalidate(scope) (${testHttpAdapter})`, () => {
	it("reloads only the named scope", async () => {
		const harness = await createHarness();

		// Warm both tenants: two loads.
		await hit(harness, "a", 200);
		await hit(harness, "b", 200);
		const warmed = harness.loads();
		expect(warmed).toBe(2);

		// Cached: no further loads.
		await hit(harness, "a", 200);
		await hit(harness, "b", 200);
		expect(harness.loads()).toBe(warmed);

		// Write to A, and tell the engine about A only.
		await harness.store.delete(TENANT_A, ["dispatch"]);
		await harness.permissions.invalidate(TENANT_A);

		// A reloads and now denies...
		await hit(harness, "a", 403);
		expect(harness.loads()).toBe(warmed + 1);

		// ...and B did not reload. This is the assertion the whole feature is for:
		// `reload()` here would have made this `warmed + 2` and every other tenant
		// pay a cold load for a write that had nothing to do with them.
		await hit(harness, "b", 200);
		expect(harness.loads()).toBe(warmed + 1);
	});

	it("write → invalidate → next check sees the new policies", async () => {
		const harness = await createHarness();

		await hit(harness, "a", 200);
		await harness.store.delete(TENANT_A, ["dispatch"]);

		// Without the invalidation the cache still answers from the old bundle —
		// which is the correct behaviour for an unwatched store, and the reason the
		// writer has to say something.
		await hit(harness, "a", 200);

		await harness.permissions.invalidate(TENANT_A);
		await hit(harness, "a", 403);
	});

	it("'*' is reload(): every scope reloads", async () => {
		const harness = await createHarness();

		await hit(harness, "a", 200);
		await hit(harness, "b", 200);
		const warmed = harness.loads();

		await harness.permissions.invalidate("*");

		await hit(harness, "a", 200);
		await hit(harness, "b", 200);
		expect(harness.loads()).toBe(warmed + 2);
	});

	it("reload() is still exactly invalidate('*')", async () => {
		const harness = await createHarness();

		await hit(harness, "a", 200);
		await hit(harness, "b", 200);
		const warmed = harness.loads();

		await harness.permissions.reload();

		await hit(harness, "a", 200);
		await hit(harness, "b", 200);
		expect(harness.loads()).toBe(warmed + 2);
	});

	it("invalidating an unknown scope is a no-op, not an error", async () => {
		// A grant-write flow should not have to know whether the scope it just wrote
		// has ever been loaded on this replica.
		const harness = await createHarness();

		await hit(harness, "a", 200);
		const warmed = harness.loads();

		await expect(harness.permissions.invalidate("org:never-seen")).resolves.toBeUndefined();
		expect(harness.loads()).toBe(warmed);

		await hit(harness, "a", 200);
		expect(harness.loads()).toBe(warmed);
	});

	it("refuses to run against a disposed engine — 503, never a silent success", async () => {
		const harness = await createHarness();
		await hit(harness, "a", 200);

		await harness.app.close();
		app = undefined;

		// `assertReady()` is what `reload()` already promised; the per-scope form
		// must not be the one method that quietly does nothing after shutdown.
		await expect(harness.permissions.invalidate(TENANT_A)).rejects.toMatchObject({
			status: 503,
		});
	});
});
