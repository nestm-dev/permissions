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

/** A `ModuleRef` double exposing the three resolution paths used by the module. */
function moduleRefDouble(existing?: unknown, asynchronouslyResolved?: unknown): ModuleRefDouble {
	const get = vi.fn(() => existing);
	const resolve = vi.fn(async () => asynchronouslyResolved);
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

	it("resolves { useExisting } non-strictly", async () => {
		const existing = new MemoryPolicyStore();
		const token = Symbol("EXISTING_STORE");
		const withExisting = moduleRefDouble(existing);

		const store = await resolvePolicyStore(
			{ ...base, store: { useExisting: token } },
			withExisting.ref,
		);

		expect(store).toBe(existing);
		expect(withExisting.get).toHaveBeenCalledWith(token, { strict: false });
		expect(withExisting.resolve).not.toHaveBeenCalled();
	});

	it("awaits { useExisting } when a sibling provider is not instantiated yet", async () => {
		const existing = new MemoryPolicyStore();
		const token = Symbol("ASYNC_EXISTING_STORE");
		const withExisting = moduleRefDouble(undefined, existing);

		const store = await resolvePolicyStore(
			{ ...base, store: { useExisting: token } },
			withExisting.ref,
		);

		expect(store).toBe(existing);
		expect(withExisting.resolve).toHaveBeenCalledWith(token, undefined, { strict: false });
	});

	it("calls { useFactory } with its injected dependencies", async () => {
		const injected = new MemoryPolicyStore();
		const token = Symbol("DEP");
		const withDependency = moduleRefDouble(injected);
		const useFactory = vi.fn((dependency: MemoryPolicyStore) => dependency);

		const store = await resolvePolicyStore(
			{ ...base, store: { useFactory, inject: [token] } },
			withDependency.ref,
		);

		expect(store).toBe(injected);
		expect(useFactory).toHaveBeenCalledWith(injected);
		expect(withDependency.get).toHaveBeenCalledWith(token, { strict: false });
		expect(withDependency.resolve).not.toHaveBeenCalled();
	});

	it("awaits nullish { useFactory } dependencies from sibling modules", async () => {
		const first = Symbol("FIRST_DEP");
		const second = Symbol("SECOND_DEP");
		const firstDependency = { name: "first" };
		const secondDependency = { name: "second" };
		const get = vi.fn((token: symbol) => (token === first ? firstDependency : undefined));
		const resolve = vi.fn(async (token: symbol) =>
			token === second ? secondDependency : undefined,
		);
		const ref = { get, resolve, create: vi.fn() } as unknown as ModuleRef;
		const useFactory = vi.fn((left: typeof firstDependency, right: typeof secondDependency) => {
			void left;
			void right;
			return new MemoryPolicyStore();
		});

		const store = await resolvePolicyStore(
			{ ...base, store: { useFactory: useFactory as never, inject: [first, second] } },
			ref,
		);

		expect(store).toBeInstanceOf(MemoryPolicyStore);
		expect(useFactory).toHaveBeenCalledWith(firstDependency, secondDependency);
		expect(resolve).toHaveBeenCalledTimes(1);
		expect(resolve).toHaveBeenCalledWith(second, undefined, { strict: false });
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
