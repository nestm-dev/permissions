import "reflect-metadata";
import { Injectable } from "@nestjs/common";
import { MemoryPolicyStore } from "@nestm/permissions-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ModuleRef } from "@nestjs/core";
import type { PolicyStore } from "@nestm/permissions-core";

import {
	createSeededMemoryStore,
	resolvePolicyStore,
} from "../../src/providers/policy-store.provider.ts";
import type { PermissionsModuleOptions } from "../../src/index.ts";
import { IDS, SEED_POLICIES, TEST_SCOPE, testVocabulary } from "../shared/test-vocabulary.ts";

@Injectable()
class CustomStore extends MemoryPolicyStore {}

interface ModuleRefDouble {
	readonly ref: ModuleRef;
	readonly get: ReturnType<typeof vi.fn>;
	readonly resolve: ReturnType<typeof vi.fn>;
	readonly create: ReturnType<typeof vi.fn>;
}

/** A `ModuleRef` double proving only the `useClass` arm reaches the container. */
function moduleRefDouble(): ModuleRefDouble {
	const get = vi.fn();
	const resolve = vi.fn();
	const create = vi.fn(async (type: new () => unknown) => new type());
	return { ref: { get, resolve, create } as unknown as ModuleRef, get, resolve, create };
}

const base: PermissionsModuleOptions = { vocabulary: testVocabulary };

describe("policy store definition matrix", () => {
	let double: ModuleRefDouble;
	let moduleRef: ModuleRef;

	beforeEach(() => {
		double = moduleRefDouble();
		moduleRef = double.ref;
	});

	it("defaults to a seeded in-memory store", async () => {
		const store = await resolvePolicyStore(base, moduleRef);

		expect(store).toBeInstanceOf(MemoryPolicyStore);
	});

	it("passes a ready instance through untouched", async () => {
		const instance = new MemoryPolicyStore();
		const store = await resolvePolicyStore({ ...base, store: instance }, moduleRef);

		expect(store).toBe(instance);
	});

	it("instantiates { useClass } through ModuleRef.create", async () => {
		const store = await resolvePolicyStore(
			{ ...base, store: { useClass: CustomStore } },
			moduleRef,
		);

		expect(store).toBeInstanceOf(CustomStore);
		expect(double.create).toHaveBeenCalledWith(CustomStore);
	});

	it("resolves { useExisting } from the statically injected dependency map", async () => {
		const existing = new MemoryPolicyStore();
		const token = Symbol("EXISTING_STORE");
		const dependencies = new Map([[token, existing]]);

		const store = await resolvePolicyStore(
			{ ...base, store: { useExisting: token } },
			moduleRef,
			dependencies,
		);

		expect(store).toBe(existing);
		expect(double.get).not.toHaveBeenCalled();
		expect(double.resolve).not.toHaveBeenCalled();
	});

	it("rejects { useExisting } without a static provider dependency", async () => {
		const token = Symbol("UNWIRED_STORE");

		await expect(
			resolvePolicyStore({ ...base, store: { useExisting: token } }, moduleRef),
		).rejects.toThrowError(/forRoot\(\{ imports/);
	});

	it("calls { useFactory } with its injected dependencies", async () => {
		const injected = new MemoryPolicyStore();
		const token = Symbol("DEP");
		const useFactory = vi.fn((dependency: MemoryPolicyStore) => dependency);
		const dependencies = new Map([[token, injected]]);

		const store = await resolvePolicyStore(
			{ ...base, store: { useFactory, inject: [token] } },
			moduleRef,
			dependencies,
		);

		expect(store).toBe(injected);
		expect(useFactory).toHaveBeenCalledWith(injected);
		expect(double.get).not.toHaveBeenCalled();
		expect(double.resolve).not.toHaveBeenCalled();
	});

	it("preserves useFactory injection order through the dependency map", async () => {
		const first = Symbol("FIRST_DEP");
		const second = Symbol("SECOND_DEP");
		const firstDependency = { name: "first" };
		const secondDependency = { name: "second" };
		const dependencies = new Map<symbol, unknown>([
			[first, firstDependency],
			[second, secondDependency],
		]);
		const useFactory = vi.fn((left: typeof firstDependency, right: typeof secondDependency) => {
			void left;
			void right;
			return new MemoryPolicyStore();
		});

		const store = await resolvePolicyStore(
			{ ...base, store: { useFactory: useFactory as never, inject: [first, second] } },
			moduleRef,
			dependencies,
		);

		expect(store).toBeInstanceOf(MemoryPolicyStore);
		expect(useFactory).toHaveBeenCalledWith(firstDependency, secondDependency);
	});

	it("rejects a factory that resolves to nothing", async () => {
		await expect(
			resolvePolicyStore({ ...base, store: { useFactory: (() => undefined) as never } }, moduleRef),
		).rejects.toThrowError(/useFactory` resolved to undefined/);
	});
});

describe("seeded in-memory store", () => {
	it("parses text seeds through Cedar", async () => {
		const store = await createSeededMemoryStore({ ...base, policies: SEED_POLICIES });
		const bundle = await store.load(TEST_SCOPE);

		expect(bundle.policies.map((policy) => policy.id).toSorted()).toEqual([
			"admins-may-dispatch-runs",
			"members-may-read-runs",
		]);
		for (const policy of bundle.policies) {
			expect(policy.kind).toBe("static");
			expect(policy.cedarJson).toHaveProperty("effect", "permit");
		}
	});

	it("takes cedarJson seeds verbatim", async () => {
		const store = await createSeededMemoryStore({
			...base,
			policies: [
				{
					id: "permit-all",
					scope: TEST_SCOPE,
					cedarJson: {
						effect: "permit",
						principal: { op: "All" },
						action: { op: "All" },
						resource: { op: "All" },
						conditions: [],
					},
				},
			],
		});

		const bundle = await store.load(TEST_SCOPE);
		expect(bundle.policies).toHaveLength(1);
		expect(bundle.policies[0]?.cedarJson).toMatchObject({ effect: "permit" });
	});

	it("seeds template links alongside their template", async () => {
		const store = await createSeededMemoryStore({
			...base,
			policies: [
				{
					id: "role-template",
					scope: TEST_SCOPE,
					text: `permit(principal == ?principal, action == Test::Action::"run:read", resource);`,
				},
			],
			links: [
				{
					id: "grant-1",
					scope: TEST_SCOPE,
					templateId: "role-template",
					values: { "?principal": { type: "Member", id: IDS.member } },
				},
			],
		});

		const bundle = await store.load(TEST_SCOPE);
		expect(bundle.policies[0]?.kind).toBe("template");
		expect(bundle.links).toHaveLength(1);
		expect(bundle.links[0]).toMatchObject({ id: "grant-1", templateId: "role-template" });
	});

	it("never loads Cedar for a JSON-only seed set", async () => {
		const store: PolicyStore = await createSeededMemoryStore({ ...base, policies: [] });

		expect(store).toBeInstanceOf(MemoryPolicyStore);
	});
});
