import { afterEach, describe, expect, it, vi } from "vitest";

import type {
	AuthorizationAnswer,
	AuthorizationCall,
	CedarBinding,
	CheckParseAnswer,
	Expr,
	PartialAuthorizationAnswer,
	PartialAuthorizationCall,
	PolicyJson,
	PolicySet,
	ResidualResponse,
	Schema,
	StatefulAuthorizationCall,
	ValidationAnswer,
	ValidationCall,
	ValidationError,
} from "../../src/cedar/binding.ts";
import { entity } from "../../src/entities/entity-builder.ts";
import type {
	EntityGraph,
	EntityProvider,
	EntityResolutionRequest,
} from "../../src/entities/entity-provider.ts";
import { PermissionsEngine, createEngine } from "../../src/engine.ts";
import type { EngineOptions } from "../../src/engine.options.ts";
import { MemoryPolicyStore } from "../../src/policy/memory-policy-store.ts";
import { PERMIT_ALL, policyRecord } from "../fixtures/policy-fixtures.ts";
import { stationVocabulary, type StationVocabulary } from "../fixtures/station-vocabulary.ts";

const TENANT = "org:1";
const OTHER_TENANT = "org:2";

/** cedar-wasm's verified wording for an id it has never preparsed. */
const NOT_FOUND_MESSAGE = "preparsed policy set 'whatever' not found";

function allow(reason: readonly string[] = ["p:permit-all"]): AuthorizationAnswer {
	return {
		type: "success",
		response: { decision: "allow", diagnostics: { reason: [...reason], errors: [] } },
		warnings: [],
	};
}

function deny(): AuthorizationAnswer {
	return {
		type: "success",
		response: { decision: "deny", diagnostics: { reason: [], errors: [] } },
		warnings: [],
	};
}

function erroredAllow(): AuthorizationAnswer {
	return {
		type: "success",
		response: {
			decision: "allow",
			diagnostics: {
				reason: ["p:permit-all"],
				errors: [
					{
						policyId: "p:forbid-archived",
						error: {
							message: "record does not have the attribute `archived`",
							help: null,
							code: null,
							url: null,
							severity: null,
						},
					},
				],
			},
		},
		warnings: [],
	};
}

/** `resource.status == <value>` in the shape partial evaluation emits. */
function statusIs(value: string): Expr {
	return {
		"==": {
			left: { ".": { left: { unknown: [{ Value: "resource" }] }, attr: "status" } },
			right: { Value: value },
		},
	};
}

function residualPolicy(effect: "permit" | "forbid", body: Expr): PolicyJson {
	return {
		effect,
		principal: { op: "All" },
		action: { op: "All" },
		resource: { op: "All" },
		conditions: [{ kind: "when", body }],
	};
}

/** A `PartialAuthorizationAnswer` with sane defaults; `{}` gives one residual permit. */
function residuals(overrides: Partial<ResidualResponse> = {}): PartialAuthorizationAnswer {
	return {
		type: "residuals",
		response: {
			decision: null,
			satisfied: [],
			errored: [],
			mayBeDetermining: ["p:permit-all"],
			mustBeDetermining: [],
			residuals: { "p:permit-all": residualPolicy("permit", statusIs("done")) },
			nontrivialResiduals: ["p:permit-all"],
			...overrides,
		},
		warnings: [],
	};
}

function notFound(): AuthorizationAnswer {
	return {
		type: "failure",
		errors: [{ message: NOT_FOUND_MESSAGE, help: null, code: null, url: null, severity: null }],
		warnings: [],
	};
}

/**
 * A `CedarBinding` that records every call and answers from a script.
 *
 * The whole point of the binding seam (core.md §6): the engine's wiring, retry
 * and lifecycle are testable without instantiating 4.1 MiB of WASM, so these
 * tests stay fast and can drive failure modes the real Cedar will not produce on
 * demand.
 */
class StubCedar implements CedarBinding {
	readonly schemaPreparses: { name: string; schema: Schema }[] = [];
	readonly policySetPreparses: { psetId: string; policies: PolicySet }[] = [];
	readonly authorizations: StatefulAuthorizationCall[] = [];
	readonly partials: PartialAuthorizationCall[] = [];
	readonly validations: ValidationCall[] = [];

	/** Answers consumed in order; the last one repeats once the queue drains. */
	answers: AuthorizationAnswer[] = [allow()];
	/** Partial-evaluation answers, same protocol. */
	partialAnswers: PartialAuthorizationAnswer[] = [residuals()];
	/** Validation errors `validate()` reports. */
	validationErrors: ValidationError[] = [];

	statefulIsAuthorized(call: StatefulAuthorizationCall): AuthorizationAnswer {
		this.authorizations.push(call);
		return (this.answers.length > 1 ? this.answers.shift() : this.answers[0]) ?? deny();
	}

	preparsePolicySet(psetId: string, policies: PolicySet): CheckParseAnswer {
		this.policySetPreparses.push({ psetId, policies });
		return { type: "success" };
	}

	preparseSchema(schemaName: string, schema: Schema): CheckParseAnswer {
		this.schemaPreparses.push({ name: schemaName, schema });
		return { type: "success" };
	}

	validate(call: ValidationCall): ValidationAnswer {
		this.validations.push(call);
		return {
			type: "success",
			validationErrors: [...this.validationErrors],
			validationWarnings: [],
			otherWarnings: [],
		};
	}

	getCedarLangVersion(): string {
		return "4.5";
	}

	isAuthorized(_call: AuthorizationCall): AuthorizationAnswer {
		throw new Error("StubCedar: isAuthorized is not part of the check path");
	}

	isAuthorizedPartial(call: PartialAuthorizationCall): PartialAuthorizationAnswer {
		this.partials.push(call);
		return (
			(this.partialAnswers.length > 1 ? this.partialAnswers.shift() : this.partialAnswers[0]) ??
			residuals()
		);
	}
	policyToJson(): never {
		throw new Error("StubCedar: policyToJson is not part of the check path");
	}
	policyToText(): never {
		throw new Error("StubCedar: policyToText is not part of the check path");
	}
	templateToJson(): never {
		throw new Error("StubCedar: templateToJson is not part of the check path");
	}
	templateToText(): never {
		throw new Error("StubCedar: templateToText is not part of the check path");
	}
	schemaToText(): never {
		throw new Error("StubCedar: schemaToText is not part of the check path");
	}
	checkParseSchema(): CheckParseAnswer {
		return { type: "success" };
	}
	formatPolicies(): never {
		throw new Error("StubCedar: formatPolicies is not part of the check path");
	}

	/**
	 * The policy-set ids this stub was asked to empty.
	 *
	 * Identified by shape, not by emptiness: `buildPolicySet` always emits all
	 * three keys (a scope with no policies still preparses `{staticPolicies:{},
	 * templates:{}, templateLinks:[]}`), while the eviction primitive passes
	 * `{staticPolicies:{}}` alone.
	 */
	get emptied(): string[] {
		return this.policySetPreparses
			.filter(({ policies }) => Object.keys(policies).length === 1)
			.map(({ psetId }) => psetId);
	}
}

const engines: PermissionsEngine<StationVocabulary>[] = [];

function seedStore(): MemoryPolicyStore {
	return new MemoryPolicyStore({
		policies: [policyRecord({ id: "p:permit-all", scope: TENANT, cedarJson: PERMIT_ALL })],
	});
}

async function makeEngine(
	overrides: Partial<EngineOptions<StationVocabulary>> = {},
	cedar = new StubCedar(),
	store = seedStore(),
): Promise<{
	engine: PermissionsEngine<StationVocabulary>;
	cedar: StubCedar;
	store: MemoryPolicyStore;
}> {
	const engine = await createEngine<StationVocabulary>({
		vocabulary: stationVocabulary,
		policyStore: store,
		cedar,
		instanceId: "engine-under-test",
		...overrides,
	});
	engines.push(engine);
	return { engine, cedar, store };
}

const readRun = {
	scope: TENANT,
	principal: { type: "Member", id: "m1" },
	action: "run:read",
	resource: { type: "Run", id: "r1" },
} as const;

function memberGraph(id: string): EntityGraph {
	return [
		entity(stationVocabulary, "Member", id, {
			attrs: { organization: { type: "Organization", id: "o1" }, identitySubject: `sub-${id}` },
		}),
	];
}

function stubProvider(
	overrides: Omit<EntityProvider<StationVocabulary>, "resolvePrincipal"> = {},
): { provider: EntityProvider<StationVocabulary>; resolvePrincipal: ReturnType<typeof vi.fn> } {
	const resolvePrincipal = vi.fn(
		async (request: EntityResolutionRequest<StationVocabulary>): Promise<EntityGraph> =>
			memberGraph(request.principal.id),
	);

	return { provider: { resolvePrincipal, ...overrides }, resolvePrincipal };
}

afterEach(async () => {
	while (engines.length > 0) {
		await engines.pop()?.dispose();
	}
	vi.restoreAllMocks();
});

describe("create", () => {
	it("preparses the vocabulary schema exactly once and loads no policies", async () => {
		const store = seedStore();
		const loadSpy = vi.spyOn(store, "load");
		const { cedar, engine } = await makeEngine({}, new StubCedar(), store);

		expect(cedar.schemaPreparses).toHaveLength(1);
		expect(cedar.schemaPreparses[0]?.name).toMatch(/^vocab-[\da-f]{16}$/);
		expect(cedar.schemaPreparses[0]?.schema).toBe(stationVocabulary.cedarSchemaJson);
		expect(loadSpy).not.toHaveBeenCalled();
		expect(cedar.policySetPreparses).toHaveLength(0);
		expect(engine.vocabulary).toBe(stationVocabulary);
	});

	it("reports zeroed counters before the first check", async () => {
		const { engine } = await makeEngine();

		expect(engine.stats()).toMatchObject({
			instanceId: "engine-under-test",
			namespace: "Station",
			checks: 0,
			allows: 0,
			denies: 0,
			errored: 0,
			disposed: false,
			entities: undefined,
			schema: { registered: 1, preparses: 1 },
		});
	});

	it("surfaces a schema Cedar rejects as SCHEMA_INVALID", async () => {
		const cedar = new StubCedar();
		vi.spyOn(cedar, "preparseSchema").mockReturnValue({
			type: "failure",
			errors: [{ message: "bad schema", help: null, code: null, url: null, severity: null }],
		});

		await expect(
			PermissionsEngine.create({
				vocabulary: stationVocabulary,
				policyStore: seedStore(),
				cedar,
			}),
		).rejects.toMatchObject({ code: "SCHEMA_INVALID" });
	});

	it("generates a distinct instanceId per engine when none is given", async () => {
		const first = await makeEngine({ instanceId: undefined });
		const second = await makeEngine({ instanceId: undefined });

		expect(first.engine.instanceId).toMatch(/^perm-/);
		expect(first.engine.instanceId).not.toBe(second.engine.instanceId);
	});
});

describe("check", () => {
	it("builds the Cedar call from the vocabulary", async () => {
		const { engine, cedar } = await makeEngine();

		await engine.check({ ...readRun, entities: [] });

		expect(cedar.authorizations[0]).toEqual({
			principal: { type: "Station::Member", id: "m1" },
			action: { type: "Station::Action", id: "run:read" },
			resource: { type: "Station::Run", id: "r1" },
			context: {},
			entities: [],
			preparsedPolicySetId: `engine-under-test:${TENANT}`,
			preparsedSchemaName: cedar.schemaPreparses[0]?.name,
			validateRequest: true,
		});
	});

	it("maps the Cedar response onto CheckResult", async () => {
		const { engine } = await makeEngine({ clock: () => 1_000 });

		const result = await engine.check({ ...readRun, entities: [] });

		expect(result).toEqual({
			allowed: true,
			decision: "allow",
			determiningPolicyIds: ["p:permit-all"],
			policyErrors: [],
			scope: TENANT,
			policySetVersion: "g0:s1",
			durationMs: 0,
			cache: "miss",
		});
		expect(Object.isFrozen(result)).toBe(true);
	});

	it("measures durationMs with the configured clock", async () => {
		let now = 0;
		const { engine } = await makeEngine({ clock: () => (now += 10) });

		const result = await engine.check({ ...readRun, entities: [] });

		expect(result.durationMs).toBeGreaterThan(0);
		expect(result.durationMs % 10).toBe(0);
	});

	it("reports the second check as a cache hit", async () => {
		const { engine, store } = await makeEngine();
		const loadSpy = vi.spyOn(store, "load");

		await engine.check({ ...readRun, entities: [] });
		const second = await engine.check({ ...readRun, entities: [] });

		expect(second.cache).toBe("hit");
		expect(loadSpy).toHaveBeenCalledTimes(1);
	});

	it("maps a deny with no determining policies", async () => {
		const cedar = new StubCedar();
		cedar.answers = [deny()];
		const { engine } = await makeEngine({}, cedar);

		expect(await engine.check({ ...readRun, entities: [] })).toMatchObject({
			allowed: false,
			decision: "deny",
			determiningPolicyIds: [],
		});
	});

	it("surfaces errored policies alongside the decision", async () => {
		const cedar = new StubCedar();
		cedar.answers = [erroredAllow()];
		const { engine } = await makeEngine({}, cedar);

		const result = await engine.check({ ...readRun, entities: [] });

		// An errored forbid is dropped from the decision, so this list is the only
		// signal that the `allow` may be wrong.
		expect(result.allowed).toBe(true);
		expect(result.policyErrors).toEqual([
			{
				policyId: "p:forbid-archived",
				message: "record does not have the attribute `archived`",
				detail: expect.objectContaining({
					message: "record does not have the attribute `archived`",
				}),
			},
		]);
		expect(engine.stats()).toMatchObject({ errored: 1 });
	});

	it("passes a converted context through", async () => {
		const { engine, cedar } = await makeEngine();

		await engine.check({
			scope: TENANT,
			principal: { type: "Member", id: "m1" },
			action: "run:dispatch",
			resource: { type: "Run", id: "r1" },
			context: { mfa: true, reason: "oncall" },
			entities: [],
		});

		expect(cedar.authorizations[0]?.context).toEqual({ mfa: true, reason: "oncall" });
	});

	it("omits the schema when validateRequests is off", async () => {
		const { engine, cedar } = await makeEngine({ validateRequests: false });

		await engine.check({ ...readRun, entities: [] });

		expect(cedar.authorizations[0]).not.toHaveProperty("preparsedSchemaName");
		expect(cedar.authorizations[0]).not.toHaveProperty("validateRequest");
	});

	it("raises a Cedar failure as EVALUATION_FAILED", async () => {
		const cedar = new StubCedar();
		cedar.answers = [
			{
				type: "failure",
				errors: [
					{
						message: "context `{reason: 42}` is not valid",
						help: null,
						code: null,
						url: null,
						severity: null,
					},
				],
				warnings: [],
			},
		];
		const { engine } = await makeEngine({}, cedar);

		await expect(engine.check({ ...readRun, entities: [] })).rejects.toMatchObject({
			code: "EVALUATION_FAILED",
			scope: TENANT,
		});
	});
});

describe("policy set disappearing under us", () => {
	it("re-preparses once and retries, then succeeds", async () => {
		const cedar = new StubCedar();
		cedar.answers = [notFound(), allow()];
		const store = seedStore();
		const loadSpy = vi.spyOn(store, "load");
		const { engine } = await makeEngine({}, cedar, store);

		const result = await engine.check({ ...readRun, entities: [] });

		expect(result.allowed).toBe(true);
		// Exactly two authorization calls: the failed one and the retry.
		expect(cedar.authorizations).toHaveLength(2);
		expect(cedar.authorizations[1]?.preparsedPolicySetId).toBe(
			cedar.authorizations[0]?.preparsedPolicySetId,
		);
		// Exactly one re-ensure: a second load and a second populating preparse.
		expect(loadSpy).toHaveBeenCalledTimes(2);
		expect(engine.stats().policySets).toMatchObject({ loads: 2, preparses: 2 });
	});

	it("gives up with POLICY_SET_NOT_PREPARED when the retry fails too", async () => {
		const cedar = new StubCedar();
		cedar.answers = [notFound()];
		const { engine } = await makeEngine({}, cedar);

		await expect(engine.check({ ...readRun, entities: [] })).rejects.toMatchObject({
			code: "POLICY_SET_NOT_PREPARED",
			scope: TENANT,
		});
		expect(cedar.authorizations).toHaveLength(2);
	});

	it("names the duplicate-copy cause, which is what actually produces it", async () => {
		const cedar = new StubCedar();
		cedar.answers = [notFound()];
		const { engine } = await makeEngine({}, cedar);

		await expect(engine.check({ ...readRun, entities: [] })).rejects.toThrowError(
			/more than one copy of @nestm\/permissions-core/,
		);
	});

	it("does not retry a failure that is not about a missing policy set", async () => {
		const cedar = new StubCedar();
		cedar.answers = [
			{
				type: "failure",
				errors: [
					{ message: "entity not found", help: null, code: null, url: null, severity: null },
				],
				warnings: [],
			},
		];
		const { engine } = await makeEngine({}, cedar);

		await expect(engine.check({ ...readRun, entities: [] })).rejects.toMatchObject({
			code: "EVALUATION_FAILED",
		});
		expect(cedar.authorizations).toHaveLength(1);
	});
});

describe("entity resolution", () => {
	it("throws ENTITY_RESOLUTION with neither entities nor a provider", async () => {
		const { engine } = await makeEngine();

		await expect(engine.check(readRun)).rejects.toMatchObject({
			code: "ENTITY_RESOLUTION",
			scope: TENANT,
		});
	});

	it("accepts an explicitly empty graph as a decision that needs none", async () => {
		const { engine, cedar } = await makeEngine();

		await expect(engine.check({ ...readRun, entities: [] })).resolves.toMatchObject({
			allowed: true,
		});
		expect(cedar.authorizations[0]?.entities).toEqual([]);
	});

	it("calls the provider with the request it is deciding", async () => {
		const { provider, resolvePrincipal } = stubProvider();
		const { engine } = await makeEngine({ entityProvider: provider });

		await engine.check(readRun);

		expect(resolvePrincipal).toHaveBeenCalledExactlyOnceWith({
			scope: TENANT,
			principal: { type: "Member", id: "m1" },
			action: "run:read",
			resource: { type: "Run", id: "r1" },
			resourceType: "Run",
		});
	});

	it("merges principal, resource and additional graphs, deduplicated", async () => {
		const shared = entity(stationVocabulary, "Organization", "o1", { attrs: {} });
		const { provider } = stubProvider({
			resolveResource: async () => [
				shared,
				entity(stationVocabulary, "Run", "r1", {
					attrs: {
						project: { type: "Project", id: "p1" },
						status: "queued",
						createdBy: { type: "Member", id: "m1" },
						attempt: 1,
						labels: [],
						trigger: { kind: "manual" },
					},
				}),
			],
			resolveAdditional: async () => [shared],
		});
		const { engine, cedar } = await makeEngine({ entityProvider: provider });

		await engine.check(readRun);

		expect(cedar.authorizations[0]?.entities.map((each) => each.uid)).toEqual([
			{ type: "Station::Member", id: "m1" },
			{ type: "Station::Organization", id: "o1" },
			{ type: "Station::Run", id: "r1" },
		]);
	});

	it("prefers explicit entities over the provider", async () => {
		const { provider, resolvePrincipal } = stubProvider();
		const { engine } = await makeEngine({ entityProvider: provider });

		await engine.check({ ...readRun, entities: [] });

		expect(resolvePrincipal).not.toHaveBeenCalled();
	});

	it("deduplicates an explicitly supplied graph", async () => {
		const { engine, cedar } = await makeEngine();
		const duplicated = [...memberGraph("m1"), ...memberGraph("m1")];

		await engine.check({ ...readRun, entities: duplicated });

		expect(cedar.authorizations[0]?.entities).toHaveLength(1);
	});
});

describe("checkMany", () => {
	it("shares one ensure per scope and one resolution per principal", async () => {
		const { provider, resolvePrincipal } = stubProvider();
		const store = seedStore();
		const loadSpy = vi.spyOn(store, "load");
		const { engine } = await makeEngine({ entityProvider: provider }, new StubCedar(), store);

		const results = await engine.checkMany([
			readRun,
			{ ...readRun, resource: { type: "Run", id: "r2" } },
			{ ...readRun, resource: { type: "Run", id: "r3" } },
		]);

		expect(results).toHaveLength(3);
		expect(loadSpy).toHaveBeenCalledTimes(1);
		expect(resolvePrincipal).toHaveBeenCalledTimes(1);
	});

	it("resolves once per distinct principal", async () => {
		const { provider, resolvePrincipal } = stubProvider();
		const { engine } = await makeEngine({ entityProvider: provider });

		await engine.checkMany([
			readRun,
			{ ...readRun, principal: { type: "Member", id: "m2" } },
			{ ...readRun, principal: { type: "Member", id: "m1" } },
		]);

		expect(resolvePrincipal).toHaveBeenCalledTimes(2);
	});

	it("does not share a principal across scopes", async () => {
		const { provider, resolvePrincipal } = stubProvider();
		const { engine } = await makeEngine({ entityProvider: provider });

		await engine.checkMany([readRun, { ...readRun, scope: OTHER_TENANT }]);

		expect(resolvePrincipal).toHaveBeenCalledTimes(2);
	});

	it("loads each distinct scope once", async () => {
		const store = seedStore();
		const loadSpy = vi.spyOn(store, "load");
		const { engine } = await makeEngine({}, new StubCedar(), store);

		await engine.checkMany([
			{ ...readRun, entities: [] },
			{ ...readRun, scope: OTHER_TENANT, entities: [] },
			{ ...readRun, entities: [] },
		]);

		expect(loadSpy).toHaveBeenCalledTimes(2);
	});

	it("returns results in request order", async () => {
		const cedar = new StubCedar();
		cedar.answers = [allow(["a"]), deny(), allow(["c"])];
		const { engine } = await makeEngine({}, cedar);

		const results = await engine.checkMany([
			{ ...readRun, entities: [] },
			{ ...readRun, entities: [] },
			{ ...readRun, entities: [] },
		]);

		expect(results.map((each) => each.allowed)).toEqual([true, false, true]);
		expect(results.map((each) => each.determiningPolicyIds)).toEqual([["a"], [], ["c"]]);
	});

	it("accepts an empty batch", async () => {
		const { engine } = await makeEngine();

		await expect(engine.checkMany([])).resolves.toEqual([]);
	});
});

describe("checkUnsafe", () => {
	it("accepts plain strings and produces the same call", async () => {
		const { engine, cedar } = await makeEngine();

		const result = await engine.checkUnsafe({
			scope: TENANT,
			principal: { type: "Member", id: "m1" },
			action: "run:read",
			resource: { type: "Run", id: "r1" },
			entities: [],
		});

		expect(result.allowed).toBe(true);
		expect(cedar.authorizations[0]?.action).toEqual({ type: "Station::Action", id: "run:read" });
	});

	it("forwards an action the vocabulary never declared, which is the trade", async () => {
		const { engine, cedar } = await makeEngine();

		await engine.checkUnsafe({
			scope: TENANT,
			principal: { type: "Member", id: "m1" },
			action: "run:delete",
			resource: { type: "Run", id: "r1" },
			entities: [],
		});

		expect(cedar.authorizations[0]?.action).toEqual({ type: "Station::Action", id: "run:delete" });
	});
});

describe("onDecision", () => {
	it("fires with the request, the result and a redacted context", async () => {
		const onDecision = vi.fn();
		const { engine } = await makeEngine({ onDecision, clock: () => 1_000 });

		await engine.check({
			scope: TENANT,
			principal: { type: "Member", id: "m1" },
			action: "run:dispatch",
			resource: { type: "Run", id: "r1" },
			context: { mfa: true, reason: "oncall" },
			entities: [],
		});

		expect(onDecision).toHaveBeenCalledExactlyOnceWith({
			type: "check",
			allowed: true,
			decision: "allow",
			determiningPolicyIds: ["p:permit-all"],
			policyErrors: [],
			scope: TENANT,
			policySetVersion: "g0:s1",
			durationMs: 0,
			cache: "miss",
			principal: { type: "Member", id: "m1" },
			action: "run:dispatch",
			resource: { type: "Run", id: "r1" },
			context: { mfa: "[redacted]", reason: "[redacted]" },
		});
	});

	it("omits the context key entirely when the request had none", async () => {
		const onDecision = vi.fn<(event: { context?: unknown }) => void>();
		const { engine } = await makeEngine({ onDecision });

		await engine.check({ ...readRun, entities: [] });

		expect(onDecision.mock.calls[0]?.[0]).not.toHaveProperty("context");
	});

	it("uses a custom redactor", async () => {
		const onDecision = vi.fn<(event: { context?: unknown }) => void>();
		const { engine } = await makeEngine({
			onDecision,
			redactContext: (context: unknown) => ({
				keys: context !== null && typeof context === "object" ? Object.keys(context).length : 0,
			}),
		});

		await engine.check({
			scope: TENANT,
			principal: { type: "Member", id: "m1" },
			action: "run:dispatch",
			resource: { type: "Run", id: "r1" },
			context: { mfa: true, reason: "oncall" },
			entities: [],
		});

		expect(onDecision.mock.calls[0]?.[0]?.context).toEqual({ keys: 2 });
	});

	it("swallows a sink that throws without touching the decision", async () => {
		const onDecision = vi.fn(() => {
			throw new Error("audit sink is down");
		});
		const { engine } = await makeEngine({ onDecision });

		await expect(engine.check({ ...readRun, entities: [] })).resolves.toMatchObject({
			allowed: true,
		});
		expect(onDecision).toHaveBeenCalledTimes(1);
	});

	it("swallows a redactor that throws", async () => {
		const onDecision = vi.fn();
		const { engine } = await makeEngine({
			onDecision,
			redactContext: () => {
				throw new Error("redactor exploded");
			},
		});

		await expect(
			engine.check({
				scope: TENANT,
				principal: { type: "Member", id: "m1" },
				action: "run:dispatch",
				resource: { type: "Run", id: "r1" },
				context: { reason: "oncall" },
				entities: [],
			}),
		).resolves.toMatchObject({ allowed: true });
		expect(onDecision).not.toHaveBeenCalled();
	});

	it("fires once per request in a batch", async () => {
		const onDecision = vi.fn();
		const { engine } = await makeEngine({ onDecision });

		await engine.checkMany([
			{ ...readRun, entities: [] },
			{ ...readRun, entities: [] },
		]);

		expect(onDecision).toHaveBeenCalledTimes(2);
	});
});

describe("validateOnLoad", () => {
	it("validates every policy set it loads", async () => {
		const { engine, cedar } = await makeEngine();

		await engine.check({ ...readRun, entities: [] });

		expect(cedar.validations).toHaveLength(1);
		expect(cedar.validations[0]?.schema).toBe(stationVocabulary.cedarSchemaJson);
		expect(Object.keys(cedar.validations[0]?.policies.staticPolicies ?? {})).toEqual([
			"p:permit-all",
		]);
	});

	it("rejects the load when Cedar reports a validation error", async () => {
		const cedar = new StubCedar();
		cedar.validationErrors = [
			{
				policyId: "p:permit-all",
				error: {
					message: "unrecognized entity type `Station::Ghost`",
					help: null,
					code: null,
					url: null,
					severity: null,
				},
			},
		];
		const { engine } = await makeEngine({}, cedar);

		await expect(engine.check({ ...readRun, entities: [] })).rejects.toMatchObject({
			code: "POLICY_INVALID",
			scope: TENANT,
		});
		// Nothing reached the WASM: no set was preparsed under the scope's id.
		expect(cedar.policySetPreparses).toHaveLength(0);
		expect(engine.stats().policySets).toMatchObject({ scopes: 0, failures: 1 });
	});

	it("carries Cedar's diagnostics on the thrown error", async () => {
		const cedar = new StubCedar();
		cedar.validationErrors = [
			{
				policyId: "p:permit-all",
				error: { message: "bad policy", help: "fix it", code: null, url: null, severity: null },
			},
		];
		const { engine } = await makeEngine({}, cedar);

		await expect(engine.check({ ...readRun, entities: [] })).rejects.toMatchObject({
			details: [expect.objectContaining({ message: "bad policy", help: "fix it" })],
		});
	});

	it("skips validation entirely when turned off", async () => {
		const cedar = new StubCedar();
		cedar.validationErrors = [
			{
				policyId: "p:permit-all",
				error: { message: "bad policy", help: null, code: null, url: null, severity: null },
			},
		];
		const { engine } = await makeEngine({ validateOnLoad: false }, cedar);

		await expect(engine.check({ ...readRun, entities: [] })).resolves.toMatchObject({
			allowed: true,
		});
		expect(cedar.validations).toHaveLength(0);
	});
});

describe("validatePolicies", () => {
	it("reports a clean bundle", async () => {
		const { engine } = await makeEngine();

		await expect(engine.validatePolicies(TENANT)).resolves.toEqual({
			ok: true,
			scope: TENANT,
			version: "g0:s1",
			errors: [],
			warnings: [],
			otherWarnings: [],
		});
	});

	it("reports errors per policy without preparsing anything", async () => {
		const cedar = new StubCedar();
		cedar.validationErrors = [
			{
				policyId: "p:permit-all",
				error: { message: "too broad", help: "narrow it", code: null, url: null, severity: null },
			},
		];
		const { engine } = await makeEngine({}, cedar);

		const report = await engine.validatePolicies(TENANT);

		expect(report.ok).toBe(false);
		expect(report.errors).toEqual([
			{
				policyId: "p:permit-all",
				message: "too broad",
				detail: expect.objectContaining({ help: "narrow it" }),
			},
		]);
		expect(cedar.policySetPreparses).toHaveLength(0);
	});
});

describe("entity cache", () => {
	it("is off by default, so every check re-resolves", async () => {
		const { provider, resolvePrincipal } = stubProvider();
		const { engine } = await makeEngine({ entityProvider: provider });

		await engine.check(readRun);
		await engine.check(readRun);

		expect(resolvePrincipal).toHaveBeenCalledTimes(2);
		expect(engine.stats().entities).toBeUndefined();
	});

	it("reuses a principal graph across requests when enabled", async () => {
		const { provider, resolvePrincipal } = stubProvider();
		const { engine } = await makeEngine({ entityProvider: provider, entityCache: {} });

		await engine.check(readRun);
		await engine.check(readRun);

		expect(resolvePrincipal).toHaveBeenCalledTimes(1);
		expect(engine.stats().entities).toMatchObject({ hits: 1, misses: 1, entries: 1 });
	});

	it("is dropped by a policy change event", async () => {
		const { provider, resolvePrincipal } = stubProvider();
		const store = seedStore();
		const { engine } = await makeEngine(
			{ entityProvider: provider, entityCache: {} },
			new StubCedar(),
			store,
		);

		await engine.check(readRun);
		await store.save([policyRecord({ id: "p:extra", scope: TENANT, cedarJson: PERMIT_ALL })]);
		await engine.check(readRun);

		expect(resolvePrincipal).toHaveBeenCalledTimes(2);
	});

	it("is dropped by invalidateEntity", async () => {
		const { provider, resolvePrincipal } = stubProvider();
		const { engine } = await makeEngine({ entityProvider: provider, entityCache: {} });

		await engine.check(readRun);
		expect(engine.invalidateEntity({ type: "Member", id: "m1" })).toBe(1);
		await engine.check(readRun);

		expect(resolvePrincipal).toHaveBeenCalledTimes(2);
	});

	it("reports zero invalidations when the cache is off", async () => {
		const { engine } = await makeEngine();

		expect(engine.invalidateEntity({ type: "Member", id: "m1" })).toBe(0);
	});
});

describe("warm and invalidate", () => {
	it("warm preloads a scope", async () => {
		const store = seedStore();
		const loadSpy = vi.spyOn(store, "load");
		const { engine } = await makeEngine({}, new StubCedar(), store);

		await engine.warm(TENANT);
		const result = await engine.check({ ...readRun, entities: [] });

		expect(loadSpy).toHaveBeenCalledTimes(1);
		expect(result.cache).toBe("hit");
	});

	it("invalidate forces the next check to reload", async () => {
		const store = seedStore();
		const { engine } = await makeEngine({}, new StubCedar(), store);
		await engine.check({ ...readRun, entities: [] });

		const loadSpy = vi.spyOn(store, "load");
		await engine.invalidate(TENANT);
		const result = await engine.check({ ...readRun, entities: [] });

		expect(loadSpy).toHaveBeenCalledTimes(1);
		expect(result.cache).toBe("miss");
	});

	it("invalidate('*') reaches every cached scope", async () => {
		const store = seedStore();
		const { engine } = await makeEngine({}, new StubCedar(), store);
		await engine.check({ ...readRun, entities: [] });
		await engine.check({ ...readRun, scope: OTHER_TENANT, entities: [] });

		const loadSpy = vi.spyOn(store, "load");
		await engine.invalidate("*");
		await engine.check({ ...readRun, entities: [] });
		await engine.check({ ...readRun, scope: OTHER_TENANT, entities: [] });

		expect(loadSpy).toHaveBeenCalledTimes(2);
	});
});

describe("plan", () => {
	const planRun = {
		scope: TENANT,
		principal: { type: "Member", id: "m1" },
		action: "run:read",
		resourceType: "Run",
		entities: [],
	} as const;

	it("leaves the resource unknown and passes the policies inline", async () => {
		// Partial evaluation has no `preparsedPolicySetId`, so the policy set has to
		// travel on every call — which is exactly why the plan cache exists.
		const { engine, cedar } = await makeEngine();

		await engine.plan(planRun);

		expect(cedar.partials).toHaveLength(1);
		expect(cedar.partials[0]).toMatchObject({
			principal: { type: "Station::Member", id: "m1" },
			action: { type: "Station::Action", id: "run:read" },
			resource: null,
			validateRequest: true,
		});
		expect(cedar.partials[0]?.policies).toMatchObject({
			staticPolicies: { "p:permit-all": PERMIT_ALL },
		});
		expect("preparsedPolicySetId" in (cedar.partials[0] ?? {})).toBe(false);
	});

	it("omits the schema when validateRequests is off", async () => {
		const { engine, cedar } = await makeEngine({ validateRequests: false });

		await engine.plan(planRun);

		expect(cedar.partials[0]?.schema).toBeUndefined();
		expect(cedar.partials[0]?.validateRequest).toBeUndefined();
	});

	it("compiles the residual into a CONDITIONAL plan", async () => {
		const { engine } = await makeEngine();

		const plan = await engine.plan(planRun);

		expect(plan).toMatchObject({ kind: "CONDITIONAL", resourceType: "Run", approximations: [] });
		expect(plan.kind === "CONDITIONAL" && plan.condition).toEqual({
			op: "cmp",
			cmp: "eq",
			attr: { root: "resource", path: ["status"] },
			value: { kind: "string", value: "done" },
		});
		expect(plan.diagnostics).toMatchObject({
			residualPolicyIds: ["p:permit-all"],
			erroredPolicyIds: [],
			policySetVersion: expect.any(String),
			cache: "miss",
		});
	});

	it("maps Cedar's determined decisions straight through", async () => {
		const cedar = new StubCedar();
		cedar.partialAnswers = [
			residuals({ decision: "allow", nontrivialResiduals: [] }),
			residuals({ decision: "deny", nontrivialResiduals: [] }),
		];
		const { engine } = await makeEngine({}, cedar);

		expect((await engine.plan(planRun)).kind).toBe("ALWAYS_ALLOW");
		expect((await engine.plan({ ...planRun, action: "run:dispatch" })).kind).toBe("ALWAYS_DENY");
	});

	it("explains itself", async () => {
		const { engine } = await makeEngine();

		const explanation = (await engine.plan(planRun)).diagnostics.explain();

		expect(explanation).toContain("CONDITIONAL");
		expect(explanation).toContain('Member::"m1"');
		expect(explanation).toContain('where resource.status == "done"');
		expect(explanation).toContain("residual policies: p:permit-all");
	});

	it("reports a 'plan' DecisionEvent with the context redacted", async () => {
		const events: unknown[] = [];
		const { engine } = await makeEngine({
			onDecision: (event) => {
				events.push(event);
			},
		});

		await engine.plan({
			...planRun,
			action: "run:dispatch",
			context: { mfa: true, reason: "oncall" },
		});

		expect(events).toEqual([
			expect.objectContaining({
				type: "plan",
				scope: TENANT,
				principal: { type: "Member", id: "m1" },
				action: "run:dispatch",
				resourceType: "Run",
				kind: "CONDITIONAL",
				approximations: [],
				context: { mfa: "[redacted]", reason: "[redacted]" },
			}),
		]);
	});

	// -------------------------------------------------------------------------
	// Caching
	// -------------------------------------------------------------------------

	it("serves the second identical plan from the cache", async () => {
		const { engine, cedar } = await makeEngine();

		const first = await engine.plan(planRun);
		const second = await engine.plan(planRun);

		expect(cedar.partials).toHaveLength(1);
		expect(first.diagnostics.cache).toBe("miss");
		expect(second.diagnostics.cache).toBe("hit");
		expect(engine.stats().planCache).toMatchObject({ hits: 1, misses: 1, entries: 1 });
	});

	it("keys on the action, the resource type, the principal and the context", async () => {
		const { engine, cedar } = await makeEngine();

		await engine.plan(planRun);
		await engine.plan({ ...planRun, action: "run:dispatch" });
		await engine.plan({ ...planRun, resourceType: "Run", principal: { type: "Member", id: "m2" } });
		await engine.plan({ ...planRun, action: "run:dispatch", context: { reason: "x" } });

		expect(cedar.partials).toHaveLength(4);
	});

	it("keys on the resolved entity graph, not just the principal id", async () => {
		const { provider, resolvePrincipal } = stubProvider();
		const { engine, cedar } = await makeEngine({ entityProvider: provider });

		await engine.plan({ ...planRun, entities: undefined });
		// A role granted elsewhere: same principal, different graph, different plan.
		resolvePrincipal.mockResolvedValueOnce([
			...memberGraph("m1"),
			entity(stationVocabulary, "Role", "admin", { attrs: {} }),
		]);
		await engine.plan({ ...planRun, entities: undefined });

		expect(cedar.partials).toHaveLength(2);
	});

	it("drops cached plans when the store reports a change", async () => {
		const store = seedStore();
		const { engine, cedar } = await makeEngine({}, new StubCedar(), store);

		await engine.plan(planRun);
		await store.save([policyRecord({ id: "p:another", scope: TENANT, cedarJson: PERMIT_ALL })]);
		await engine.plan(planRun);

		// A stale plan filters by policies that no longer apply, so it is dropped
		// rather than served.
		expect(cedar.partials).toHaveLength(2);
	});

	it("drops cached plans on invalidate", async () => {
		const { engine, cedar } = await makeEngine();

		await engine.plan(planRun);
		await engine.invalidate(TENANT);
		await engine.plan(planRun);

		expect(cedar.partials).toHaveLength(2);
	});

	it("drops cached plans on invalidate('*')", async () => {
		const { engine, cedar } = await makeEngine();

		await engine.plan(planRun);
		await engine.invalidate("*");
		await engine.plan(planRun);

		expect(cedar.partials).toHaveLength(2);
	});

	// -------------------------------------------------------------------------
	// Entity resolution
	// -------------------------------------------------------------------------

	it("resolves the principal graph and never asks for a resource", async () => {
		const resolveResource = vi.fn(async () => []);
		const resolveAdditional = vi.fn(async () => []);
		const { provider, resolvePrincipal } = stubProvider({ resolveResource, resolveAdditional });
		const { engine } = await makeEngine({ entityProvider: provider });

		await engine.plan({ ...planRun, entities: undefined });

		expect(resolvePrincipal).toHaveBeenCalledWith(
			expect.objectContaining({ scope: TENANT, action: "run:read", resourceType: "Run" }),
		);
		// There is no resource instance to resolve — that is the whole point.
		expect(resolvePrincipal.mock.calls[0]?.[0]).not.toHaveProperty("resource");
		expect(resolveResource).not.toHaveBeenCalled();
		expect(resolveAdditional).toHaveBeenCalledTimes(1);
	});

	it("fails closed with no entities and no provider", async () => {
		const { engine } = await makeEngine();

		await expect(engine.plan({ ...planRun, entities: undefined })).rejects.toMatchObject({
			code: "ENTITY_RESOLUTION",
		});
	});

	// -------------------------------------------------------------------------
	// The fail-closed contract
	// -------------------------------------------------------------------------

	const nested: Expr = {
		"==": {
			left: {
				".": {
					left: { ".": { left: { unknown: [{ Value: "resource" }] }, attr: "trigger" } },
					attr: "kind",
				},
			},
			right: { Value: "manual" },
		},
	};

	it("throws UNSUPPORTED_RESIDUAL for an untranslatable permit", async () => {
		const cedar = new StubCedar();
		cedar.partialAnswers = [residuals({ residuals: { p1: residualPolicy("permit", nested) } })];
		const { engine } = await makeEngine({}, cedar);

		await expect(engine.plan(planRun)).rejects.toMatchObject({
			code: "UNSUPPORTED_RESIDUAL",
			policyId: "p1",
			effect: "permit",
			reason: "nested-attribute",
			resourceType: "Run",
			action: "run:read",
		});
	});

	it("attaches a post-filter when configured, and re-checks through the engine", async () => {
		const cedar = new StubCedar();
		cedar.partialAnswers = [
			residuals({
				residuals: {
					p1: residualPolicy("permit", {
						"&&": { left: statusIs("done"), right: nested },
					}),
				},
			}),
		];
		cedar.answers = [allow(), deny()];
		const { engine } = await makeEngine({ unsupportedResidual: "post-filter" }, cedar);

		const plan = await engine.plan(planRun);

		expect(plan.kind).toBe("CONDITIONAL");
		expect(plan.approximations[0]).toMatchObject({ direction: "permissive" });

		const postFilter = plan.kind === "CONDITIONAL" ? plan.postFilter : undefined;
		expect(postFilter).toBeTypeOf("function");

		const rows = [{ id: "r1" }, { id: "r2" }];
		await expect(
			postFilter?.(rows, { rowToResource: (row) => ({ type: "Run", id: row.id }) }),
		).resolves.toEqual([rows[0]]);
	});

	it("caps the post-filter", async () => {
		const cedar = new StubCedar();
		cedar.partialAnswers = [residuals({ residuals: { p1: residualPolicy("permit", nested) } })];
		const { engine } = await makeEngine(
			{ unsupportedResidual: "post-filter", maxPostFilterRows: 1 },
			cedar,
		);

		const plan = await engine.plan(planRun);
		const postFilter = plan.kind === "CONDITIONAL" ? plan.postFilter : undefined;

		await expect(
			postFilter?.([{ id: "a" }, { id: "b" }], {
				rowToResource: (row) => ({ type: "Run", id: row.id }),
			}),
		).rejects.toMatchObject({ code: "POST_FILTER_OVERFLOW", rows: 2, maxRows: 1 });
	});

	it("records a restrictive approximation for an untranslatable forbid", async () => {
		const cedar = new StubCedar();
		cedar.partialAnswers = [
			residuals({
				residuals: {
					p1: residualPolicy("permit", statusIs("done")),
					f1: residualPolicy("forbid", nested),
				},
			}),
		];
		const { engine } = await makeEngine({}, cedar);

		const plan = await engine.plan(planRun);

		// A widened forbid, negated, blocks everything — over-blocking, never
		// over-sharing.
		expect(plan.kind).toBe("ALWAYS_DENY");
		expect(plan.approximations).toEqual([
			expect.objectContaining({ policyId: "f1", direction: "restrictive" }),
		]);
		expect(plan.diagnostics.explain()).toContain("! restrictive:");
	});

	it("throws ERRORED_POLICY by default", async () => {
		const cedar = new StubCedar();
		cedar.partialAnswers = [
			residuals({
				errored: ["f1"],
				residuals: { f1: residualPolicy("forbid", { Value: false }) },
			}),
		];
		const { engine } = await makeEngine({}, cedar);

		await expect(engine.plan(planRun)).rejects.toMatchObject({
			code: "ERRORED_POLICY",
			policyIds: ["f1"],
		});
	});

	it("denies everything under onErroredPolicy: 'deny-all'", async () => {
		const cedar = new StubCedar();
		cedar.partialAnswers = [
			residuals({
				errored: ["f1"],
				residuals: { f1: residualPolicy("forbid", { Value: false }) },
			}),
		];
		const { engine } = await makeEngine({ onErroredPolicy: "deny-all" }, cedar);

		const plan = await engine.plan(planRun);

		expect(plan.kind).toBe("ALWAYS_DENY");
		expect(plan.diagnostics.erroredPolicyIds).toEqual(["f1"]);
	});

	it("surfaces a Cedar failure as EVALUATION_FAILED", async () => {
		const cedar = new StubCedar();
		cedar.partialAnswers = [
			{
				type: "failure",
				errors: [{ message: "nope", help: null, code: null, url: null, severity: null }],
				warnings: [],
			},
		];
		const { engine } = await makeEngine({}, cedar);

		await expect(engine.plan(planRun)).rejects.toMatchObject({ code: "EVALUATION_FAILED" });
	});

	it("refuses to plan on a disposed engine", async () => {
		const { engine } = await makeEngine();
		await engine.dispose();

		await expect(engine.plan(planRun)).rejects.toMatchObject({ code: "ENGINE_INIT" });
	});

	it("moves the plan counters", async () => {
		const cedar = new StubCedar();
		cedar.partialAnswers = [
			residuals(),
			residuals({
				residuals: {
					p1: residualPolicy("permit", statusIs("done")),
					f1: residualPolicy("forbid", nested),
				},
			}),
		];
		const { engine } = await makeEngine({}, cedar);

		await engine.plan(planRun);
		await engine.plan({ ...planRun, action: "run:dispatch" });

		expect(engine.stats()).toMatchObject({ plans: 2, approximated: 1 });
	});
});

describe("stats", () => {
	it("counts allows, denies and total checks", async () => {
		const cedar = new StubCedar();
		cedar.answers = [allow(), deny(), allow()];
		const { engine } = await makeEngine({}, cedar);

		await engine.checkMany([
			{ ...readRun, entities: [] },
			{ ...readRun, entities: [] },
			{ ...readRun, entities: [] },
		]);

		expect(engine.stats()).toMatchObject({ checks: 3, allows: 2, denies: 1, errored: 0 });
	});

	it("nests the policy-set cache counters", async () => {
		const { engine } = await makeEngine();
		await engine.check({ ...readRun, entities: [] });
		await engine.check({ ...readRun, entities: [] });

		expect(engine.stats().policySets).toMatchObject({
			hits: 1,
			misses: 1,
			loads: 1,
			preparses: 1,
			scopes: 1,
		});
	});
});

describe("dispose", () => {
	it("empties every owned policy-set id", async () => {
		const cedar = new StubCedar();
		const { engine } = await makeEngine({}, cedar);
		await engine.check({ ...readRun, entities: [] });
		await engine.check({ ...readRun, scope: OTHER_TENANT, entities: [] });

		await engine.dispose();

		expect(cedar.emptied).toEqual([
			`engine-under-test:${TENANT}`,
			`engine-under-test:${OTHER_TENANT}`,
		]);
	});

	it("refuses every subsequent operation with ENGINE_INIT", async () => {
		const { engine } = await makeEngine();
		await engine.dispose();

		const disposed = { code: "ENGINE_INIT" };
		await expect(engine.check({ ...readRun, entities: [] })).rejects.toMatchObject(disposed);
		await expect(engine.checkMany([])).rejects.toMatchObject(disposed);
		await expect(
			engine.checkUnsafe({ ...readRun, principal: { type: "Member", id: "m1" }, entities: [] }),
		).rejects.toMatchObject(disposed);
		await expect(engine.warm(TENANT)).rejects.toMatchObject(disposed);
		await expect(engine.invalidate(TENANT)).rejects.toMatchObject(disposed);
		await expect(engine.validatePolicies(TENANT)).rejects.toMatchObject(disposed);
	});

	it("is idempotent and still reports stats", async () => {
		const cedar = new StubCedar();
		const { engine } = await makeEngine({}, cedar);
		await engine.check({ ...readRun, entities: [] });

		await engine.dispose();
		await engine.dispose();

		expect(cedar.emptied).toHaveLength(1);
		expect(engine.disposed).toBe(true);
		expect(engine.stats()).toMatchObject({ disposed: true, checks: 1 });
	});

	it("unsubscribes both subscriptions", async () => {
		const store = seedStore();
		const unsubscribe = vi.fn();
		const watchSpy = vi.spyOn(store, "watch").mockReturnValue(unsubscribe);
		const { engine } = await makeEngine({}, new StubCedar(), store);

		// Two: the policy-set cache subscribes for its own staleness, and the engine
		// subscribes to *drop* compiled plans — a stale plan filters by policies that
		// no longer apply, so it cannot be served the way a stale policy set can.
		expect(watchSpy).toHaveBeenCalledTimes(2);

		await engine.dispose();
		await engine.dispose();

		expect(unsubscribe).toHaveBeenCalledTimes(2);
	});

	it("unsubscribes both subscriptions when the entity cache is on", async () => {
		const store = seedStore();
		const unsubscribe = vi.fn();
		const watchSpy = vi.spyOn(store, "watch").mockReturnValue(unsubscribe);
		const { engine } = await makeEngine({ entityCache: {} }, new StubCedar(), store);

		expect(watchSpy).toHaveBeenCalledTimes(2);

		await engine.dispose();

		expect(unsubscribe).toHaveBeenCalledTimes(2);
	});
});
