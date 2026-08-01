import { afterAll, beforeAll, bench, describe } from "vitest";

import { isCedarFailure, formatDetailedErrors } from "../../src/cedar/answers.ts";
import type {
	AuthorizationCall,
	CedarBinding,
	EntityJson,
	PartialAuthorizationCall,
	StatefulAuthorizationCall,
} from "../../src/cedar/binding.ts";
import { loadCedar } from "../../src/cedar/loader.ts";
import { actionUid, entityRefToUid } from "../../src/cedar/uid.ts";
import { entity } from "../../src/entities/entity-builder.ts";
import type { EntityGraph, EntityProvider } from "../../src/entities/entity-provider.ts";
import { PermissionsEngine, createEngine } from "../../src/engine.ts";
import { MemoryPolicyStore } from "../../src/policy/memory-policy-store.ts";
import { policyRecordFromText } from "../../src/policy/policy-codec.ts";
import { buildPolicySet } from "../../src/policy/policy-set-builder.ts";
import type { PolicyRecord } from "../../src/policy/policy-store.ts";
import { stationVocabulary, type StationVocabulary } from "../fixtures/station-vocabulary.ts";

/**
 * The four measurements docs/design/core.md §0 rests on, re-run on whatever
 * hardware and cedar-wasm the repository currently has.
 *
 * Mandatory preparse, the plan cache and the narrow entity graph are not style
 * choices — each is the direct consequence of one number below. Reproducing them
 * is what turns "the Cedar bump regressed the hot path 20x" from a production
 * surprise into a diff in a benchmark report. Nothing is asserted: `vitest bench`
 * prints, a human compares against the §0 figure quoted beside each bench.
 *
 * Benches 1-3 call the **raw binding** on purpose. §0 measured Cedar itself;
 * routing them through `PermissionsEngine` would fold entity resolution, policy
 * store lookups and the preparse cache into numbers whose whole job is to
 * isolate a single WASM call. Bench 4 is the opposite case — the plan cache is a
 * JS-side structure, so it can only be measured through `engine.plan()`.
 *
 * Run with:
 *   pnpm --filter @nestm/permissions-core exec vitest bench --run --dir tests/bench
 *
 * `--dir` rather than a name filter: `vitest.config.ts` pins `test.include` but
 * leaves `benchmark.include` at its default `**\/*.bench.ts`, and `tsc -b` emits a
 * compiled copy of this file to `dist-tsc/tests/bench/`. A path *filter* matches
 * both and reports every number twice; `--dir` never looks outside `tests/bench`.
 */

const TENANT = "org:1";
const FIXED_TIME = new Date("2026-07-30T00:00:00.000Z");
const NAMESPACE = stationVocabulary.namespace;

/** §0 measured "40 policies"; the generator below emits exactly that (n = 0..39). */
const POLICY_COUNT = 40;

/** The bloat pair from §0: a 10-entity slice against a 500-entity one. */
const SMALL_GRAPH = 10;
const LARGE_GRAPH = 500;

/** WASM policy-set id for the raw-binding benches. Owned by this file alone. */
const PSET_ID = "bench:40-policies";

// --------------------------------------------------------------------------
// Entities
//
// Four of them decide the check — the principal, its organisation, the run and
// the run's project. Everything past that is padding, and padding is the point:
// bench 3 exists to show what Cedar charges for entities the decision never
// reads.
// --------------------------------------------------------------------------

const organization = entity(stationVocabulary, "Organization", "o1", { attrs: {} });

const project = entity(stationVocabulary, "Project", "p1", {
	attrs: { organization: { type: "Organization", id: "o1" }, archived: false },
	parents: [{ type: "Organization", id: "o1" }],
});

const member = entity(stationVocabulary, "Member", "m1", {
	attrs: { organization: { type: "Organization", id: "o1" }, identitySubject: "sub-m1" },
	parents: [{ type: "Organization", id: "o1" }],
});

/** `attempt` is the last value the generated policy set permits, so the check allows. */
const subject = entity(stationVocabulary, "Run", "r1", {
	attrs: {
		project: { type: "Project", id: "p1" },
		status: "queued",
		createdBy: { type: "Member", id: "m1" },
		attempt: POLICY_COUNT - 1,
		labels: ["nightly"],
		trigger: { kind: "manual" },
	},
	parents: [{ type: "Project", id: "p1" }],
});

/**
 * The decision plus `size - 4` entities nothing references: not the request, not
 * a policy, not another entity's parent list. Cedar still has to ingest them.
 *
 * The padding is attribute-free `Role`s rather than more `Run`s so the pair
 * isolates the variable §0 named — the *number* of irrelevant entities — instead
 * of also varying how much attribute payload each one carries.
 */
function graphOf(size: number): EntityJson[] {
	const filler = Array.from({ length: size - 4 }, (_unused, index) =>
		entity(stationVocabulary, "Role", `noise-${String(index)}`, { attrs: {} }),
	);
	return [member, organization, project, subject, ...filler];
}

const smallGraph = graphOf(SMALL_GRAPH);
const largeGraph = graphOf(LARGE_GRAPH);

// --------------------------------------------------------------------------
// Policies
// --------------------------------------------------------------------------

/**
 * One permit per `attempt` value, so the set is 40 policies Cedar considers
 * individually rather than one policy with a 40-arm disjunction — 40 is the
 * count every §0 authorization figure was taken at.
 *
 * `action` is parameterised only because bench 4 needs `run:dispatch`: it is the
 * one action in the vocabulary that declares a context, and varying the context
 * is how the cold-cache arm forces a plan-cache miss without changing the work.
 */
function benchPolicies(cedar: CedarBinding, action: string): readonly PolicyRecord[] {
	return Array.from({ length: POLICY_COUNT }, (_unused, attempt) =>
		policyRecordFromText(cedar, {
			id: `p:attempt-${String(attempt)}`,
			scope: TENANT,
			text:
				`permit(principal, action == Station::Action::"${action}", resource) ` +
				`when { resource.attempt == ${String(attempt)} };`,
			updatedAt: FIXED_TIME,
		}),
	);
}

// --------------------------------------------------------------------------
// Harness
// --------------------------------------------------------------------------

let cedar: CedarBinding;
let statelessCall: AuthorizationCall;
let partialCall: PartialAuthorizationCall;

const principal = entityRefToUid({ type: "Member", id: "m1" }, NAMESPACE);
const readAction = actionUid(NAMESPACE, "run:read");
const resource = entityRefToUid({ type: "Run", id: "r1" }, NAMESPACE);

/**
 * No `schema` and no `validateRequest` on any of the three raw calls.
 *
 * Request validation is a per-call cost that lands differently on each call
 * shape — the stateful one takes a *preparsed* schema name, the other two take
 * the schema inline — so leaving it off is what keeps the three numbers a
 * comparison of policy evaluation rather than of validation plumbing.
 */
const statefulSmall: StatefulAuthorizationCall = {
	principal,
	action: readAction,
	resource,
	context: {},
	entities: smallGraph,
	preparsedPolicySetId: PSET_ID,
};

const statefulLarge: StatefulAuthorizationCall = { ...statefulSmall, entities: largeGraph };

const planRequest = {
	scope: TENANT,
	principal: { type: "Member", id: "m1" },
	action: "run:dispatch",
	resourceType: "Run",
} as const;

/** Bumped per iteration so the "miss" bench never reuses a plan-cache key. */
let missNonce = 0;

const provider: EntityProvider<StationVocabulary> = {
	async resolvePrincipal(): Promise<EntityGraph> {
		return [member, organization];
	},
};

const engines: PermissionsEngine<StationVocabulary>[] = [];

async function makeEngine(
	instanceId: string,
	policies: readonly PolicyRecord[],
): Promise<PermissionsEngine<StationVocabulary>> {
	const engine = await createEngine<StationVocabulary>({
		vocabulary: stationVocabulary,
		policyStore: new MemoryPolicyStore({ policies: [...policies] }),
		entityProvider: provider,
		instanceId,
		cedar,
		// The 30 s default TTL is shorter than a warmup-plus-run cycle can be on a
		// loaded machine, and an entry expiring mid-bench would silently turn the
		// "hit" measurement into a mixture of both arms.
		planCache: { ttlMs: 3_600_000 },
	});
	engines.push(engine);
	return engine;
}

let hitEngine: PermissionsEngine<StationVocabulary>;
let missEngine: PermissionsEngine<StationVocabulary>;

beforeAll(async () => {
	cedar = await loadCedar();

	const checkPolicies = benchPolicies(cedar, "run:read");
	const planPolicies = benchPolicies(cedar, "run:dispatch");
	const policySet = buildPolicySet(
		{ scope: TENANT, version: "bench", policies: checkPolicies, links: [] },
		{ namespace: NAMESPACE },
	);

	// §0's figures are "at 40 policies", so the count is load-bearing, not incidental.
	const count = Object.keys(policySet.staticPolicies ?? {}).length;
	if (count !== POLICY_COUNT) {
		throw new Error(`expected ${String(POLICY_COUNT)} policies, built ${String(count)}`);
	}

	// The one preparse. Benches must never pay for it: charging the 14.6x win's
	// own setup to the hot loop is exactly the mistake this number disproves.
	const preparsed = cedar.preparsePolicySet(PSET_ID, policySet);
	if (isCedarFailure(preparsed)) {
		throw new Error(`preparsePolicySet failed: ${formatDetailedErrors(preparsed.errors)}`);
	}

	statelessCall = {
		principal,
		action: readAction,
		resource,
		context: {},
		policies: policySet,
		entities: smallGraph,
	};

	partialCall = {
		principal,
		action: readAction,
		// The unknown. Everything else stays concrete, so the residuals are the
		// 40 `attempt == n` comparisons and nothing else.
		resource: null,
		context: {},
		policies: policySet,
		entities: [member, organization],
	};

	hitEngine = await makeEngine("bench-plan-hit", planPolicies);
	missEngine = await makeEngine("bench-plan-miss", planPolicies);

	// Probe rather than assert: the two plan benches are only meaningful if one
	// genuinely hits and the other genuinely misses, and a silent inversion would
	// read as "the cache buys nothing".
	await hitEngine.plan({ ...planRequest, context: { reason: "oncall" } });
	const warm = await hitEngine.plan({ ...planRequest, context: { reason: "oncall" } });
	if (warm.diagnostics.cache !== "hit") {
		throw new Error(`the warm plan bench would not hit: got "${warm.diagnostics.cache}"`);
	}

	for (let probe = 0; probe < 2; probe += 1) {
		missNonce += 1;
		const cold = await missEngine.plan({
			...planRequest,
			context: { reason: `miss-${String(missNonce)}` },
		});
		if (cold.diagnostics.cache !== "miss") {
			throw new Error(`the cold plan bench would not miss: got "${cold.diagnostics.cache}"`);
		}
	}
});

afterAll(async () => {
	while (engines.length > 0) {
		await engines.pop()?.dispose();
	}
});

// --------------------------------------------------------------------------
// 1. Preparse — the 14.6x win that makes `statefulIsAuthorized` mandatory
// --------------------------------------------------------------------------

describe("§0 preparse: statefulIsAuthorized vs isAuthorized (40 policies)", () => {
	// §0: 0.136 ms/op
	bench("statefulIsAuthorized — preparsed policy set", () => {
		cedar.statefulIsAuthorized(statefulSmall);
	});

	// §0: 1.98 ms/op — 14.6x the preparsed call, all of it re-parsing.
	bench("isAuthorized — policy set inline", () => {
		cedar.isAuthorized(statelessCall);
	});
});

// --------------------------------------------------------------------------
// 2. Partial evaluation — why the plan cache is a requirement
// --------------------------------------------------------------------------

describe("§0 partial evaluation: isAuthorizedPartial cannot preparse", () => {
	// §0: 2.28 ms/op. `PartialAuthorizationCall` has no `preparsedPolicySetId`
	// field, so the policy set travels inline on every call and there is no
	// preparsed variant to compare against — roughly 17 stateful checks per plan,
	// which is the entire justification for `PlanCache`.
	bench("isAuthorizedPartial — policy set inline, resource unknown", () => {
		cedar.isAuthorizedPartial(partialCall);
	});
});

// --------------------------------------------------------------------------
// 3. Entity-graph bloat — why an EntityProvider returns a slice, not a graph
// --------------------------------------------------------------------------

describe("§0 entity bloat: 10 vs 500 entities, same decision", () => {
	// §0: 0.136 ms/op. Identical to the preparsed bench above by construction —
	// it is the baseline the 500-entity arm is measured against.
	bench("statefulIsAuthorized — 10 entities", () => {
		cedar.statefulIsAuthorized(statefulSmall);
	});

	// §0: 2.79 ms/op — ~20x, paid for 490 entities no policy reads.
	bench("statefulIsAuthorized — 500 entities", () => {
		cedar.statefulIsAuthorized(statefulLarge);
	});
});

// --------------------------------------------------------------------------
// 4. Plan cache — hit vs miss
// --------------------------------------------------------------------------

describe("plan cache: warm vs cold", () => {
	// A hit still resolves the principal graph on every call: the plan cache sits
	// behind entity resolution, which is why `entityCache` and `PlanRequest.entities`
	// exist. This is what a cached `plan()` really costs a request.
	bench("engine.plan() — plan-cache hit", async () => {
		await hitEngine.plan({ ...planRequest, context: { reason: "oncall" } });
	});

	// A fresh `context` per iteration is a clean miss: the key covers it, and
	// changing it changes nothing about the work partial evaluation has to do.
	// The floor is bench 2's 2.28 ms — a miss *is* an `isAuthorizedPartial` plus
	// residual compilation.
	bench("engine.plan() — plan-cache miss", async () => {
		missNonce += 1;
		await missEngine.plan({
			...planRequest,
			context: { reason: `miss-${String(missNonce)}` },
		});
	});
});
