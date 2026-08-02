import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type {
	AuthorizationAnswer,
	CedarBinding,
	Entities,
	Response,
	StatefulAuthorizationCall,
} from "../../src/cedar/binding.ts";
import { unwrapAuthorization } from "../../src/cedar/answers.ts";
import { loadCedar } from "../../src/cedar/loader.ts";
import type { EntityRef } from "../../src/cedar/uid.ts";
import { PermissionsError } from "../../src/diagnostics/errors.ts";
import { MemoryPolicyStore } from "../../src/policy/memory-policy-store.ts";
import { policyRecordFromText } from "../../src/policy/policy-codec.ts";
import type {
	PolicyBundle,
	PolicyChangeListener,
	PolicyRecord,
	PolicyScopeId,
	PolicyStore,
	TemplateLinkRecord,
	Unsubscribe,
} from "../../src/policy/policy-store.ts";
import { PolicySetCache, type PolicySetCacheOptions } from "../../src/runtime/policy-set-cache.ts";
import { SchemaCache, schemaHash } from "../../src/runtime/schema-cache.ts";
import type { ActionOf, EntityNameOf } from "../../src/vocabulary/types.ts";
import { stationVocabulary } from "../fixtures/station-vocabulary.ts";

type StationEntity = EntityNameOf<typeof stationVocabulary>;
type StationAction = ActionOf<typeof stationVocabulary>;

const TENANT = "org:1";
const OTHER_TENANT = "org:2";

/** Global: any member may manage any project. Proves global ∪ scope composition (D2). */
const GLOBAL_POLICY_TEXT =
	`permit(principal is Station::Member, action == Station::Action::"project:manage", ` +
	`resource is Station::Project);`;

/** Tenant template: the role-grant primitive. Links instantiate it per member. */
const READER_TEMPLATE_TEXT = `permit(principal == ?principal, action == Station::Action::"run:read", resource in ?resource);`;

const FIXED_TIME = new Date("2026-07-30T00:00:00.000Z");

let cedar: CedarBinding;
let schemaName: string;
let instanceCounter = 0;
const liveCaches: PolicySetCache[] = [];

const uid = (type: StationEntity, id: string) => stationVocabulary.entityUid({ type, id });
const ref = (type: StationEntity, id: string): EntityRef<StationEntity> => ({ type, id });

const ENTITIES: Entities = [
	{ uid: uid("Organization", "o1"), attrs: {}, parents: [] },
	{
		uid: uid("Member", "m1"),
		attrs: {
			organization: { __entity: { type: "Station::Organization", id: "o1" } },
			identitySubject: "sub-1",
		},
		parents: [uid("Organization", "o1")],
	},
	{
		uid: uid("Member", "m2"),
		attrs: {
			organization: { __entity: { type: "Station::Organization", id: "o1" } },
			identitySubject: "sub-2",
		},
		parents: [uid("Organization", "o1")],
	},
	{
		uid: uid("Project", "p1"),
		attrs: {
			organization: { __entity: { type: "Station::Organization", id: "o1" } },
			archived: false,
		},
		parents: [uid("Organization", "o1")],
	},
	{
		uid: uid("Run", "r1"),
		attrs: {
			project: { __entity: { type: "Station::Project", id: "p1" } },
			status: "queued",
			createdBy: { __entity: { type: "Station::Member", id: "m1" } },
			attempt: 1,
			labels: ["nightly"],
			trigger: { kind: "manual" },
		},
		parents: [uid("Project", "p1")],
	},
];

function call(
	psetId: string,
	principal: EntityRef<StationEntity>,
	action: StationAction,
	resource: EntityRef<StationEntity>,
): StatefulAuthorizationCall {
	return {
		principal: uid(principal.type, principal.id),
		action: stationVocabulary.actionUid(action),
		resource: uid(resource.type, resource.id),
		context: {},
		preparsedSchemaName: schemaName,
		validateRequest: true,
		preparsedPolicySetId: psetId,
		entities: ENTITIES,
	};
}

function rawAuthorize(
	psetId: string,
	principal: EntityRef<StationEntity>,
	action: StationAction,
	resource: EntityRef<StationEntity>,
): AuthorizationAnswer {
	return cedar.statefulIsAuthorized(call(psetId, principal, action, resource));
}

function authorize(
	psetId: string,
	principal: EntityRef<StationEntity>,
	action: StationAction,
	resource: EntityRef<StationEntity>,
): Response {
	return unwrapAuthorization(rawAuthorize(psetId, principal, action, resource), {
		code: "EVALUATION_FAILED",
		message: "authorization failed",
	});
}

function readerGrant(id = "grant:m1-p1"): TemplateLinkRecord {
	return {
		id,
		scope: TENANT,
		templateId: "role:reader",
		values: { "?principal": ref("Member", "m1"), "?resource": ref("Project", "p1") },
		updatedAt: FIXED_TIME,
	};
}

function seedStore(): MemoryPolicyStore {
	return new MemoryPolicyStore({
		policies: [
			policyRecordFromText(cedar, {
				id: "global:manage-projects",
				scope: "",
				text: GLOBAL_POLICY_TEXT,
				updatedAt: FIXED_TIME,
			}),
			policyRecordFromText(cedar, {
				id: "role:reader",
				scope: TENANT,
				text: READER_TEMPLATE_TEXT,
				updatedAt: FIXED_TIME,
			}),
		],
		links: [readerGrant()],
	});
}

function createCache(
	store: PolicyStore,
	options: Partial<PolicySetCacheOptions> = {},
): PolicySetCache {
	instanceCounter += 1;
	const cache = new PolicySetCache({
		binding: cedar,
		store,
		instanceId: `pset-test-${String(instanceCounter)}`,
		namespace: stationVocabulary.namespace,
		...options,
	});
	liveCaches.push(cache);
	return cache;
}

/** Delegating store without `watch`: forces the time-based freshness fallback. */
class NoWatchStore implements PolicyStore {
	loads = 0;
	versionCalls = 0;

	constructor(readonly inner: MemoryPolicyStore) {}

	async load(scope: PolicyScopeId): Promise<PolicyBundle> {
		this.loads += 1;
		return this.inner.load(scope);
	}
	async currentVersion(scope: PolicyScopeId): Promise<string> {
		this.versionCalls += 1;
		return this.inner.currentVersion(scope);
	}
	async save(policies: readonly PolicyRecord[]): Promise<void> {
		return this.inner.save(policies);
	}
	async delete(scope: PolicyScopeId, ids: readonly string[]): Promise<void> {
		return this.inner.delete(scope, ids);
	}
	async linkTemplate(link: TemplateLinkRecord): Promise<void> {
		return this.inner.linkTemplate(link);
	}
	async unlinkTemplate(scope: PolicyScopeId, linkId: string): Promise<void> {
		return this.inner.unlinkTemplate(scope, linkId);
	}
}

/** Delegating store whose `load` can be made to fail on demand. */
class FlakyStore implements PolicyStore {
	failNext = false;

	constructor(readonly inner: MemoryPolicyStore) {}

	async load(scope: PolicyScopeId): Promise<PolicyBundle> {
		if (this.failNext) {
			throw new Error("connection reset");
		}
		return this.inner.load(scope);
	}
	async currentVersion(scope: PolicyScopeId): Promise<string> {
		return this.inner.currentVersion(scope);
	}
	async save(policies: readonly PolicyRecord[]): Promise<void> {
		return this.inner.save(policies);
	}
	async delete(scope: PolicyScopeId, ids: readonly string[]): Promise<void> {
		return this.inner.delete(scope, ids);
	}
	async linkTemplate(link: TemplateLinkRecord): Promise<void> {
		return this.inner.linkTemplate(link);
	}
	async unlinkTemplate(scope: PolicyScopeId, linkId: string): Promise<void> {
		return this.inner.unlinkTemplate(scope, linkId);
	}
	watch(listener: PolicyChangeListener): Unsubscribe {
		return this.inner.watch(listener);
	}
}

interface Deferred {
	readonly promise: Promise<void>;
	resolve(): void;
}

function deferred(): Deferred {
	let resolvePromise: (() => void) | undefined;
	const promise = new Promise<void>((resolve) => {
		resolvePromise = resolve;
	});
	return {
		promise,
		resolve(): void {
			resolvePromise?.();
		},
	};
}

/** Delegating watched store that can pause one load after taking its snapshot. */
class GatedLoadStore implements PolicyStore {
	loads = 0;
	#nextGate: { readonly started: Deferred; readonly release: Deferred } | undefined;

	constructor(readonly inner: MemoryPolicyStore) {}

	gateNextLoad(): { readonly started: Deferred; readonly release: Deferred } {
		const gate = { started: deferred(), release: deferred() };
		this.#nextGate = gate;
		return gate;
	}

	async load(scope: PolicyScopeId): Promise<PolicyBundle> {
		this.loads += 1;
		const bundle = await this.inner.load(scope);
		const gate = this.#nextGate;
		if (gate !== undefined) {
			this.#nextGate = undefined;
			gate.started.resolve();
			await gate.release.promise;
		}
		return bundle;
	}

	async currentVersion(scope: PolicyScopeId): Promise<string> {
		return this.inner.currentVersion(scope);
	}

	async save(policies: readonly PolicyRecord[]): Promise<void> {
		return this.inner.save(policies);
	}

	async delete(scope: PolicyScopeId, ids: readonly string[]): Promise<void> {
		return this.inner.delete(scope, ids);
	}

	async linkTemplate(link: TemplateLinkRecord): Promise<void> {
		return this.inner.linkTemplate(link);
	}

	async unlinkTemplate(scope: PolicyScopeId, linkId: string): Promise<void> {
		return this.inner.unlinkTemplate(scope, linkId);
	}

	watch(listener: PolicyChangeListener): Unsubscribe {
		return this.inner.watch(listener);
	}
}

beforeAll(async () => {
	cedar = await loadCedar();
	schemaName = new SchemaCache().ensure(
		cedar,
		schemaHash(stationVocabulary.cedarSchemaJson),
		stationVocabulary.cedarSchemaJson,
	);
});

afterEach(() => {
	// Leaving preparsed ids resident would leak WASM linear memory across tests,
	// which is the whole reason the evict-by-empty primitive exists.
	while (liveCaches.length > 0) {
		liveCaches.pop()?.dispose();
	}
	vi.restoreAllMocks();
});

describe("ensure -> statefulIsAuthorized", () => {
	it("authorizes through the preparsed set, template links included", async () => {
		const cache = createCache(seedStore());

		const handle = await cache.ensure(TENANT);

		expect(handle).toEqual({
			psetId: cache.psetIdFor(TENANT),
			version: "g1:s2",
			cache: "miss",
		});
		expect(handle.psetId).toBe(`pset-test-${String(instanceCounter)}:${TENANT}`);

		const granted = authorize(handle.psetId, ref("Member", "m1"), "run:read", ref("Run", "r1"));
		expect(granted.decision).toBe("allow");
		// The determining policy is the *link*, which is what proves template links
		// survive the bundle -> PolicySet -> preparse path.
		expect(granted.diagnostics.reason).toEqual(["grant:m1-p1"]);
		expect(granted.diagnostics.errors).toEqual([]);

		const ungranted = authorize(handle.psetId, ref("Member", "m2"), "run:read", ref("Run", "r1"));
		expect(ungranted.decision).toBe("deny");
		expect(ungranted.diagnostics.reason).toEqual([]);
	});

	it("composes the global scope into the tenant's set (D2)", async () => {
		const cache = createCache(seedStore());
		const { psetId } = await cache.ensure(TENANT);

		const response = authorize(psetId, ref("Member", "m2"), "project:manage", ref("Project", "p1"));

		expect(response.decision).toBe("allow");
		expect(response.diagnostics.reason).toEqual(["global:manage-projects"]);
	});

	it("serves the second call from cache without touching the store", async () => {
		const store = seedStore();
		const loadSpy = vi.spyOn(store, "load");
		const versionSpy = vi.spyOn(store, "currentVersion");
		const cache = createCache(store);

		const first = await cache.ensure(TENANT);
		const second = await cache.ensure(TENANT);

		expect(first.cache).toBe("miss");
		expect(second.cache).toBe("hit");
		expect(second.psetId).toBe(first.psetId);
		expect(second.version).toBe(first.version);
		expect(loadSpy).toHaveBeenCalledTimes(1);
		// D1: a watching store is never probed on the hit path.
		expect(versionSpy).not.toHaveBeenCalled();
		expect(cache.watching).toBe(true);
		expect(cache.stats()).toMatchObject({ hits: 1, misses: 1, loads: 1, preparses: 1, scopes: 1 });
	});
});

describe("watch-driven staleness", () => {
	it("reloads exactly once under the same psetId after an event", async () => {
		const store = seedStore();
		const loadSpy = vi.spyOn(store, "load");
		const versionSpy = vi.spyOn(store, "currentVersion");
		const cache = createCache(store);

		const first = await cache.ensure(TENANT);
		await cache.ensure(TENANT);
		expect(loadSpy).toHaveBeenCalledTimes(1);

		// Revoking the grant emits a per-scope event, which marks the entry stale.
		await store.unlinkTemplate(TENANT, "grant:m1-p1");
		expect(cache.peek(TENANT)?.stale).toBe(true);

		const handles = await Promise.all([
			cache.ensure(TENANT),
			cache.ensure(TENANT),
			cache.ensure(TENANT),
		]);

		expect(loadSpy).toHaveBeenCalledTimes(2);
		expect(versionSpy).not.toHaveBeenCalled();
		for (const handle of handles) {
			expect(handle.psetId).toBe(first.psetId);
			expect(handle.version).not.toBe(first.version);
		}
		expect(cache.stats().preparses).toBe(2);

		// Re-preparsing the same id replaced the old policy set in place.
		expect(
			authorize(first.psetId, ref("Member", "m1"), "run:read", ref("Run", "r1")).decision,
		).toBe("deny");
	});

	it("invalidates every cached scope on a '*' event", async () => {
		const store = seedStore();
		const cache = createCache(store);
		await cache.ensure(TENANT);
		await cache.ensure(OTHER_TENANT);

		const loadSpy = vi.spyOn(store, "load");
		await store.save([
			policyRecordFromText(cedar, {
				id: "global:extra",
				scope: "",
				text: "permit(principal, action, resource) when { false };",
			}),
		]);

		expect(cache.peek(TENANT)?.stale).toBe(true);
		expect(cache.peek(OTHER_TENANT)?.stale).toBe(true);

		await cache.ensure(TENANT);
		await cache.ensure(OTHER_TENANT);
		expect(loadSpy).toHaveBeenCalledTimes(2);
	});

	it("invalidate('*') marks everything stale without unloading anything", async () => {
		const cache = createCache(seedStore());
		const { psetId } = await cache.ensure(TENANT);
		await cache.ensure(OTHER_TENANT);

		cache.invalidate("*");

		expect(cache.peek(TENANT)?.stale).toBe(true);
		expect(cache.peek(OTHER_TENANT)?.stale).toBe(true);
		expect(cache.stats().scopes).toBe(2);
		// Still resident and still answering: stale-but-known beats empty.
		expect(authorize(psetId, ref("Member", "m1"), "run:read", ref("Run", "r1")).decision).toBe(
			"allow",
		);
	});

	it("invalidate on an unknown scope is a no-op", async () => {
		const cache = createCache(seedStore());
		await cache.ensure(TENANT);

		expect(() => cache.invalidate("never-seen")).not.toThrow();
		expect(cache.peek(TENANT)?.stale).toBe(false);
	});
});

describe("eviction", () => {
	it("empties the policy set and repopulates the same id", async () => {
		const cache = createCache(seedStore());
		const { psetId } = await cache.ensure(TENANT);
		expect(authorize(psetId, ref("Member", "m1"), "run:read", ref("Run", "r1")).decision).toBe(
			"allow",
		);

		expect(cache.evict(TENANT)).toBe(true);
		expect(cache.peek(TENANT)).toBeUndefined();
		expect(cache.stats()).toMatchObject({ evictions: 1, scopes: 0 });

		// Verified cedar-wasm behaviour: the empty overwrite frees the slot but
		// leaves the id *registered*, so the fail-closed outcome is `deny` — the
		// "not found" failure belongs to an id that was never preparsed at all.
		const evicted = rawAuthorize(psetId, ref("Member", "m1"), "run:read", ref("Run", "r1"));
		expect(evicted.type).toBe("success");
		expect(evicted.type === "success" && evicted.response.decision).toBe("deny");

		const neverPrepared = rawAuthorize(
			"pset-test-never-registered",
			ref("Member", "m1"),
			"run:read",
			ref("Run", "r1"),
		);
		expect(neverPrepared.type).toBe("failure");
		expect(neverPrepared.type === "failure" && neverPrepared.errors[0]?.message).toContain(
			"not found",
		);

		const again = await cache.ensure(TENANT);
		expect(again.psetId).toBe(psetId);
		expect(again.cache).toBe("miss");
		expect(authorize(psetId, ref("Member", "m1"), "run:read", ref("Run", "r1")).decision).toBe(
			"allow",
		);
	});

	it("evicting an unknown scope reports false and touches nothing", async () => {
		const cache = createCache(seedStore());
		await cache.ensure(TENANT);

		expect(cache.evict("never-seen")).toBe(false);
		expect(cache.stats().evictions).toBe(0);
	});

	it("releases the least-recently-used scope under capacity pressure", async () => {
		const cache = createCache(seedStore(), { maxScopes: 1 });

		const first = await cache.ensure(TENANT);
		const second = await cache.ensure(OTHER_TENANT);

		expect(cache.scopes()).toEqual([OTHER_TENANT]);
		expect(cache.stats().evictions).toBe(1);
		expect(
			authorize(first.psetId, ref("Member", "m1"), "run:read", ref("Run", "r1")).decision,
		).toBe("deny");
		expect(second.psetId).not.toBe(first.psetId);
	});
});

describe("single flight", () => {
	it("collapses N concurrent cold ensures into one load and one preparse", async () => {
		const store = seedStore();
		const loadSpy = vi.spyOn(store, "load");
		const cache = createCache(store);

		const handles = await Promise.all(Array.from({ length: 8 }, async () => cache.ensure(TENANT)));

		expect(loadSpy).toHaveBeenCalledTimes(1);
		expect(cache.stats()).toMatchObject({ loads: 1, preparses: 1, misses: 8, scopes: 1 });
		expect(new Set(handles.map((handle) => handle.version)).size).toBe(1);
		expect(new Set(handles.map((handle) => handle.psetId)).size).toBe(1);
		expect(cache.stats().inFlight).toBe(0);
	});

	it("retries a cold load invalidated for its scope before preparing it", async () => {
		const inner = seedStore();
		const store = new GatedLoadStore(inner);
		const cache = createCache(store);
		const gate = store.gateNextLoad();

		const ensuring = cache.ensure(TENANT);
		await gate.started.promise;
		await inner.unlinkTemplate(TENANT, "grant:m1-p1");
		gate.release.resolve();

		const handle = await ensuring;
		expect(store.loads).toBe(2);
		expect(handle.version).toBe(await inner.currentVersion(TENANT));
		expect(
			authorize(handle.psetId, ref("Member", "m1"), "run:read", ref("Run", "r1")).decision,
		).toBe("deny");
	});

	it("retries a blocked reload when a '*' invalidation changes its global bundle", async () => {
		const inner = seedStore();
		const store = new GatedLoadStore(inner);
		const cache = createCache(store);
		await cache.ensure(TENANT);

		cache.invalidate(TENANT);
		const gate = store.gateNextLoad();
		const ensuring = cache.ensure(TENANT);
		await gate.started.promise;
		await inner.save([
			policyRecordFromText(cedar, {
				id: "global:race",
				scope: "",
				text: "permit(principal, action, resource) when { false };",
			}),
		]);
		gate.release.resolve();

		const handle = await ensuring;
		expect(store.loads).toBe(3);
		expect(handle.version).toBe(await inner.currentVersion(TENANT));
		expect(cache.peek(TENANT)?.stale).toBe(false);
	});
});

describe("time-based freshness without watch", () => {
	it("probes currentVersion only after staleAfterMs", async () => {
		const inner = seedStore();
		const store = new NoWatchStore(inner);
		let now = 1_000;
		const cache = createCache(store, { clock: () => now, staleAfterMs: 30_000 });

		expect(cache.watching).toBe(false);

		await cache.ensure(TENANT);
		await cache.ensure(TENANT);
		now += 29_000;
		await cache.ensure(TENANT);

		expect(store.versionCalls).toBe(0);
		expect(store.loads).toBe(1);

		now += 2_000;
		const revalidated = await cache.ensure(TENANT);

		expect(store.versionCalls).toBe(1);
		// The version had not moved, so nothing was reloaded.
		expect(store.loads).toBe(1);
		expect(revalidated.cache).toBe("hit");

		// The window restarted from the successful probe.
		now += 1_000;
		await cache.ensure(TENANT);
		expect(store.versionCalls).toBe(1);
	});

	it("reloads when the probe shows the version moved", async () => {
		const inner = seedStore();
		const store = new NoWatchStore(inner);
		let now = 1_000;
		const cache = createCache(store, { clock: () => now, staleAfterMs: 10_000 });

		const first = await cache.ensure(TENANT);
		await inner.unlinkTemplate(TENANT, "grant:m1-p1");
		now += 11_000;

		const second = await cache.ensure(TENANT);

		expect(store.versionCalls).toBe(1);
		expect(store.loads).toBe(2);
		expect(second.cache).toBe("miss");
		expect(second.psetId).toBe(first.psetId);
		expect(second.version).not.toBe(first.version);
	});
});

describe("warm", () => {
	it("loads a cold scope and probes a warm one", async () => {
		const store = seedStore();
		const versionSpy = vi.spyOn(store, "currentVersion");
		const loadSpy = vi.spyOn(store, "load");
		const cache = createCache(store);

		const cold = await cache.warm(TENANT);
		expect(cold.cache).toBe("miss");
		expect(versionSpy).not.toHaveBeenCalled();

		const warm = await cache.warm(TENANT);
		expect(warm.cache).toBe("hit");
		// D1 carves out `warm()` as an explicit freshness flow, so probing here is
		// correct even though the store is watched.
		expect(versionSpy).toHaveBeenCalledTimes(1);
		expect(loadSpy).toHaveBeenCalledTimes(1);
		expect(cache.stats().revalidations).toBe(1);
	});

	it("reloads when the probe disagrees with the cached version", async () => {
		// A store with no `watch` is the only way to reach the probe-disagrees arm:
		// with one, the event would already have marked the entry stale.
		const inner = seedStore();
		const store = new NoWatchStore(inner);
		const cache = createCache(store);
		const first = await cache.warm(TENANT);

		await inner.unlinkTemplate(TENANT, "grant:m1-p1");
		expect(cache.peek(TENANT)?.stale).toBe(false);

		const second = await cache.warm(TENANT);

		expect(store.versionCalls).toBe(1);
		expect(store.loads).toBe(2);
		expect(second.cache).toBe("miss");
		expect(second.psetId).toBe(first.psetId);
		expect(second.version).not.toBe(first.version);
	});
});

describe("failure handling", () => {
	it("preserves the previous entry and rejects the caller that triggered the reload", async () => {
		const inner = seedStore();
		const store = new FlakyStore(inner);
		const cache = createCache(store);

		const first = await cache.ensure(TENANT);
		cache.invalidate(TENANT);
		store.failNext = true;

		await expect(cache.ensure(TENANT)).rejects.toMatchObject({
			name: "PermissionsError",
			code: "POLICY_STORE",
			scope: TENANT,
		});
		await expect(cache.ensure(TENANT)).rejects.toThrow(/connection reset/);

		// Entry kept, still stale, and the resident policy set still answers.
		expect(cache.peek(TENANT)).toMatchObject({ version: first.version, stale: true });
		expect(cache.stats()).toMatchObject({ failures: 2, scopes: 1 });
		expect(
			authorize(first.psetId, ref("Member", "m1"), "run:read", ref("Run", "r1")).decision,
		).toBe("allow");

		store.failNext = false;
		const recovered = await cache.ensure(TENANT);
		expect(recovered.cache).toBe("miss");
		expect(recovered.psetId).toBe(first.psetId);
		expect(cache.peek(TENANT)?.stale).toBe(false);
	});

	it("surfaces a builder failure as POLICY_INVALID", async () => {
		const store = new MemoryPolicyStore({
			links: [{ ...readerGrant(), templateId: "role:missing" }],
		});
		const cache = createCache(store);

		await expect(cache.ensure(TENANT)).rejects.toMatchObject({ code: "POLICY_INVALID" });
		expect(cache.peek(TENANT)).toBeUndefined();
		expect(cache.stats()).toMatchObject({ failures: 1, preparses: 0 });
	});
});

describe("onPolicySetBuilt", () => {
	it("sees every freshly compiled set before it reaches the WASM", async () => {
		const store = seedStore();
		const seen: { scope: PolicyScopeId; policyIds: string[] }[] = [];
		const cache = createCache(store, {
			onPolicySetBuilt: (set, scope) => {
				seen.push({ scope, policyIds: Object.keys(set.staticPolicies ?? {}) });
			},
		});

		await cache.ensure(TENANT);
		await cache.ensure(TENANT);
		await store.unlinkTemplate(TENANT, "grant:m1-p1");
		await cache.ensure(TENANT);

		// Once per *load*, never on a hit.
		expect(seen).toEqual([
			{ scope: TENANT, policyIds: ["global:manage-projects"] },
			{ scope: TENANT, policyIds: ["global:manage-projects"] },
		]);
	});

	it("rejects the load when it throws, leaving the previous set serviceable", async () => {
		const store = seedStore();
		let admit = true;
		const cache = createCache(store, {
			onPolicySetBuilt: () => {
				if (!admit) {
					throw new PermissionsError("POLICY_INVALID", "refused by the admission hook");
				}
			},
		});

		const first = await cache.ensure(TENANT);
		admit = false;
		cache.invalidate(TENANT);

		await expect(cache.ensure(TENANT)).rejects.toMatchObject({ code: "POLICY_INVALID" });

		// The entry survived, still stale, and the resident policy set still answers:
		// a policy set that fails admission must not replace a working one.
		expect(cache.peek(TENANT)).toMatchObject({ version: first.version, stale: true });
		expect(cache.stats()).toMatchObject({ failures: 1, preparses: 1, scopes: 1 });
		expect(
			authorize(first.psetId, ref("Member", "m1"), "run:read", ref("Run", "r1")).decision,
		).toBe("allow");

		admit = true;
		const recovered = await cache.ensure(TENANT);
		expect(recovered.cache).toBe("miss");
		expect(recovered.psetId).toBe(first.psetId);
	});

	it("is not reached when the bundle fails to compile", async () => {
		const store = new MemoryPolicyStore({
			links: [{ ...readerGrant(), templateId: "role:missing" }],
		});
		const onPolicySetBuilt = vi.fn();
		const cache = createCache(store, { onPolicySetBuilt });

		await expect(cache.ensure(TENANT)).rejects.toMatchObject({ code: "POLICY_INVALID" });
		expect(onPolicySetBuilt).not.toHaveBeenCalled();
	});

	it("does not run on the evict-by-empty overwrite", async () => {
		const onPolicySetBuilt = vi.fn();
		const cache = createCache(seedStore(), { onPolicySetBuilt });

		await cache.ensure(TENANT);
		cache.evict(TENANT);

		expect(onPolicySetBuilt).toHaveBeenCalledTimes(1);
	});
});

describe("dispose", () => {
	it("empties every owned id and refuses further use", async () => {
		const cache = createCache(seedStore());
		const first = await cache.ensure(TENANT);
		const second = await cache.ensure(OTHER_TENANT);

		cache.dispose();

		expect(cache.disposed).toBe(true);
		expect(cache.stats()).toMatchObject({ scopes: 0, evictions: 2 });

		for (const psetId of [first.psetId, second.psetId]) {
			const answer = rawAuthorize(psetId, ref("Member", "m1"), "run:read", ref("Run", "r1"));
			expect(answer.type).toBe("success");
			expect(answer.type === "success" && answer.response.decision).toBe("deny");
		}

		await expect(cache.ensure(TENANT)).rejects.toMatchObject({
			code: "POLICY_SET_NOT_PREPARED",
		});
		await expect(cache.warm(TENANT)).rejects.toMatchObject({ code: "POLICY_SET_NOT_PREPARED" });
	});

	it("unsubscribes from the store exactly once", () => {
		const store = seedStore();
		const unsubscribe = vi.fn();
		const watchSpy = vi.spyOn(store, "watch").mockReturnValue(unsubscribe);
		const cache = createCache(store);

		expect(watchSpy).toHaveBeenCalledTimes(1);

		cache.dispose();
		cache.dispose();

		expect(unsubscribe).toHaveBeenCalledTimes(1);
	});
});

describe("psetIdFor", () => {
	it("is stable and never version-suffixed", async () => {
		const cache = createCache(seedStore());

		const before = cache.psetIdFor(TENANT);
		const first = await cache.ensure(TENANT);
		cache.invalidate(TENANT);
		const second = await cache.ensure(TENANT);

		expect(before).toBe(first.psetId);
		expect(second.psetId).toBe(before);
		expect(before.endsWith(`:${TENANT}`)).toBe(true);
	});

	it("keeps the global scope addressable", async () => {
		const cache = createCache(seedStore());

		const handle = await cache.ensure("");

		expect(handle.psetId.endsWith(":")).toBe(true);
		expect(
			authorize(handle.psetId, ref("Member", "m2"), "project:manage", ref("Project", "p1"))
				.decision,
		).toBe("allow");
		// The tenant template is not part of the global bundle.
		expect(
			authorize(handle.psetId, ref("Member", "m1"), "run:read", ref("Run", "r1")).decision,
		).toBe("deny");
	});
});
