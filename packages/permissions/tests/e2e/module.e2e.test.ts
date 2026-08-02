import "reflect-metadata";
import { Controller, Get, Injectable, Module } from "@nestjs/common";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryPolicyStore } from "@nestm/permissions-core";
import type { DynamicModule, INestApplication } from "@nestjs/common";
import type {
	EntityGraph,
	PolicyBundle,
	PolicyScopeId,
	PolicyStore,
} from "@nestm/permissions-core";

import {
	AUTHORIZATION_ENGINE,
	EntityProvider,
	EntityProviderRegistry,
	PermissionsModule,
	PermissionsService,
	POLICY_STORE,
	PolicySetManager,
	Public,
	type AuthorizationEngine,
	type FeatureEntityProvider,
	type PermissionsCheckRequest,
	type PolicyStoreDefinition,
} from "../../src/index.ts";
import { createTestApp } from "../shared/test-app.ts";
import { testHttpAdapter } from "../shared/http-adapter.ts";
import {
	IDS,
	SEED_POLICIES,
	TEST_SCOPE,
	memberGraph,
	runGraph,
	testVocabulary,
} from "../shared/test-vocabulary.ts";

@Controller("guarded")
class GuardedController {
	@Get("open")
	@Public()
	open(): { ok: true } {
		return { ok: true };
	}

	@Get("closed")
	closed(): { ok: true } {
		return { ok: true };
	}
}

@EntityProvider()
@Injectable()
class TestEntityProvider implements FeatureEntityProvider {
	resolvePrincipal(): EntityGraph {
		return memberGraph(IDS.member, "admin");
	}

	resolveResource(): EntityGraph {
		return runGraph();
	}
}

@Module({
	imports: [PermissionsModule.forFeature({ entityProviders: [TestEntityProvider] })],
})
class FeatureModule {}

class DelayedSiblingStore extends MemoryPolicyStore {}

@Module({})
class DelayedSiblingStoreModule {
	static register(): DynamicModule {
		return {
			module: DelayedSiblingStoreModule,
			global: true,
			providers: [
				{
					provide: DelayedSiblingStore,
					useFactory: async (): Promise<DelayedSiblingStore> => {
						// Nest instantiates sibling-module providers concurrently. The delay
						// makes the old `ModuleRef.get()` race deterministic: the wrapper is
						// registered, but its instance is still null.
						await new Promise<void>((resolve) => setTimeout(resolve, 10));
						return new DelayedSiblingStore();
					},
				},
			],
			exports: [DelayedSiblingStore],
		};
	}
}

/** A store whose every operation fails — the boot-time outage case. */
class BrokenStore implements PolicyStore {
	async load(scope: PolicyScopeId): Promise<PolicyBundle> {
		throw new Error(`store offline (load ${scope})`);
	}

	async currentVersion(scope: PolicyScopeId): Promise<string> {
		throw new Error(`store offline (currentVersion ${scope})`);
	}

	async save(): Promise<void> {
		throw new Error("store offline");
	}

	async delete(): Promise<void> {
		throw new Error("store offline");
	}

	async linkTemplate(): Promise<void> {
		throw new Error("store offline");
	}

	async unlinkTemplate(): Promise<void> {
		throw new Error("store offline");
	}
}

const readRun = {
	scope: TEST_SCOPE,
	principal: { type: "Member", id: IDS.member },
	action: "run:read",
	resource: { type: "Run", id: IDS.run },
} as PermissionsCheckRequest;

const dispatchRun = {
	...readRun,
	action: "run:dispatch",
} as PermissionsCheckRequest;

let app: INestApplication | undefined;

afterEach(async () => {
	await app?.close();
	app = undefined;
});

describe(`PermissionsModule (${testHttpAdapter})`, () => {
	it("boots from a vocabulary and a seeded store, and exposes the engine", async () => {
		app = await createTestApp({
			forRoot: { vocabulary: testVocabulary, policies: SEED_POLICIES },
		});

		const engine = app.get<AuthorizationEngine>(AUTHORIZATION_ENGINE);

		expect(engine.disposed).toBe(false);
		expect(engine.vocabulary.namespace).toBe("Test");
		expect(engine.instanceId).toMatch(/^perm-/);
	});

	it("decides allow and deny end-to-end through PermissionsService", async () => {
		app = await createTestApp({
			forRoot: { vocabulary: testVocabulary, policies: SEED_POLICIES },
		});
		const permissions = app.get(PermissionsService);
		const entities = [...memberGraph(IDS.member, "member"), ...runGraph()];

		const allowed = await permissions.check({ ...readRun, entities });
		const denied = await permissions.check({ ...dispatchRun, entities });

		expect(allowed.allowed).toBe(true);
		expect(allowed.determiningPolicyIds).toEqual(["members-may-read-runs"]);
		expect(denied.allowed).toBe(false);
		expect(denied.determiningPolicyIds).toEqual([]);
	});

	it("throws ForbiddenException from checkOrThrow on a deny", async () => {
		app = await createTestApp({
			forRoot: { vocabulary: testVocabulary, policies: SEED_POLICIES },
		});
		const permissions = app.get(PermissionsService);
		const entities = [...memberGraph(IDS.member, "member"), ...runGraph()];

		await expect(permissions.checkOrThrow({ ...dispatchRun, entities })).rejects.toMatchObject({
			status: 403,
		});
		await expect(permissions.checkOrThrow({ ...readRun, entities })).resolves.toMatchObject({
			allowed: true,
		});
	});

	it("shares one batch across checkMany", async () => {
		app = await createTestApp({
			forRoot: { vocabulary: testVocabulary, policies: SEED_POLICIES },
		});
		const permissions = app.get(PermissionsService);
		const entities = [...memberGraph(IDS.member, "admin"), ...runGraph()];

		const results = await permissions.checkMany([
			{ ...readRun, entities },
			{ ...dispatchRun, entities },
		]);

		expect(results.map((result) => result.allowed)).toEqual([true, true]);
		expect(permissions.stats().checks).toBe(2);
	});

	it("serves a @Public() route and refuses an undeclared one", async () => {
		app = await createTestApp({
			forRoot: { vocabulary: testVocabulary, policies: SEED_POLICIES },
			metadata: { controllers: [GuardedController] },
		});

		await request(app.getHttpServer()).get("/guarded/open").expect(200, { ok: true });
		await request(app.getHttpServer()).get("/guarded/closed").expect(403);
	});

	it("leaves every route reachable with disableGlobalGuard", async () => {
		app = await createTestApp({
			forRoot: {
				vocabulary: testVocabulary,
				policies: SEED_POLICIES,
				disableGlobalGuard: true,
			},
			metadata: { controllers: [GuardedController] },
		});

		await request(app.getHttpServer()).get("/guarded/closed").expect(200, { ok: true });
	});

	it("boots through forRootAsync with a useFactory", async () => {
		const { Test } = await import("@nestjs/testing");
		const { createTestHttpAdapter, initTestApplication } =
			await import("../shared/http-adapter.ts");

		const moduleRef = await Test.createTestingModule({
			imports: [
				PermissionsModule.forRootAsync({
					useFactory: () => ({ vocabulary: testVocabulary, policies: SEED_POLICIES }),
				}),
			],
			controllers: [GuardedController],
		}).compile();

		app = moduleRef.createNestApplication(createTestHttpAdapter());
		app.enableShutdownHooks();
		await initTestApplication(app);

		await request(app.getHttpServer()).get("/guarded/open").expect(200, { ok: true });
		await expect(
			app.get(PermissionsService).check({
				...readRun,
				entities: [...memberGraph(IDS.member, "member"), ...runGraph()],
			}),
		).resolves.toMatchObject({ allowed: true });
	});

	it("awaits a delayed sibling store configured with useExisting", async () => {
		const { Test } = await import("@nestjs/testing");
		const moduleRef = await Test.createTestingModule({
			imports: [
				DelayedSiblingStoreModule.register(),
				PermissionsModule.forRoot({
					vocabulary: testVocabulary,
					store: { useExisting: DelayedSiblingStore },
					disableGlobalGuard: true,
				}),
			],
		}).compile();

		try {
			expect(moduleRef.get(POLICY_STORE)).toBeInstanceOf(DelayedSiblingStore);
		} finally {
			await moduleRef.close();
		}
	});

	it("awaits delayed dependencies injected into a store useFactory", async () => {
		const { Test } = await import("@nestjs/testing");
		const store: PolicyStoreDefinition = {
			useFactory: (dependency: DelayedSiblingStore) => dependency,
			inject: [DelayedSiblingStore],
		};
		const moduleRef = await Test.createTestingModule({
			imports: [
				DelayedSiblingStoreModule.register(),
				PermissionsModule.forRoot({
					vocabulary: testVocabulary,
					store,
					disableGlobalGuard: true,
				}),
			],
		}).compile();

		try {
			expect(moduleRef.get(POLICY_STORE)).toBeInstanceOf(DelayedSiblingStore);
		} finally {
			await moduleRef.close();
		}
	});

	it("discovers a forFeature entity provider and decides without explicit entities", async () => {
		app = await createTestApp({
			forRoot: { vocabulary: testVocabulary, policies: SEED_POLICIES },
			metadata: { imports: [FeatureModule] },
		});

		expect(app.get(EntityProviderRegistry).size).toBe(1);

		const permissions = app.get(PermissionsService);

		// The graph comes entirely from TestEntityProvider — which grants the
		// "admin" role, so the dispatch policy's condition holds too.
		await expect(permissions.check(readRun)).resolves.toMatchObject({ allowed: true });
		await expect(permissions.check(dispatchRun)).resolves.toMatchObject({ allowed: true });
	});

	it("fails ENTITY_RESOLUTION rather than deciding on an empty graph", async () => {
		app = await createTestApp({
			forRoot: { vocabulary: testVocabulary, policies: SEED_POLICIES },
		});

		await expect(app.get(PermissionsService).check(readRun)).rejects.toMatchObject({
			code: "ENTITY_RESOLUTION",
		});
	});

	it("warms the scopes listed in warmScopes", async () => {
		app = await createTestApp({
			forRoot: {
				vocabulary: testVocabulary,
				policies: SEED_POLICIES,
				warmScopes: [TEST_SCOPE],
			},
		});

		const stats = app.get(PermissionsService).stats();

		expect(stats.policySets.loads).toBeGreaterThanOrEqual(1);
		expect(stats.policySets.scopes).toBe(1);
		expect(stats.checks).toBe(0);
	});

	it("boots despite a store outage during warm, and stays ready", async () => {
		// The warn this produces goes through Nest's own Logger (process.stdout), so
		// it is left visible rather than mocked — seeing it in the run is the point.
		app = await createTestApp({
			forRoot: {
				vocabulary: testVocabulary,
				store: new BrokenStore(),
				warmScopes: [TEST_SCOPE],
			},
		});

		// Warm failure is logged, not fatal: the engine is up and `assertReady`
		// passes, because a store outage is not an engine outage.
		expect(() => {
			app?.get(PolicySetManager).assertReady();
		}).not.toThrow();
		expect(app.get(PermissionsService).stats().policySets.failures).toBeGreaterThanOrEqual(1);

		// The check itself still fails — loudly, from the store.
		await expect(
			app.get(PermissionsService).check({
				...readRun,
				entities: [...memberGraph(IDS.member, "member"), ...runGraph()],
			}),
		).rejects.toThrowError(/store offline/);
	});

	it("disposes the engine on shutdown and refuses later checks with 503", async () => {
		const first = await createTestApp({
			forRoot: { vocabulary: testVocabulary, policies: SEED_POLICIES },
		});
		const engine = first.get<AuthorizationEngine>(AUTHORIZATION_ENGINE);
		const permissions = first.get(PermissionsService);

		await first.close();

		expect(engine.disposed).toBe(true);
		await expect(
			permissions.check({
				...readRun,
				entities: [...memberGraph(IDS.member, "member"), ...runGraph()],
			}),
		).rejects.toMatchObject({ status: 503 });
	});

	it("boots a second app after the first closed, with no duplicate-copy warning", async () => {
		const error = vi.spyOn(globalThis.console, "error").mockImplementation(() => undefined);

		const first = await createTestApp({
			forRoot: {
				vocabulary: testVocabulary,
				policies: SEED_POLICIES,
				engine: { instanceId: "e2e-fixed-instance" },
			},
		});
		await first.close();

		// The same explicit instanceId is reusable precisely because shutdown
		// released the claim.
		app = await createTestApp({
			forRoot: {
				vocabulary: testVocabulary,
				policies: SEED_POLICIES,
				engine: { instanceId: "e2e-fixed-instance" },
			},
		});

		await expect(
			app.get(PermissionsService).check({
				...readRun,
				entities: [...memberGraph(IDS.member, "member"), ...runGraph()],
			}),
		).resolves.toMatchObject({ allowed: true });

		expect(
			error.mock.calls.filter(([message]) => String(message).includes("More than one copy")),
		).toHaveLength(0);

		error.mockRestore();
	});

	it("refuses two live engines sharing an explicit instanceId", async () => {
		app = await createTestApp({
			forRoot: {
				vocabulary: testVocabulary,
				policies: SEED_POLICIES,
				engine: { instanceId: "e2e-duplicate" },
			},
		});

		await expect(
			createTestApp({
				forRoot: {
					vocabulary: testVocabulary,
					policies: SEED_POLICIES,
					engine: { instanceId: "e2e-duplicate" },
				},
			}),
		).rejects.toThrowError(/already in use/);
	});
});
