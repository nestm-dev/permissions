import { describe, expect, it, vi } from "vitest";

import { CompositePolicyStore } from "../../src/policy/composite-policy-store.ts";
import { MemoryPolicyStore } from "../../src/policy/memory-policy-store.ts";
import type { PolicyChangeEvent, PolicyStore } from "../../src/policy/policy-store.ts";
import { linkRecord, policyRecord } from "../fixtures/policy-fixtures.ts";

/** A store with no `watch`, to prove the composite does not invent one. */
class SilentStore implements PolicyStore {
	readonly loaded: string[] = [];

	async load(scope: string) {
		this.loaded.push(scope);
		return { scope, version: "g0:s0", policies: [], links: [] };
	}
	async currentVersion(): Promise<string> {
		return "g0:s0";
	}
	async save(): Promise<void> {}
	async delete(): Promise<void> {}
	async linkTemplate(): Promise<void> {}
	async unlinkTemplate(): Promise<void> {}
}

describe("CompositePolicyStore routing", () => {
	it("requires a route or a fallback", () => {
		expect(() => new CompositePolicyStore()).toThrow(/at least one route or a fallback/);
	});

	it("prefers an exact route over the fallback", async () => {
		const instance = new MemoryPolicyStore({
			policies: [policyRecord({ id: "operator", scope: "instance" })],
		});
		const database = new MemoryPolicyStore({
			policies: [policyRecord({ id: "tenant", scope: "org:1" })],
		});
		const store = new CompositePolicyStore({ routes: { instance }, fallback: database });

		expect((await store.load("instance")).policies.map((policy) => policy.id)).toEqual([
			"operator",
		]);
		expect((await store.load("org:1")).policies.map((policy) => policy.id)).toEqual(["tenant"]);
		expect(store.storeFor("instance")).toBe(instance);
		expect(store.storeFor("anything")).toBe(database);
		expect(store.routedScopes).toEqual(["instance"]);
		expect(store.hasFallback).toBe(true);
	});

	it("throws POLICY_STORE for an unroutable scope", async () => {
		const store = new CompositePolicyStore({ routes: { instance: new MemoryPolicyStore() } });

		expect(() => store.storeFor("org:1")).toThrowError(
			expect.objectContaining({ code: "POLICY_STORE", scope: "org:1" }),
		);
		await expect(store.load("org:1")).rejects.toThrow(/No policy store routes the scope "org:1"/);
		await expect(store.currentVersion("org:1")).rejects.toThrow(/No policy store routes/);
		expect(store.hasFallback).toBe(false);
	});

	it("delegates currentVersion", async () => {
		const instance = new MemoryPolicyStore();
		await instance.save([policyRecord({ id: "p1", scope: "instance" })]);
		const store = new CompositePolicyStore({
			routes: { instance },
			fallback: new MemoryPolicyStore(),
		});

		expect(await store.currentVersion("instance")).toBe("g0:s1");
		expect(await store.currentVersion("org:1")).toBe("g0:s0");
	});

	it("routes writes exactly like reads", async () => {
		const instance = new MemoryPolicyStore();
		const database = new MemoryPolicyStore();
		const store = new CompositePolicyStore({ routes: { instance }, fallback: database });

		await store.save([
			policyRecord({ id: "a", scope: "instance" }),
			policyRecord({ id: "b", scope: "org:1" }),
		]);
		await store.linkTemplate(linkRecord({ id: "l1", scope: "org:1", templateId: "b" }));

		expect((await instance.load("instance")).policies.map((policy) => policy.id)).toEqual(["a"]);
		expect((await database.load("org:1")).policies.map((policy) => policy.id)).toEqual(["b"]);
		expect((await database.load("org:1")).links.map((link) => link.id)).toEqual(["l1"]);

		await store.delete("instance", ["a"]);
		await store.unlinkTemplate("org:1", "l1");

		expect((await instance.load("instance")).policies).toEqual([]);
		expect((await database.load("org:1")).links).toEqual([]);
	});

	it("throws when a save targets an unroutable scope", async () => {
		const store = new CompositePolicyStore({ routes: { instance: new MemoryPolicyStore() } });

		await expect(store.save([policyRecord({ id: "a", scope: "org:1" })])).rejects.toThrow(
			/No policy store routes/,
		);
	});
});

describe("CompositePolicyStore watch fan-in", () => {
	it("forwards events from every child exactly once", async () => {
		const instance = new MemoryPolicyStore();
		const database = new MemoryPolicyStore();
		const store = new CompositePolicyStore({ routes: { instance }, fallback: database });
		const events: PolicyChangeEvent[] = [];

		const unsubscribe = store.watch?.((event) => events.push(event));

		await store.save([policyRecord({ id: "a", scope: "instance" })]);
		await store.save([policyRecord({ id: "b", scope: "org:1" })]);

		expect(events).toEqual([
			{ scope: "instance", reason: "save" },
			{ scope: "org:1", reason: "save" },
		]);

		unsubscribe?.();
		unsubscribe?.();
		await store.save([policyRecord({ id: "c", scope: "org:1" })]);
		expect(events).toHaveLength(2);
	});

	it("subscribes a store shared between a route and the fallback only once", async () => {
		const shared = new MemoryPolicyStore();
		const store = new CompositePolicyStore({ routes: { instance: shared }, fallback: shared });
		const listener = vi.fn();

		store.watch?.(listener);
		await store.save([policyRecord({ id: "a", scope: "org:1" })]);

		expect(listener).toHaveBeenCalledTimes(1);
	});

	it("omits watch entirely when no child can emit", async () => {
		const silent = new SilentStore();
		const store = new CompositePolicyStore({ fallback: silent });

		expect(store.watch).toBeUndefined();
		expect("watch" in store).toBe(false);

		await store.load("org:1");
		expect(silent.loaded).toEqual(["org:1"]);
	});

	it("exposes watch when at least one child can emit", () => {
		const store = new CompositePolicyStore({
			routes: { instance: new MemoryPolicyStore() },
			fallback: new SilentStore(),
		});

		expect(typeof store.watch).toBe("function");
	});
});
