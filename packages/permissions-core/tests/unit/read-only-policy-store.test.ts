// `readOnlyPolicyStore` — the three-method store, adapted onto the seven-method SPI.
//
// The failure this exists to prevent is not a crash. A consumer whose policies
// are managed elsewhere used to hand-write four stubs, and the tempting stub is
// the resolving one: `async save() {}`. That reports success to its caller, the
// next `load()` does not show the record, and the difference surfaces much later
// as an authorization decision that should have changed and did not.

import { describe, expect, it, vi } from "vitest";

import { isPermissionsError } from "../../src/diagnostics/errors.ts";
import { MemoryPolicyStore } from "../../src/policy/memory-policy-store.ts";
import {
	composePolicyVersion,
	type PolicyBundle,
	type PolicyChangeListener,
	type PolicyScopeId,
	type PolicyStore,
} from "../../src/policy/policy-store.ts";
import {
	isReadOnlyPolicyStore,
	readOnlyPolicyStore,
	type ReadOnlyPolicyStore,
} from "../../src/policy/read-only-policy-store.ts";
import { policyRecordFixture, templateLinkFixture } from "../../src/testing/fixtures.ts";

const SCOPE = "tenant-a";

function bundle(scope: PolicyScopeId): PolicyBundle {
	return Object.freeze({
		scope,
		version: composePolicyVersion(0, 7),
		policies: Object.freeze([policyRecordFixture({ id: "p1", scope })]),
		links: Object.freeze([]),
	});
}

/** The whole implementation burden: three methods, one of them optional. */
function source(): ReadOnlyPolicyStore {
	return {
		async load(scope) {
			return bundle(scope);
		},
		async currentVersion() {
			return composePolicyVersion(0, 7);
		},
	};
}

describe("readOnlyPolicyStore", () => {
	it("satisfies PolicyStore from three methods", () => {
		const store: PolicyStore = readOnlyPolicyStore(source());

		for (const method of [
			"load",
			"currentVersion",
			"save",
			"delete",
			"linkTemplate",
			"unlinkTemplate",
		]) {
			expect(store[method as keyof PolicyStore]).toBeTypeOf("function");
		}
	});

	it("forwards the reads unchanged", async () => {
		const store = readOnlyPolicyStore(source());

		const loaded = await store.load(SCOPE);
		expect(loaded.scope).toBe(SCOPE);
		expect(loaded.policies.map((record) => record.id)).toEqual(["p1"]);
		expect(await store.currentVersion(SCOPE)).toBe(loaded.version);
	});

	it("passes the scope through to load and currentVersion", async () => {
		const load = vi.fn(async (scope: PolicyScopeId) => bundle(scope));
		const currentVersion = vi.fn(async () => composePolicyVersion(0, 1));
		const store = readOnlyPolicyStore({ load, currentVersion });

		await store.load("tenant-b");
		await store.currentVersion("tenant-c");

		expect(load).toHaveBeenCalledWith("tenant-b");
		expect(currentVersion).toHaveBeenCalledWith("tenant-c");
	});

	describe("the write methods", () => {
		it("reject with POLICY_STORE, not with a bare Error", async () => {
			const store = readOnlyPolicyStore(source());

			await expect(
				store.save([policyRecordFixture({ id: "p1", scope: SCOPE })]),
			).rejects.toMatchObject({ code: "POLICY_STORE" });

			// And the code is reachable through the package's own guard, so existing
			// store-error handling catches it unchanged.
			const error = await store.delete(SCOPE, ["p1"]).catch((caught: unknown) => caught);
			expect(isPermissionsError(error)).toBe(true);
		});

		it("reject on all four, carrying the scope the caller named", async () => {
			const store = readOnlyPolicyStore(source());

			for (const [operation, call] of [
				["save", () => store.save([policyRecordFixture({ id: "p1", scope: SCOPE })])],
				["delete", () => store.delete(SCOPE, ["p1"])],
				[
					"linkTemplate",
					() =>
						store.linkTemplate(templateLinkFixture({ id: "l1", scope: SCOPE, templateId: "t" })),
				],
				["unlinkTemplate", () => store.unlinkTemplate(SCOPE, "l1")],
			] as const) {
				const error = await call().catch((caught: unknown) => caught);
				expect(error, operation).toMatchObject({ code: "POLICY_STORE", scope: SCOPE });
				expect(String(error)).toContain("read-only");
			}
		});

		it("reject an EMPTY batch too", async () => {
			// A writable store treats `save([])` as a no-op, which would make "nothing
			// to do" and "this store cannot write" the same observation — and a caller
			// batching zero records today would learn nothing about the batch of one it
			// sends tomorrow.
			const store = readOnlyPolicyStore(source());

			await expect(store.save([])).rejects.toMatchObject({ code: "POLICY_STORE" });
			await expect(store.delete(SCOPE, [])).rejects.toMatchObject({ code: "POLICY_STORE" });
		});

		it("names the store and the hint in the message", async () => {
			const store = readOnlyPolicyStore(source(), {
				name: "StationPolicyProjection",
				hint: "Write roles/role_grants instead.",
			});

			const error = await store.save([]).catch((caught: unknown) => caught);
			expect(String(error)).toContain("StationPolicyProjection is read-only");
			expect(String(error)).toContain("Write roles/role_grants instead.");
			// And it names the operation, so a stack-free log still says which call it was.
			expect(String(error)).toContain("save(0 record(s))");
		});
	});

	describe("watch (D1)", () => {
		it("is absent when the source has none — never synthesised", () => {
			// A never-firing `watch` would stop the cache polling `currentVersion`
			// entirely and freeze every decision at its first value. Leaving it
			// undefined is what asks for polling.
			expect(readOnlyPolicyStore(source())).not.toHaveProperty("watch");
		});

		it("is forwarded, with `this`, when the source has one", () => {
			const listeners: PolicyChangeListener[] = [];
			const unsubscribe = vi.fn();

			class Projection implements ReadOnlyPolicyStore {
				readonly own = "bound";
				async load(scope: PolicyScopeId): Promise<PolicyBundle> {
					return bundle(scope);
				}
				async currentVersion(): Promise<string> {
					return composePolicyVersion(0, 7);
				}
				watch(listener: PolicyChangeListener): () => void {
					// Reading an own property is the point: a `watch` extracted without its
					// receiver would subscribe to nothing and report success.
					expect(this.own).toBe("bound");
					listeners.push(listener);
					return unsubscribe;
				}
			}

			const store = readOnlyPolicyStore(new Projection());
			const listener = vi.fn();
			const stop = store.watch?.(listener);

			expect(listeners).toHaveLength(1);
			listeners[0]?.({ scope: SCOPE, reason: "external" });
			expect(listener).toHaveBeenCalledWith({ scope: SCOPE, reason: "external" });

			stop?.();
			expect(unsubscribe).toHaveBeenCalledTimes(1);
		});
	});

	describe("isReadOnlyPolicyStore", () => {
		it("recognises an adapter and nothing else", () => {
			expect(isReadOnlyPolicyStore(readOnlyPolicyStore(source()))).toBe(true);
			expect(isReadOnlyPolicyStore(new MemoryPolicyStore())).toBe(false);
		});
	});

	it("accepts an existing PolicyStore as its source — every store is already one", async () => {
		// Structural, not nominal: `ReadOnlyPolicyStore` is `PolicyStore` minus the
		// writes, so wrapping a writable store is how you make it read-only.
		const writable = new MemoryPolicyStore();
		await writable.save([policyRecordFixture({ id: "p1", scope: SCOPE })]);

		const frozen = readOnlyPolicyStore(writable, { name: "MemoryPolicyStore (frozen)" });

		expect((await frozen.load(SCOPE)).policies.map((record) => record.id)).toEqual(["p1"]);
		await expect(frozen.delete(SCOPE, ["p1"])).rejects.toMatchObject({ code: "POLICY_STORE" });
		// And the refusal was real: the underlying store still has the record.
		expect((await writable.load(SCOPE)).policies.map((record) => record.id)).toEqual(["p1"]);
	});
});
