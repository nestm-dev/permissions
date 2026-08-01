import { describe, expect, it, vi } from "vitest";

import type { Effect, PolicyJson } from "../../src/cedar/binding.ts";
import { MemoryPolicyStore } from "../../src/policy/memory-policy-store.ts";
import {
	GLOBAL_POLICY_SCOPE,
	parsePolicyVersion,
	type PolicyChangeEvent,
} from "../../src/policy/policy-store.ts";
import {
	FORBID_ALL,
	PERMIT_ALL,
	TEMPLATE_BOTH_SLOTS,
	linkRecord,
	policyRecord,
} from "../fixtures/policy-fixtures.ts";

const TENANT = "org:1";

describe("MemoryPolicyStore CRUD", () => {
	it("starts empty", async () => {
		const store = new MemoryPolicyStore();
		const loaded = await store.load(TENANT);

		expect(loaded).toEqual({ scope: TENANT, version: "g0:s0", policies: [], links: [] });
	});

	it("saves, reloads and deletes policies", async () => {
		const store = new MemoryPolicyStore();

		await store.save([policyRecord({ id: "p1", scope: TENANT })]);
		expect((await store.load(TENANT)).policies.map((policy) => policy.id)).toEqual(["p1"]);

		await store.save([policyRecord({ id: "p1", scope: TENANT, enabled: false })]);
		expect((await store.load(TENANT)).policies[0]?.enabled).toBe(false);

		await store.delete(TENANT, ["p1", "unknown"]);
		expect((await store.load(TENANT)).policies).toEqual([]);
	});

	it("links and unlinks templates", async () => {
		const store = new MemoryPolicyStore();

		await store.linkTemplate(
			linkRecord({
				id: "l1",
				scope: TENANT,
				templateId: "t1",
				values: { "?principal": { type: "Member", id: "m1" } },
			}),
		);
		expect((await store.load(TENANT)).links.map((link) => link.id)).toEqual(["l1"]);

		await store.unlinkTemplate(TENANT, "l1");
		expect((await store.load(TENANT)).links).toEqual([]);
	});

	it("sorts the bundle by id", async () => {
		const store = new MemoryPolicyStore({
			policies: [
				policyRecord({ id: "b", scope: TENANT }),
				policyRecord({ id: "a", scope: TENANT }),
				policyRecord({ id: "c", scope: TENANT }),
			],
		});

		expect((await store.load(TENANT)).policies.map((policy) => policy.id)).toEqual(["a", "b", "c"]);
	});

	it("rejects structurally invalid records", async () => {
		const store = new MemoryPolicyStore();

		await expect(store.save([policyRecord({ id: "" })])).rejects.toMatchObject({
			code: "POLICY_STORE",
		});
		await expect(
			store.save([policyRecord({ id: "p", updatedAt: new Date("nope") })]),
		).rejects.toMatchObject({ code: "POLICY_STORE" });
		await expect(
			store.linkTemplate(
				linkRecord({
					id: "l",
					templateId: "t",
					// A slot Cedar would reject with a raw WASM throw rather than an answer.
					values: { "?context": { type: "Member", id: "m" } } as never,
				}),
			),
		).rejects.toMatchObject({ code: "POLICY_STORE" });
	});
});

describe("MemoryPolicyStore composition (D2)", () => {
	it("returns global union scope", async () => {
		const store = new MemoryPolicyStore({
			policies: [
				policyRecord({ id: "global-1", scope: GLOBAL_POLICY_SCOPE }),
				policyRecord({ id: "tenant-1", scope: TENANT }),
				policyRecord({ id: "other-1", scope: "org:2" }),
			],
			links: [
				linkRecord({ id: "global-link", scope: GLOBAL_POLICY_SCOPE, templateId: "t" }),
				linkRecord({ id: "tenant-link", scope: TENANT, templateId: "t" }),
			],
		});

		const loaded = await store.load(TENANT);

		expect(loaded.scope).toBe(TENANT);
		expect(loaded.policies.map((policy) => policy.id)).toEqual(["global-1", "tenant-1"]);
		expect(loaded.links.map((link) => link.id)).toEqual(["global-link", "tenant-link"]);
	});

	it("returns only global policies for the global scope", async () => {
		const store = new MemoryPolicyStore({
			policies: [
				policyRecord({ id: "global-1", scope: GLOBAL_POLICY_SCOPE }),
				policyRecord({ id: "tenant-1", scope: TENANT }),
			],
		});

		expect((await store.load(GLOBAL_POLICY_SCOPE)).policies.map((policy) => policy.id)).toEqual([
			"global-1",
		]);
	});

	it("throws when a policy id exists in both halves", async () => {
		const store = new MemoryPolicyStore({
			policies: [
				policyRecord({ id: "shared", scope: GLOBAL_POLICY_SCOPE }),
				policyRecord({ id: "shared", scope: TENANT }),
			],
		});

		await expect(store.load(TENANT)).rejects.toMatchObject({
			code: "POLICY_STORE",
			scope: TENANT,
		});
		await expect(store.load(TENANT)).rejects.toThrow(/exists in both the global scope/);
		// The unaffected scope still loads.
		await expect(store.load("org:2")).resolves.toMatchObject({ scope: "org:2" });
	});

	it("throws when a link id exists in both halves", async () => {
		const store = new MemoryPolicyStore({
			links: [
				linkRecord({ id: "shared", scope: GLOBAL_POLICY_SCOPE, templateId: "t" }),
				linkRecord({ id: "shared", scope: TENANT, templateId: "t" }),
			],
		});

		await expect(store.load(TENANT)).rejects.toThrow(/Template link id "shared" exists in both/);
	});
});

describe("MemoryPolicyStore versions", () => {
	it("composes g<n>:s<m>", async () => {
		const store = new MemoryPolicyStore();

		expect(await store.currentVersion(TENANT)).toBe("g0:s0");
		expect(parsePolicyVersion(await store.currentVersion(TENANT))).toEqual({ global: 0, scope: 0 });
	});

	it("moves the scope half when the scope changes", async () => {
		const store = new MemoryPolicyStore();
		const before = await store.currentVersion(TENANT);

		await store.save([policyRecord({ id: "p1", scope: TENANT })]);
		const after = await store.currentVersion(TENANT);

		expect(after).not.toBe(before);
		expect(parsePolicyVersion(after)).toEqual({ global: 0, scope: 1 });
		// A different tenant is untouched.
		expect(await store.currentVersion("org:2")).toBe("g0:s0");
	});

	it("moves the global half of every scope when the global scope changes", async () => {
		const store = new MemoryPolicyStore();
		await store.save([policyRecord({ id: "p1", scope: TENANT })]);

		await store.save([policyRecord({ id: "g1", scope: GLOBAL_POLICY_SCOPE })]);

		expect(await store.currentVersion(TENANT)).toBe("g1:s1");
		expect(await store.currentVersion("org:2")).toBe("g1:s0");
	});

	it("matches the version load reports", async () => {
		const store = new MemoryPolicyStore();
		await store.save([policyRecord({ id: "p1", scope: TENANT })]);

		expect((await store.load(TENANT)).version).toBe(await store.currentVersion(TENANT));
	});

	it("does not bump on a delete or unlink that removed nothing", async () => {
		const store = new MemoryPolicyStore();
		await store.save([policyRecord({ id: "p1", scope: TENANT })]);
		const before = await store.currentVersion(TENANT);

		await store.delete(TENANT, ["nope"]);
		await store.unlinkTemplate(TENANT, "nope");

		expect(await store.currentVersion(TENANT)).toBe(before);
	});
});

describe("MemoryPolicyStore watch", () => {
	it("emits per scope and unsubscribes idempotently", async () => {
		const store = new MemoryPolicyStore();
		const events: PolicyChangeEvent[] = [];
		const unsubscribe = store.watch((event) => events.push(event));

		await store.save([policyRecord({ id: "p1", scope: TENANT })]);
		await store.delete(TENANT, ["p1"]);
		await store.linkTemplate(linkRecord({ id: "l1", scope: TENANT, templateId: "t" }));
		await store.unlinkTemplate(TENANT, "l1");

		expect(events).toEqual([
			{ scope: TENANT, reason: "save" },
			{ scope: TENANT, reason: "delete" },
			{ scope: TENANT, reason: "link" },
			{ scope: TENANT, reason: "unlink" },
		]);

		unsubscribe();
		unsubscribe();
		await store.save([policyRecord({ id: "p2", scope: TENANT })]);
		expect(events).toHaveLength(4);
	});

	it("broadcasts '*' for a global write", async () => {
		const store = new MemoryPolicyStore();
		const events: PolicyChangeEvent[] = [];
		store.watch((event) => events.push(event));

		await store.save([policyRecord({ id: "g1", scope: GLOBAL_POLICY_SCOPE })]);

		expect(events).toEqual([{ scope: "*", reason: "save" }]);
	});

	it("emits one event per touched scope, in scope order", async () => {
		const store = new MemoryPolicyStore();
		const events: PolicyChangeEvent[] = [];
		store.watch((event) => events.push(event));

		await store.save([
			policyRecord({ id: "b", scope: "org:2" }),
			policyRecord({ id: "a", scope: "org:1" }),
		]);

		expect(events.map((event) => event.scope)).toEqual(["org:1", "org:2"]);
	});

	it("emits nothing while seeding", () => {
		const listener = vi.fn();
		const store = new MemoryPolicyStore({ policies: [policyRecord({ id: "p1" })] });
		store.watch(listener);

		expect(listener).not.toHaveBeenCalled();
	});

	it("supports an out-of-band emit", () => {
		const store = new MemoryPolicyStore();
		const events: PolicyChangeEvent[] = [];
		store.watch((event) => events.push(event));

		store.emit({ scope: "*", reason: "external" });

		expect(events).toEqual([{ scope: "*", reason: "external" }]);
	});

	it("notifies every listener even when one throws, then surfaces the failure", async () => {
		const store = new MemoryPolicyStore();
		const second = vi.fn();
		store.watch(() => {
			throw new Error("listener exploded");
		});
		store.watch(second);

		await expect(store.save([policyRecord({ id: "p1", scope: TENANT })])).rejects.toMatchObject({
			code: "POLICY_STORE",
		});
		expect(second).toHaveBeenCalledTimes(1);
		// The write itself still landed.
		expect((await store.load(TENANT)).policies.map((policy) => policy.id)).toEqual(["p1"]);
	});
});

describe("MemoryPolicyStore defensive copying", () => {
	it("ignores mutations of the object it was handed", async () => {
		const cedarJson: PolicyJson = structuredClone(PERMIT_ALL);
		const annotations = { owner: "platform" };
		const updatedAt = new Date("2026-01-01T00:00:00.000Z");
		const store = new MemoryPolicyStore();

		await store.save([
			policyRecord({ id: "p1", scope: TENANT, cedarJson, annotations, updatedAt }),
		]);

		(cedarJson as { effect: Effect }).effect = "forbid";
		annotations.owner = "hijacked";
		updatedAt.setFullYear(1999);

		const loaded = (await store.load(TENANT)).policies[0];
		expect(loaded?.cedarJson).toEqual(PERMIT_ALL);
		expect(loaded?.annotations).toEqual({ owner: "platform" });
		expect(loaded?.updatedAt.toISOString()).toBe("2026-01-01T00:00:00.000Z");
	});

	it("returns frozen records and arrays", async () => {
		const store = new MemoryPolicyStore({
			policies: [policyRecord({ id: "p1", scope: TENANT, cedarJson: TEMPLATE_BOTH_SLOTS })],
			links: [linkRecord({ id: "l1", scope: TENANT, templateId: "p1" })],
		});

		const loaded = await store.load(TENANT);

		expect(Object.isFrozen(loaded)).toBe(true);
		expect(Object.isFrozen(loaded.policies)).toBe(true);
		expect(Object.isFrozen(loaded.policies[0])).toBe(true);
		expect(Object.isFrozen(loaded.policies[0]?.cedarJson)).toBe(true);
		expect(Object.isFrozen(loaded.links[0]?.values)).toBe(true);
		expect(() => {
			(loaded.policies[0] as { enabled: boolean }).enabled = false;
		}).toThrow(TypeError);
	});

	it("hands each load its own mutable-free copy", async () => {
		const store = new MemoryPolicyStore({
			policies: [policyRecord({ id: "p1", scope: TENANT })],
		});

		const first = (await store.load(TENANT)).policies[0];
		// `Object.freeze` cannot close `Date.prototype.setTime`, so the store hands
		// out a fresh Date every time instead of relying on the freeze.
		first?.updatedAt.setFullYear(1999);

		const second = (await store.load(TENANT)).policies[0];
		expect(second?.updatedAt.getUTCFullYear()).toBe(2026);
		expect(first).not.toBe(second);
	});

	it("does not alias the record it stored into a later save", async () => {
		const store = new MemoryPolicyStore();
		await store.save([policyRecord({ id: "p1", scope: TENANT, cedarJson: PERMIT_ALL })]);
		await store.save([policyRecord({ id: "p1", scope: TENANT, cedarJson: FORBID_ALL })]);

		expect((await store.load(TENANT)).policies[0]?.cedarJson).toEqual(FORBID_ALL);
		expect(PERMIT_ALL.effect).toBe("permit");
	});
});
