import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { CedarBinding } from "../../src/cedar/binding.ts";
import { loadCedar } from "../../src/cedar/loader.ts";
import { entity } from "../../src/entities/entity-builder.ts";
import type { EntityGraph, EntityProvider } from "../../src/entities/entity-provider.ts";
import { PermissionsEngine, createEngine } from "../../src/engine.ts";
import type { EngineOptions } from "../../src/engine.options.ts";
import { MemoryPolicyStore } from "../../src/policy/memory-policy-store.ts";
import { policyRecordFromText } from "../../src/policy/policy-codec.ts";
import type { PolicyRecord, TemplateLinkRecord } from "../../src/policy/policy-store.ts";
import { stationVocabulary, type StationVocabulary } from "../fixtures/station-vocabulary.ts";

const TENANT = "org:1";
const OTHER_TENANT = "org:2";
const FIXED_TIME = new Date("2026-07-30T00:00:00.000Z");

// --------------------------------------------------------------------------
// Policies
// --------------------------------------------------------------------------

/** Global: every member may manage every project. Proves global ∪ scope (D2). */
const GLOBAL_MANAGE = `permit(principal is Station::Member, action == Station::Action::"project:manage", resource is Station::Project);`;

/** The role-grant primitive: one template, one link per (member, project). */
const READER_TEMPLATE = `permit(principal == ?principal, action == Station::Action::"run:read", resource in ?resource);`;

/** Ancestor-based: membership of a Role entity, not an attribute. */
const ADMIN_READ = `permit(principal in Station::Role::"admin", action == Station::Action::"run:read", resource is Station::Run);`;

/** Deny-overrides: archived runs are unreadable no matter who asks. */
const FORBID_ARCHIVED = `forbid(principal, action == Station::Action::"run:read", resource is Station::Run) when { resource.status == "archived" };`;

/**
 * Context-gated dispatch.
 *
 * The `context has mfa &&` guard is not stylistic: Cedar's validator reports
 * "unable to guarantee safety of access to optional attribute `mfa`" as an
 * *error* without it, so `validateOnLoad: true` rejects the unguarded form.
 */
const DISPATCH_WITH_MFA = `permit(principal is Station::Member, action == Station::Action::"run:dispatch", resource is Station::Run) when { context has mfa && context.mfa == true };`;

/** The same rule written the unsafe way — reads an optional attribute unguarded. */
const DISPATCH_WITH_MFA_UNGUARDED = `permit(principal is Station::Member, action == Station::Action::"run:dispatch", resource is Station::Run) when { context.mfa == true };`;

/** References an entity type the schema does not declare. */
const GHOST_POLICY = `permit(principal is Station::Ghost, action, resource);`;

// --------------------------------------------------------------------------
// Entities
// --------------------------------------------------------------------------

const organization = entity(stationVocabulary, "Organization", "o1", { attrs: {} });
const adminRole = entity(stationVocabulary, "Role", "admin", { attrs: {} });

const project = entity(stationVocabulary, "Project", "p1", {
	attrs: { organization: { type: "Organization", id: "o1" }, archived: false },
	parents: [{ type: "Organization", id: "o1" }],
});

function member(id: string, roles: readonly string[]): ReturnType<typeof entity> {
	return entity(stationVocabulary, "Member", id, {
		attrs: { organization: { type: "Organization", id: "o1" }, identitySubject: `sub-${id}` },
		parents: [
			...roles.map((role) => ({ type: "Role", id: role })),
			{ type: "Organization", id: "o1" },
		],
	});
}

function run(id: string, status: string): ReturnType<typeof entity> {
	return entity(stationVocabulary, "Run", id, {
		attrs: {
			project: { type: "Project", id: "p1" },
			status,
			createdBy: { type: "Member", id: "m1" },
			attempt: 1,
			labels: ["nightly"],
			// A real Date, so the builder's `__extn` datetime encoding is exercised
			// against Cedar itself rather than against a hand-written literal.
			startedAt: FIXED_TIME,
			trigger: { kind: "manual" },
		},
		parents: [{ type: "Project", id: "p1" }],
	});
}

const MEMBERS: Readonly<Record<string, readonly string[]>> = {
	m1: [],
	m2: ["admin"],
	m3: [],
};

const RUNS: Readonly<Record<string, string>> = { r1: "queued", r2: "archived" };

/** Resolves exactly the principal's ancestors and the resource's parents. */
function makeProvider(): {
	provider: EntityProvider<StationVocabulary>;
	principalCalls: string[];
	resourceCalls: string[];
} {
	const principalCalls: string[] = [];
	const resourceCalls: string[] = [];

	return {
		principalCalls,
		resourceCalls,
		provider: {
			async resolvePrincipal(request): Promise<EntityGraph> {
				principalCalls.push(request.principal.id);
				const roles = MEMBERS[request.principal.id] ?? [];
				return [
					member(request.principal.id, roles),
					...(roles.includes("admin") ? [adminRole] : []),
					organization,
				];
			},
			async resolveResource(request): Promise<EntityGraph> {
				const reference = request.resource;
				if (reference === undefined) {
					return [];
				}
				resourceCalls.push(reference.id);
				return reference.type === "Run"
					? [run(reference.id, RUNS[reference.id] ?? "queued"), project, organization]
					: [project, organization];
			},
		},
	};
}

// --------------------------------------------------------------------------
// Harness
// --------------------------------------------------------------------------

let cedar: CedarBinding;
let instanceCounter = 0;
const engines: PermissionsEngine<StationVocabulary>[] = [];

function policy(id: string, text: string, scope: string): PolicyRecord {
	return policyRecordFromText(cedar, { id, scope, text, updatedAt: FIXED_TIME });
}

function readerGrant(id = "grant:m1-p1"): TemplateLinkRecord {
	return {
		id,
		scope: TENANT,
		templateId: "role:reader",
		values: {
			"?principal": { type: "Member", id: "m1" },
			"?resource": { type: "Project", id: "p1" },
		},
		updatedAt: FIXED_TIME,
	};
}

function seedStore(): MemoryPolicyStore {
	return new MemoryPolicyStore({
		policies: [
			policy("global:manage-projects", GLOBAL_MANAGE, ""),
			policy("role:reader", READER_TEMPLATE, TENANT),
			policy("p:admin-read", ADMIN_READ, TENANT),
			policy("p:forbid-archived", FORBID_ARCHIVED, TENANT),
			policy("p:dispatch-mfa", DISPATCH_WITH_MFA, TENANT),
		],
		links: [readerGrant()],
	});
}

async function makeEngine(
	overrides: Partial<EngineOptions<StationVocabulary>> = {},
	store: MemoryPolicyStore = seedStore(),
): Promise<PermissionsEngine<StationVocabulary>> {
	instanceCounter += 1;
	const engine = await createEngine<StationVocabulary>({
		vocabulary: stationVocabulary,
		policyStore: store,
		entityProvider: makeProvider().provider,
		instanceId: `engine-it-${String(instanceCounter)}`,
		cedar,
		...overrides,
	});
	engines.push(engine);
	return engine;
}

const read = (memberId: string, runId: string) =>
	({
		scope: TENANT,
		principal: { type: "Member", id: memberId },
		action: "run:read",
		resource: { type: "Run", id: runId },
	}) as const;

const dispatch = (memberId: string, runId: string, context: { mfa?: boolean; reason: string }) =>
	({
		scope: TENANT,
		principal: { type: "Member", id: memberId },
		action: "run:dispatch",
		resource: { type: "Run", id: runId },
		context,
	}) as const;

beforeAll(async () => {
	cedar = await loadCedar();
});

afterEach(async () => {
	// Leaving preparsed ids resident would leak WASM linear memory across tests.
	while (engines.length > 0) {
		await engines.pop()?.dispose();
	}
	vi.restoreAllMocks();
});

// --------------------------------------------------------------------------

describe("decisions", () => {
	it("allows through a template link", async () => {
		const engine = await makeEngine();

		const result = await engine.check(read("m1", "r1"));

		expect(result).toMatchObject({
			allowed: true,
			decision: "allow",
			// The *link* is the determining policy, which is what proves grants
			// survive the bundle -> PolicySet -> preparse -> authorize path.
			determiningPolicyIds: ["grant:m1-p1"],
			policyErrors: [],
			scope: TENANT,
			cache: "miss",
		});
		expect(result.policySetVersion).toMatch(/^g\d+:s\d+$/);
	});

	it("denies by default when nothing permits", async () => {
		const engine = await makeEngine();

		expect(await engine.check(read("m3", "r1"))).toMatchObject({
			allowed: false,
			decision: "deny",
			determiningPolicyIds: [],
			policyErrors: [],
		});
	});

	it("lets an explicit forbid override a permit", async () => {
		const engine = await makeEngine();

		// m1 holds the reader grant for the whole project, and r2 is inside it —
		// the forbid is the only reason this is a deny.
		expect(await engine.check(read("m1", "r1"))).toMatchObject({ allowed: true });
		expect(await engine.check(read("m1", "r2"))).toMatchObject({
			allowed: false,
			determiningPolicyIds: ["p:forbid-archived"],
		});
	});

	it("permits through an ancestor the entity graph declares", async () => {
		const engine = await makeEngine();

		// m2 holds no grant at all; its only path to `allow` is `principal in
		// Station::Role::"admin"`, resolved from the parent the provider attached.
		expect(await engine.check(read("m2", "r1"))).toMatchObject({
			allowed: true,
			determiningPolicyIds: ["p:admin-read"],
		});
		expect(await engine.check(read("m3", "r1"))).toMatchObject({ allowed: false });
	});

	it("composes the global scope into the tenant's decision", async () => {
		const engine = await makeEngine();

		expect(
			await engine.check({
				scope: TENANT,
				principal: { type: "Member", id: "m3" },
				action: "project:manage",
				resource: { type: "Project", id: "p1" },
			}),
		).toMatchObject({ allowed: true, determiningPolicyIds: ["global:manage-projects"] });
	});
});

describe("context", () => {
	it("allows and denies the same request on the context alone", async () => {
		const engine = await makeEngine();

		expect(await engine.check(dispatch("m1", "r1", { mfa: true, reason: "oncall" }))).toMatchObject(
			{
				allowed: true,
				determiningPolicyIds: ["p:dispatch-mfa"],
			},
		);
		expect(
			await engine.check(dispatch("m1", "r1", { mfa: false, reason: "oncall" })),
		).toMatchObject({ allowed: false });
		expect(await engine.check(dispatch("m1", "r1", { reason: "oncall" }))).toMatchObject({
			allowed: false,
			policyErrors: [],
		});
	});

	it("rejects a wrong-typed context when validateRequests is on", async () => {
		const engine = await makeEngine();

		await expect(
			engine.checkUnsafe({
				scope: TENANT,
				principal: { type: "Member", id: "m1" },
				action: "run:dispatch",
				resource: { type: "Run", id: "r1" },
				context: { reason: 42 },
			}),
		).rejects.toMatchObject({ code: "EVALUATION_FAILED", scope: TENANT });
	});

	it("rejects a resource type the action does not apply to", async () => {
		const engine = await makeEngine();

		await expect(
			engine.checkUnsafe({
				scope: TENANT,
				principal: { type: "Member", id: "m1" },
				action: "run:read",
				resource: { type: "Project", id: "p1" },
			}),
		).rejects.toMatchObject({ code: "EVALUATION_FAILED" });
	});

	it("silently mis-evaluates the same request when validation is off", async () => {
		// This is the trap `validateOnLoad` and `validateRequests` exist to close:
		// an unguarded read of an optional context attribute *errors*, the policy is
		// dropped from the decision, and only `policyErrors` says so.
		const store = new MemoryPolicyStore({
			policies: [policy("p:dispatch-mfa", DISPATCH_WITH_MFA_UNGUARDED, TENANT)],
		});
		const engine = await makeEngine({ validateOnLoad: false, validateRequests: false }, store);

		const result = await engine.check(dispatch("m1", "r1", { reason: "oncall" }));

		expect(result.allowed).toBe(false);
		expect(result.policyErrors).toHaveLength(1);
		expect(result.policyErrors[0]).toMatchObject({ policyId: "p:dispatch-mfa" });
		expect(result.policyErrors[0]?.message).toContain("mfa");
		expect(engine.stats()).toMatchObject({ errored: 1 });
	});

	it("refuses to load that same policy set with validateOnLoad on", async () => {
		const store = new MemoryPolicyStore({
			policies: [policy("p:dispatch-mfa", DISPATCH_WITH_MFA_UNGUARDED, TENANT)],
		});
		const engine = await makeEngine({}, store);

		await expect(engine.check(dispatch("m1", "r1", { reason: "oncall" }))).rejects.toMatchObject({
			code: "POLICY_INVALID",
			scope: TENANT,
		});
	});
});

describe("validateOnLoad", () => {
	it("rejects a bundle whose policy names an unknown entity type", async () => {
		const store = seedStore();
		const engine = await makeEngine({}, store);

		expect(await engine.check(read("m1", "r1"))).toMatchObject({ allowed: true });

		await store.save([policy("p:ghost", GHOST_POLICY, TENANT)]);

		await expect(engine.check(read("m1", "r1"))).rejects.toMatchObject({
			code: "POLICY_INVALID",
			scope: TENANT,
		});
	});

	it("carries Cedar's per-policy diagnostics on the rejection", async () => {
		const store = seedStore();
		const engine = await makeEngine({}, store);
		await engine.check(read("m1", "r1"));
		await store.save([policy("p:ghost", GHOST_POLICY, TENANT)]);

		await expect(engine.check(read("m1", "r1"))).rejects.toMatchObject({
			details: expect.arrayContaining([
				expect.objectContaining({
					message: expect.stringContaining("Station::Ghost"),
					help: expect.stringContaining("did you mean"),
				}),
			]),
		});
	});

	it("keeps the previously prepared set resident and serviceable", async () => {
		const store = seedStore();
		const engine = await makeEngine({}, store);
		await engine.check(read("m1", "r1"));

		await store.save([policy("p:ghost", GHOST_POLICY, TENANT)]);
		await expect(engine.check(read("m1", "r1"))).rejects.toMatchObject({ code: "POLICY_INVALID" });

		// 2b semantics: the entry survived the failed reload rather than being
		// dropped, so the tenant is never left with an empty policy set.
		expect(engine.stats().policySets).toMatchObject({ scopes: 1, failures: 1 });

		// Removing the bad policy makes the very same scope serviceable again.
		await store.delete(TENANT, ["p:ghost"]);
		expect(await engine.check(read("m1", "r1"))).toMatchObject({
			allowed: true,
			determiningPolicyIds: ["grant:m1-p1"],
		});
	});

	it("preparses the bad set happily when turned off, because parsing is not validation", async () => {
		const store = seedStore();
		await store.save([policy("p:ghost", GHOST_POLICY, TENANT)]);
		const engine = await makeEngine({ validateOnLoad: false }, store);

		expect(await engine.check(read("m1", "r1"))).toMatchObject({ allowed: true });
	});
});

describe("validatePolicies", () => {
	it("reports a clean bundle", async () => {
		const engine = await makeEngine();

		await expect(engine.validatePolicies(TENANT)).resolves.toMatchObject({
			ok: true,
			scope: TENANT,
			errors: [],
		});
	});

	it("reports errors per policy, with Cedar's own help text", async () => {
		const store = seedStore();
		await store.save([policy("p:ghost", GHOST_POLICY, TENANT)]);
		const engine = await makeEngine({}, store);

		const report = await engine.validatePolicies(TENANT);

		expect(report.ok).toBe(false);
		expect(report.errors.map((issue) => issue.policyId)).toContain("p:ghost");
		expect(report.errors.map((issue) => issue.message).join(" ")).toContain("Station::Ghost");
		expect(report.errors[0]?.detail.help).toBeTypeOf("string");
	});

	it("surfaces warnings without failing the report", async () => {
		const store = seedStore();
		await store.save([
			policy(
				"p:impossible",
				`permit(principal is Station::Member, action == Station::Action::"run:read", resource is Station::Run) when { 1 == 2 };`,
				TENANT,
			),
		]);
		const engine = await makeEngine({}, store);

		const report = await engine.validatePolicies(TENANT);

		expect(report.ok).toBe(true);
		expect(report.warnings.map((issue) => issue.policyId)).toContain("p:impossible");
	});

	it("does not disturb the cached policy set", async () => {
		const engine = await makeEngine();
		await engine.check(read("m1", "r1"));

		await engine.validatePolicies(TENANT);

		expect(await engine.check(read("m1", "r1"))).toMatchObject({ cache: "hit" });
	});
});

describe("scope isolation", () => {
	it("does not let a tenant's grant reach another tenant", async () => {
		const engine = await makeEngine();

		expect(await engine.check(read("m1", "r1"))).toMatchObject({ allowed: true });
		expect(await engine.check({ ...read("m1", "r1"), scope: OTHER_TENANT })).toMatchObject({
			allowed: false,
			scope: OTHER_TENANT,
		});
	});

	it("still applies global policies in every scope", async () => {
		const engine = await makeEngine();

		expect(
			await engine.check({
				scope: OTHER_TENANT,
				principal: { type: "Member", id: "m1" },
				action: "project:manage",
				resource: { type: "Project", id: "p1" },
			}),
		).toMatchObject({ allowed: true, determiningPolicyIds: ["global:manage-projects"] });
	});

	it("keeps one preparsed policy set per scope", async () => {
		const engine = await makeEngine();

		await engine.check(read("m1", "r1"));
		await engine.check({ ...read("m1", "r1"), scope: OTHER_TENANT });

		expect(engine.stats().policySets).toMatchObject({ scopes: 2, preparses: 2 });
	});
});

describe("freshness", () => {
	it("reloads on the next check after a store write", async () => {
		const store = seedStore();
		const engine = await makeEngine({}, store);
		const loadSpy = vi.spyOn(store, "load");

		expect(await engine.check(read("m1", "r1"))).toMatchObject({ allowed: true, cache: "miss" });
		expect(await engine.check(read("m1", "r1"))).toMatchObject({ cache: "hit" });
		expect(loadSpy).toHaveBeenCalledTimes(1);

		// Revoking the grant emits a change event, which marks the scope stale.
		await store.unlinkTemplate(TENANT, "grant:m1-p1");

		expect(await engine.check(read("m1", "r1"))).toMatchObject({
			allowed: false,
			cache: "miss",
		});
		expect(loadSpy).toHaveBeenCalledTimes(2);

		// And the reload is not repeated once the scope is fresh again.
		expect(await engine.check(read("m1", "r1"))).toMatchObject({ cache: "hit" });
		expect(loadSpy).toHaveBeenCalledTimes(2);
	});

	it("never probes currentVersion on the check path (D1)", async () => {
		const store = seedStore();
		const engine = await makeEngine({}, store);
		const versionSpy = vi.spyOn(store, "currentVersion");

		await engine.check(read("m1", "r1"));
		await engine.check(read("m1", "r1"));
		await store.linkTemplate(readerGrant("grant:m1-p1-again"));
		await engine.check(read("m1", "r1"));

		expect(versionSpy).not.toHaveBeenCalled();
	});

	it("warm() preloads a scope so the first check is a hit", async () => {
		const store = seedStore();
		const engine = await makeEngine({}, store);
		const loadSpy = vi.spyOn(store, "load");

		await engine.warm(TENANT);

		expect(await engine.check(read("m1", "r1"))).toMatchObject({ cache: "hit", allowed: true });
		expect(loadSpy).toHaveBeenCalledTimes(1);
	});

	it("invalidate('*') forces a reload of every scope", async () => {
		const store = seedStore();
		const engine = await makeEngine({}, store);
		await engine.check(read("m1", "r1"));
		await engine.check({ ...read("m1", "r1"), scope: OTHER_TENANT });

		const loadSpy = vi.spyOn(store, "load");
		await engine.invalidate("*");
		await engine.check(read("m1", "r1"));
		await engine.check({ ...read("m1", "r1"), scope: OTHER_TENANT });

		expect(loadSpy).toHaveBeenCalledTimes(2);
	});
});

describe("entity resolution", () => {
	it("asks the provider for exactly the principal and the resource", async () => {
		const { provider, principalCalls, resourceCalls } = makeProvider();
		const engine = await makeEngine({ entityProvider: provider });

		await engine.check(read("m1", "r1"));

		expect(principalCalls).toEqual(["m1"]);
		expect(resourceCalls).toEqual(["r1"]);
	});

	it("shares one principal resolution across a batch", async () => {
		const { provider, principalCalls, resourceCalls } = makeProvider();
		const engine = await makeEngine({ entityProvider: provider });

		const results = await engine.checkMany([read("m1", "r1"), read("m1", "r2"), read("m2", "r1")]);

		expect(results.map((each) => each.allowed)).toEqual([true, false, true]);
		expect(principalCalls).toEqual(["m1", "m2"]);
		expect(resourceCalls).toEqual(["r1", "r2", "r1"]);
	});

	it("accepts a hand-built graph in place of the provider", async () => {
		const engine = await makeEngine();

		const result = await engine.check({
			...read("m2", "r1"),
			entities: [member("m2", ["admin"]), adminRole, organization, run("r1", "queued"), project],
		});

		expect(result).toMatchObject({ allowed: true, determiningPolicyIds: ["p:admin-read"] });
	});

	it("fails closed when the graph omits the ancestor a policy needs", async () => {
		const engine = await makeEngine();

		// Same member, same policies — only the missing Role parent differs.
		expect(
			await engine.check({
				...read("m2", "r1"),
				entities: [member("m2", []), run("r1", "queued"), project, organization],
			}),
		).toMatchObject({ allowed: false });
	});

	it("raises ENTITY_RESOLUTION when nothing can supply the graph", async () => {
		const engine = await makeEngine({ entityProvider: undefined });

		await expect(engine.check(read("m1", "r1"))).rejects.toMatchObject({
			code: "ENTITY_RESOLUTION",
		});

		// An explicitly empty graph is a different statement, and is allowed: a
		// policy that only tests entity *types* decides fine without a graph.
		await expect(
			engine.check({
				scope: TENANT,
				principal: { type: "Member", id: "m3" },
				action: "project:manage",
				resource: { type: "Project", id: "p1" },
				entities: [],
			}),
		).resolves.toMatchObject({ allowed: true, determiningPolicyIds: ["global:manage-projects"] });

		// A policy that traverses the hierarchy denies instead — fail-closed, which
		// is why an empty graph must be opted into rather than defaulted to.
		await expect(engine.check({ ...read("m1", "r1"), entities: [] })).resolves.toMatchObject({
			allowed: false,
			determiningPolicyIds: [],
		});
	});

	it("round-trips a Date attribute through Cedar", async () => {
		const store = new MemoryPolicyStore({
			policies: [
				policy(
					"p:started",
					`permit(principal is Station::Member, action == Station::Action::"run:read", resource is Station::Run) when { resource has startedAt && resource.startedAt < datetime("2026-08-01T00:00:00Z") };`,
					TENANT,
				),
			],
		});
		const engine = await makeEngine({}, store);

		// The builder emitted `{__extn:{fn:"datetime", arg:<ISO>}}`; Cedar compares
		// it against a `datetime(...)` literal, so the encoding is verified end to end.
		expect(await engine.check(read("m1", "r1"))).toMatchObject({
			allowed: true,
			determiningPolicyIds: ["p:started"],
		});
	});
});

describe("audit and stats", () => {
	it("reports every decision to onDecision with the context redacted", async () => {
		const events: { action: string; allowed: boolean; context?: unknown }[] = [];
		const engine = await makeEngine({
			onDecision: (event) => {
				if (event.type !== "check") {
					return;
				}
				events.push({ action: event.action, allowed: event.allowed, context: event.context });
			},
		});

		await engine.check(read("m1", "r1"));
		await engine.check(dispatch("m1", "r1", { mfa: true, reason: "oncall" }));

		expect(events).toEqual([
			{ action: "run:read", allowed: true, context: undefined },
			{
				action: "run:dispatch",
				allowed: true,
				context: { mfa: "[redacted]", reason: "[redacted]" },
			},
		]);
	});

	it("moves the counters", async () => {
		const engine = await makeEngine();

		await engine.checkMany([read("m1", "r1"), read("m3", "r1"), read("m2", "r1")]);

		expect(engine.stats()).toMatchObject({
			checks: 3,
			allows: 2,
			denies: 1,
			errored: 0,
			namespace: "Station",
			disposed: false,
			policySets: { scopes: 1, loads: 1, preparses: 1 },
			schema: { registered: 1, preparses: 1 },
			entities: undefined,
		});
		expect(engine.stats().schema.name).toMatch(/^vocab-/);
	});

	it("counts entity-cache activity when the cache is enabled", async () => {
		const engine = await makeEngine({ entityCache: { ttlMs: 60_000 } });

		await engine.check(read("m1", "r1"));
		await engine.check(read("m1", "r2"));

		expect(engine.stats().entities).toMatchObject({ hits: 1, misses: 1, entries: 1 });
	});
});

describe("lifecycle", () => {
	it("is terminal after dispose", async () => {
		const engine = await makeEngine();
		await engine.check(read("m1", "r1"));

		await engine.dispose();

		expect(engine.disposed).toBe(true);
		await expect(engine.check(read("m1", "r1"))).rejects.toMatchObject({ code: "ENGINE_INIT" });
	});

	it("lets a second engine own its own policy-set ids", async () => {
		const store = seedStore();
		const first = await makeEngine({}, store);
		const second = await makeEngine({}, store);

		expect(await first.check(read("m1", "r1"))).toMatchObject({ allowed: true });
		await first.dispose();

		// Disposing one engine empties only the ids it owns; the other is untouched.
		expect(await second.check(read("m1", "r1"))).toMatchObject({ allowed: true });
	});

	it("validates the vocabulary schema at creation", async () => {
		await expect(
			PermissionsEngine.create({
				vocabulary: {
					...stationVocabulary,
					cedarSchemaJson: {
						Station: { entityTypes: { Run: { memberOfTypes: ["Ghost"] } }, actions: {} },
					},
				},
				policyStore: seedStore(),
				cedar,
			}),
		).rejects.toMatchObject({ code: "SCHEMA_INVALID" });
	});
});
