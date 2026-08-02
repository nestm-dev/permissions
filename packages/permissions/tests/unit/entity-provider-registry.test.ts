import "reflect-metadata";
import { Injectable } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { DiscoveryModule } from "@nestjs/core";
import { isPermissionsError, normalizeEntityUid } from "@nestm/permissions-core";
import { beforeEach, describe, expect, it } from "vitest";
import type {
	AnyVocabulary,
	EntityGraph,
	EntityJson,
	EntityResolutionRequest,
} from "@nestm/permissions-core";

import {
	EntityProvider,
	EntityProviderDiscoveryService,
	EntityProviderRegistry,
	assertEntityProviderClass,
	type FeatureEntityProvider,
} from "../../src/index.ts";
import { TEST_SCOPE, testVocabulary } from "../shared/test-vocabulary.ts";

/**
 * The composed provider is typed against `AnyVocabulary`, whose `ActionOf<>` is
 * `never` — the open `VocabularyDef` declares no requestable action. The engine
 * widens the real action id at exactly this boundary (`engine.ts`), so a test
 * calling the provider directly has to do the same.
 */
const request = {
	scope: TEST_SCOPE,
	principal: { type: "Member", id: "member-1" },
	action: "run:read",
	resource: { type: "Run", id: "run-1" },
} as unknown as EntityResolutionRequest<AnyVocabulary>;

function uid(type: string, id: string): EntityJson {
	return { uid: { type: `Test::${type}`, id }, attrs: {}, parents: [] };
}

function label(json: EntityJson): string {
	const normalized = normalizeEntityUid(json.uid);
	return `${normalized.type}::${normalized.id}`;
}

function idOf(json: EntityJson): string {
	return normalizeEntityUid(json.uid).id;
}

@EntityProvider()
@Injectable()
class TenancyProvider implements FeatureEntityProvider {
	resolvePrincipal(): EntityGraph {
		return [uid("Member", "member-1"), uid("Organization", "acme")];
	}

	resolveResource(): EntityGraph {
		return [uid("Organization", "acme")];
	}
}

@EntityProvider({ order: -1 })
@Injectable()
class EarlyProvider implements FeatureEntityProvider {
	resolvePrincipal(): EntityGraph {
		return [uid("Member", "early")];
	}
}

@EntityProvider()
@Injectable()
class ResourceOnlyProvider implements FeatureEntityProvider {
	resolveResource(): EntityGraph {
		return [uid("Run", "run-1")];
	}
}

@EntityProvider()
@Injectable()
class SilentProvider implements FeatureEntityProvider {
	resolvePrincipal(): EntityGraph {
		return [];
	}
}

describe("EntityProviderRegistry composition", () => {
	let registry: EntityProviderRegistry;

	beforeEach(() => {
		registry = new EntityProviderRegistry();
	});

	it("throws ENTITY_RESOLUTION when nothing is registered", async () => {
		await expect(registry.asEntityProvider().resolvePrincipal(request)).rejects.toMatchObject({
			code: "ENTITY_RESOLUTION",
		});
	});

	it("lets the first non-empty principal graph win", async () => {
		registry.register(new SilentProvider(), { name: "SilentProvider" });
		registry.register(new TenancyProvider(), { name: "TenancyProvider" });

		const graph = await registry.asEntityProvider().resolvePrincipal(request);

		expect(graph.map(idOf)).toEqual(["member-1", "acme"]);
	});

	it("orders by `order` first and registration order second", async () => {
		registry.register(new TenancyProvider(), { name: "TenancyProvider", order: 0 });
		registry.register(new EarlyProvider(), { name: "EarlyProvider", order: -1 });

		expect(registry.registrations.map((registration) => registration.name)).toEqual([
			"EarlyProvider",
			"TenancyProvider",
		]);

		const graph = await registry.asEntityProvider().resolvePrincipal(request);
		expect(graph.map(idOf)).toEqual(["early"]);
	});

	it("concatenates and deduplicates resource graphs", async () => {
		registry.register(new TenancyProvider(), { name: "TenancyProvider" });
		registry.register(new ResourceOnlyProvider(), { name: "ResourceOnlyProvider" });
		registry.register(new TenancyProvider(), { name: "TenancyProviderCopy" });

		const graph = await registry.asEntityProvider().resolveResource?.(request);

		expect(graph?.map(label)).toEqual(["Test::Organization::acme", "Test::Run::run-1"]);
	});

	it("ignores a repeated registration of the same instance", () => {
		const provider = new TenancyProvider();
		registry.register(provider, { name: "TenancyProvider" });
		registry.register(provider, { name: "TenancyProvider" });

		expect(registry.size).toBe(1);
	});

	it("clears every registration", () => {
		registry.register(new TenancyProvider(), { name: "TenancyProvider" });
		registry.clear();

		expect(registry.size).toBe(0);
	});
});

describe("discovery", () => {
	it("registers every @EntityProvider() class in the container", async () => {
		const moduleRef = await Test.createTestingModule({
			imports: [DiscoveryModule],
			providers: [
				EntityProviderRegistry,
				EntityProviderDiscoveryService,
				TenancyProvider,
				ResourceOnlyProvider,
			],
		}).compile();
		await moduleRef.init();

		moduleRef.get(EntityProviderDiscoveryService).scan();
		const registry = moduleRef.get(EntityProviderRegistry);

		expect(registry.registrations.map((registration) => registration.name).toSorted()).toEqual([
			"ResourceOnlyProvider",
			"TenancyProvider",
		]);

		await moduleRef.close();
	});

	it("does not register an undecorated provider", async () => {
		@Injectable()
		class PlainProvider {
			resolvePrincipal(): EntityGraph {
				return [];
			}
		}

		const moduleRef = await Test.createTestingModule({
			imports: [DiscoveryModule],
			providers: [EntityProviderRegistry, EntityProviderDiscoveryService, PlainProvider],
		}).compile();
		await moduleRef.init();

		moduleRef.get(EntityProviderDiscoveryService).scan();

		expect(moduleRef.get(EntityProviderRegistry).size).toBe(0);
		await moduleRef.close();
	});
});

describe("assertEntityProviderClass", () => {
	it("accepts a decorated class implementing a resolver method", () => {
		expect(() => {
			assertEntityProviderClass(TenancyProvider);
		}).not.toThrow();
	});

	it("rejects a non-class", () => {
		expect(() => {
			assertEntityProviderClass({ resolvePrincipal: () => [] } as never);
		}).toThrowError(/is not a class/);
	});

	it("rejects an undecorated class", () => {
		class Undecorated {
			resolvePrincipal(): EntityGraph {
				return [];
			}
		}

		expect(() => {
			assertEntityProviderClass(Undecorated);
		}).toThrowError(/not decorated with @EntityProvider/);
	});

	it("rejects a decorated class implementing no resolver method", () => {
		@EntityProvider()
		class Empty {}

		expect(() => {
			assertEntityProviderClass(Empty);
		}).toThrowError(/implements none of/);
	});
});

describe("resolveRouteEntities", () => {
	/**
	 * A provider written the way an application writes one: typed against **its
	 * own** vocabulary, not `AnyVocabulary`.
	 *
	 * This is the shape that broke the registry the moment `PermissionsTypeRegistry`
	 * was augmented — `FeatureEntityProvider` defaults to the *registered*
	 * vocabulary, so the registry's internals have to stay `AnyVocabulary` and rely
	 * on TypeScript's bivariant method parameters. The assertion that matters here
	 * is that this file compiles.
	 */
	@EntityProvider()
	@Injectable()
	class TypedProvider implements FeatureEntityProvider<typeof testVocabulary> {
		resolveResource({ resource }: EntityResolutionRequest<typeof testVocabulary>): EntityGraph {
			return resource === undefined ? [] : [uid(resource.type, resource.id)];
		}

		resolveAdditional(): EntityGraph {
			return [uid("Organization", "acme")];
		}
	}

	it("concatenates resource and additional contributions, deduplicated", async () => {
		const registry = new EntityProviderRegistry();
		registry.register(new TypedProvider(), { name: "TypedProvider" });

		const graph = await registry.resolveRouteEntities({
			scope: TEST_SCOPE,
			principal: { type: "Member", id: "member-1" },
			action: "run:read",
			resource: { type: "Run", id: "run-1" },
		});

		expect(graph.map(label)).toEqual(["Test::Run::run-1", "Test::Organization::acme"]);
	});

	it("answers [] with nothing registered, rather than failing", async () => {
		// Unlike the principal path, which must throw: the guard always passes
		// `entities` explicitly, so "no contributions" is a legitimate answer.
		const registry = new EntityProviderRegistry();

		await expect(
			registry.resolveRouteEntities({
				scope: TEST_SCOPE,
				principal: { type: "Member", id: "member-1" },
				action: "run:read",
			}),
		).resolves.toEqual([]);
	});

	it("passes the planned resource type to providers without inventing an instance", async () => {
		let seen: EntityResolutionRequest<typeof testVocabulary> | undefined;
		const provider: FeatureEntityProvider<typeof testVocabulary> = {
			resolveAdditional(request): EntityGraph {
				seen = request;
				return [];
			},
		};
		const registry = new EntityProviderRegistry();
		registry.register(provider, { name: "PlanningProvider" });

		await registry.resolveRouteEntities({
			scope: TEST_SCOPE,
			principal: { type: "Member", id: "member-1" },
			action: "run:read",
			resourceType: "Run",
		});

		expect(seen).toMatchObject({ resourceType: "Run" });
		expect(seen).not.toHaveProperty("resource");
	});

	it("wraps provider failures as structural ENTITY_RESOLUTION errors", async () => {
		const registry = new EntityProviderRegistry();
		registry.register(
			{
				resolveResource: async () => {
					throw new Error("database is offline");
				},
			},
			{ name: "BrokenProvider" },
		);

		const failure = await registry
			.resolveRouteEntities({
				scope: TEST_SCOPE,
				principal: { type: "Member", id: "member-1" },
				action: "run:read",
				resource: { type: "Run", id: "run-1" },
			})
			.catch((error: unknown) => error);

		expect(isPermissionsError(failure)).toBe(true);
		expect(failure).toMatchObject({
			code: "ENTITY_RESOLUTION",
			scope: TEST_SCOPE,
			message: expect.stringContaining("BrokenProvider") as unknown,
		});
	});
});
