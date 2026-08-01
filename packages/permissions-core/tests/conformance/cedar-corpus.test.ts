import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { policySetTextToParts, schemaToJson } from "@cedar-policy/cedar-wasm/nodejs";
import { beforeAll, describe, expect, it } from "vitest";

import { isCedarFailure } from "../../src/cedar/answers.ts";
import type {
	AuthorizationCall,
	CedarBinding,
	Context,
	Entities,
	EntityUid,
	PolicyJson,
	PolicySet,
	SchemaJson,
	TypeAndId,
} from "../../src/cedar/binding.ts";
import { loadCedar } from "../../src/cedar/loader.ts";
import { actionUid, entityRefToUid, normalizeEntityUid } from "../../src/cedar/uid.ts";
import { PermissionsEngine } from "../../src/engine.ts";
import { MemoryPolicyStore } from "../../src/policy/memory-policy-store.ts";
import { policyRecordFromText } from "../../src/policy/policy-codec.ts";
import { GLOBAL_POLICY_SCOPE, type PolicyRecord } from "../../src/policy/policy-store.ts";
import type { AnyVocabulary } from "../../src/vocabulary/types.ts";

/**
 * The Cedar team's own integration-test corpus, run against this package.
 *
 * Every other suite here asserts what *we* believe Cedar does. This one asserts
 * it against the reference: 24 handwritten cases plus 7 600 machine-generated
 * ones from `cedar-policy/cedar-integration-tests`, each a policy set, a schema,
 * an entity store and a list of requests with the decision, the determining
 * policies and the errored policies Cedar itself produces. A cedar-wasm bump
 * that changes an answer fails here, loudly, with the offending case named.
 *
 * Two levels, because they prove different things:
 *
 *   * **binding** (§B) drives `CedarBinding.isAuthorized` directly. This is the
 *     conformance claim: the Cedar we ship agrees with the Cedar upstream ships.
 *     It is the substantial majority — every discovered case runs.
 *   * **engine** (§C) drives the same cases through `PermissionsEngine`, so a
 *     wrapper bug (namespace qualification, policy-id naming, context coercion,
 *     entity passthrough) shows up as a changed decision. Only the ~15% of
 *     generated cases that declare a namespace are mappable — `resolveEngineOptions`
 *     rejects an empty one — and that shortfall is reported, not hidden.
 *
 * The corpus is a **build-time fetch**: `references/` is gitignored, so a clone
 * with no corpus must fail loudly rather than pass vacuously. See
 * `tests/conformance/README.md` for the refresh commands and the pinned commit.
 */

// ---------------------------------------------------------------------------
// Corpus location
// ---------------------------------------------------------------------------

const CORPUS_ROOT = fileURLToPath(new URL("../../references/cedar-corpus/", import.meta.url));
const GENERATED_DIR = "corpus-tests";
const GENERATED_TARBALL = "corpus-tests.tar.gz";
const HANDWRITTEN_DIR = "tests";

const REFRESH_COMMAND = [
	"cd packages/permissions-core/references",
	"rm -rf cedar-corpus",
	"git clone --depth 1 https://github.com/cedar-policy/cedar-integration-tests cedar-corpus",
	"cd cedar-corpus && tar xzf corpus-tests.tar.gz",
].join("\n  ");

/**
 * Refuses to run without the corpus.
 *
 * Skipping would be worse than failing: a green suite that checked nothing is
 * exactly the outcome a conformance test exists to prevent.
 */
function requireCorpus(): void {
	if (!existsSync(CORPUS_ROOT)) {
		throw new Error(
			`The Cedar integration-test corpus is missing from ${CORPUS_ROOT}. It is gitignored, so a ` +
				`fresh clone has to fetch it:\n\n  ${REFRESH_COMMAND}\n`,
		);
	}

	if (existsSync(path.join(CORPUS_ROOT, GENERATED_DIR))) {
		return;
	}

	throw new Error(
		existsSync(path.join(CORPUS_ROOT, GENERATED_TARBALL))
			? `The generated corpus is still packed. Extract it:\n\n  cd packages/permissions-core/` +
					`references/cedar-corpus && tar xzf ${GENERATED_TARBALL}\n`
			: `The corpus at ${CORPUS_ROOT} has neither ${GENERATED_DIR}/ nor ${GENERATED_TARBALL}. ` +
					`Re-fetch it:\n\n  ${REFRESH_COMMAND}\n`,
	);
}

// ---------------------------------------------------------------------------
// Case shape
//
// Paths inside a case are relative to the corpus root, never to the case file.
// ---------------------------------------------------------------------------

interface CorpusRequest {
	readonly description: string;
	readonly principal: EntityUid;
	readonly action: EntityUid;
	readonly resource: EntityUid;
	readonly context?: Context;
	readonly validateRequest?: boolean;
	readonly decision: "allow" | "deny";
	/** Determining policies, as a set. */
	readonly reason?: readonly string[];
	/** Policies that errored while evaluating, as a set. */
	readonly errors?: readonly string[];
}

interface CorpusCase {
	readonly policies: string;
	readonly policyFormat?: "cedar" | "json";
	readonly entities: string;
	readonly schema: string;
	readonly schemaFormat?: "cedar" | "json";
	readonly shouldValidate?: boolean;
	readonly requests: readonly CorpusRequest[];
}

/**
 * Reads a corpus file.
 *
 * The corpus is a pinned fixture, not user input: its shape is fixed by the
 * upstream repository, and a change to it must surface as a loud failure rather
 * than as a defensive parse that quietly runs nothing. The one shape question
 * that genuinely varies — "is this `.json` a case or a side file?" — is answered
 * by {@link isCorpusCase}; everything else is asserted straight through.
 */
// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- `T` is the assertion, not an inference
function readJson<T>(relativePath: string): T {
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- pinned fixture, see above
	return JSON.parse(readFileSync(path.join(CORPUS_ROOT, relativePath), "utf8")) as T;
}

/**
 * A `.json` in the corpus is a case iff it carries a `requests` array.
 *
 * `tests/example_use_cases/` mixes cases with side files the cases *reference*
 * (`policies_2a.cedar.json`, `schema_2a.json`), and every generated case has an
 * `<sha>.entities.json` beside it. Filtering on the filename alone would pick up
 * the side files; filtering on `requests` cannot.
 */
function isCorpusCase(value: unknown): value is CorpusCase {
	return (
		typeof value === "object" &&
		value !== null &&
		"requests" in value &&
		Array.isArray(value.requests)
	);
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/** `tests/<group>/*.json`, minus the side files. */
function discoverHandwrittenCases(): readonly string[] {
	const found: string[] = [];

	for (const group of readdirSync(path.join(CORPUS_ROOT, HANDWRITTEN_DIR)).toSorted()) {
		const groupDir = path.join(HANDWRITTEN_DIR, group);
		if (!existsSync(path.join(CORPUS_ROOT, groupDir))) {
			continue;
		}

		for (const file of readdirSync(path.join(CORPUS_ROOT, groupDir)).toSorted()) {
			if (!file.endsWith(".json") || file.endsWith(".entities.json")) {
				continue;
			}
			const relative = path.join(groupDir, file);
			if (isCorpusCase(readJson<unknown>(relative))) {
				found.push(relative);
			}
		}
	}

	return found;
}

/** `corpus-tests/<sha>.json`, minus the `<sha>.entities.json` siblings. */
function discoverGeneratedCases(): readonly string[] {
	return readdirSync(path.join(CORPUS_ROOT, GENERATED_DIR))
		.filter((file) => file.endsWith(".json") && !file.endsWith(".entities.json"))
		.toSorted()
		.map((file) => path.join(GENERATED_DIR, file));
}

// ---------------------------------------------------------------------------
// Limits
//
// Both are *reported* caps, never silent truncation: the totals block always
// states how many cases a limit held back, so a shortened run cannot be mistaken
// for a full one.
// ---------------------------------------------------------------------------

/** Generated cases the binding sweep runs. Unset means all 7 600. */
const CASE_LIMIT = readLimit("CEDAR_CORPUS_LIMIT", Number.POSITIVE_INFINITY);

/**
 * Mapped cases the engine sweep runs. Default 500.
 *
 * Measured on this machine: all 1 096 mappable cases (8 768 requests) take
 * 2.9 s, so 500 lands at ~1.5 s and leaves an order of magnitude of headroom
 * under a slow CI box. The mapped set is homogeneous — every generated case is
 * one machine-written policy over a machine-written schema — so the marginal
 * case teaches very little, while the binding sweep above already runs all
 * 7 600. Raise it (or set it past 1 096) to sweep the lot.
 */
const ENGINE_LIMIT = readLimit("CEDAR_CORPUS_ENGINE_LIMIT", 500);

function readLimit(variable: string, fallback: number): number {
	const raw = process.env[variable];
	if (raw === undefined || raw === "") {
		return fallback;
	}

	const parsed = Number(raw);
	if (!Number.isInteger(parsed) || parsed < 1) {
		throw new Error(`${variable} must be a positive integer, received "${raw}".`);
	}
	return parsed;
}

// ---------------------------------------------------------------------------
// The i64 boundary
// ---------------------------------------------------------------------------

/**
 * Whether any number in `value` lost precision on the way through `JSON.parse`.
 *
 * Cedar's `Long` is an i64 and the generated corpus exercises both ends of it.
 * JavaScript has no i64: `JSON.parse` turns `9223372036854775807` into the float
 * `9223372036854775808`, which cedar-wasm's `RawCedarValueJson` then refuses —
 * `"data did not match any variant of untagged enum RawCedarValueJson"`. Handing
 * it a `BigInt` instead does not help; serde-wasm-bindgen throws outright.
 *
 * So this is a limitation of the JSON *harness*, not a disagreement about Cedar,
 * and the cases it hits are skipped under a reason that says so rather than
 * counted as failures. Cedar has no floats — decimals are `__extn` strings — so
 * "not a safe integer" is an exact test for the mangled values and nothing else.
 *
 * The same check runs over parsed `PolicyJson` at engine level: a policy holding
 * an out-of-range literal cannot survive the text -> JSON -> WASM round trip the
 * policy store requires, though it passes through untouched as text.
 */
function containsUnsafeInteger(value: unknown): boolean {
	if (typeof value === "number") {
		return !Number.isSafeInteger(value);
	}
	if (Array.isArray(value)) {
		return value.some(containsUnsafeInteger);
	}
	if (typeof value === "object" && value !== null) {
		return Object.values(value).some(containsUnsafeInteger);
	}
	return false;
}

// ---------------------------------------------------------------------------
// Tallies
//
// One `it()` per corpus group rather than one per case: 7 600 vitest tests is
// minutes of reporter overhead for the same assertion. The structured tally is
// what replaces the per-test names — nothing is dropped, it is counted.
// ---------------------------------------------------------------------------

interface Tally {
	cases: number;
	requests: number;
	ranCases: number;
	ranRequests: number;
	heldBackCases: number;
	heldBackRequests: number;
	readonly skippedCases: Map<string, number>;
	readonly skippedRequests: Map<string, number>;
	readonly mismatches: string[];
}

function newTally(): Tally {
	return {
		cases: 0,
		requests: 0,
		ranCases: 0,
		ranRequests: 0,
		heldBackCases: 0,
		heldBackRequests: 0,
		skippedCases: new Map(),
		skippedRequests: new Map(),
		mismatches: [],
	};
}

function bump(counter: Map<string, number>, key: string, by: number): void {
	counter.set(key, (counter.get(key) ?? 0) + by);
}

/** Records a whole case as skipped, with the requests it would have run. */
function skipCase(tally: Tally, reason: string, requests: number): void {
	bump(tally.skippedCases, reason, 1);
	bump(tally.skippedRequests, reason, requests);
}

function formatReasons(counter: Map<string, number>): string {
	if (counter.size === 0) {
		return "none";
	}
	return [...counter.entries()]
		.toSorted(([left], [right]) => (left < right ? -1 : 1))
		.map(([reason, count]) => `${reason}: ${String(count)}`)
		.join(", ");
}

function totalOf(counter: Map<string, number>): number {
	let total = 0;
	for (const count of counter.values()) {
		total += count;
	}
	return total;
}

function report(label: string, tally: Tally, elapsedMs: number, limit: string): void {
	const lines = [
		`[cedar-corpus] ${label}`,
		`  cases    : ${String(tally.cases)} discovered | ran ${String(tally.ranCases)} | ` +
			`skipped ${String(totalOf(tally.skippedCases))} (${formatReasons(tally.skippedCases)})`,
		`  requests : ${String(tally.requests)} discovered | ran ${String(tally.ranRequests)} | ` +
			`skipped ${String(totalOf(tally.skippedRequests))} (${formatReasons(tally.skippedRequests)}) | ` +
			`mismatched ${String(tally.mismatches.length)}`,
		`  limit    : ${limit}`,
		`  elapsed  : ${elapsedMs.toFixed(0)} ms`,
	];

	// oxlint-disable-next-line no-console -- the totals block is the deliverable of this suite
	console.log(lines.join("\n"));
}

/** How a limit held back part of the run, phrased for the totals block. */
function limitLabel(variable: string, limit: number, tally: Tally): string {
	if (tally.heldBackCases === 0) {
		return `none — ${variable} ${Number.isFinite(limit) ? `(${String(limit)}) covered everything` : "unset"}`;
	}
	return (
		`LIMITED by ${variable}=${String(limit)} — ${String(tally.heldBackCases)} eligible cases ` +
		`(${String(tally.heldBackRequests)} requests) were not run`
	);
}

/**
 * The first `max` offenders, formatted.
 *
 * Returned as an array so `toEqual([])` prints them verbatim in the diff: the
 * failure message *is* the report, and truncating it keeps a 60 000-request
 * regression from burying the console.
 */
function firstOffenders(tally: Tally, max = 10): readonly string[] {
	return tally.mismatches.slice(0, max);
}

// ---------------------------------------------------------------------------
// §B — binding-level conformance
// ---------------------------------------------------------------------------

/** Set equality, order-insensitive, rendered for the failure message. */
function asSet(values: readonly string[]): string {
	return `[${[...values].toSorted().join(", ")}]`;
}

/**
 * Builds the `policies` argument.
 *
 * `.cedar` text goes straight in: `StaticPolicySet` accepts a string, and Cedar
 * then names the policies `policy0`, `policy1`, … in source order — exactly the
 * ids the corpus `reason` lists. A `.json` policy file is already a whole
 * `PolicySet` (`{ staticPolicies, templates, templateLinks }`) in this corpus,
 * so it is passed through; a bare policy object is wrapped to keep the same
 * naming.
 */
function policySetOf(corpusCase: CorpusCase): PolicySet {
	if (corpusCase.policyFormat !== "json") {
		return { staticPolicies: readFileSync(path.join(CORPUS_ROOT, corpusCase.policies), "utf8") };
	}

	const parsed = readJson<PolicySet>(corpusCase.policies);
	if (parsed.staticPolicies !== undefined || parsed.templates !== undefined) {
		return parsed;
	}
	return { staticPolicies: { policy0: readJson<PolicyJson>(corpusCase.policies) } };
}

/** `.cedarschema` text passes through as-is; `Schema` is `string | SchemaJson`. */
function schemaOf(corpusCase: CorpusCase): string | SchemaJson<string> {
	return corpusCase.schemaFormat === "json"
		? readJson<SchemaJson<string>>(corpusCase.schema)
		: readFileSync(path.join(CORPUS_ROOT, corpusCase.schema), "utf8");
}

function runBindingCase(cedar: CedarBinding, file: string, tally: Tally): void {
	const corpusCase = readJson<CorpusCase>(file);
	tally.cases += 1;
	tally.requests += corpusCase.requests.length;

	const entities = readJson<Entities>(corpusCase.entities);
	if (containsUnsafeInteger(corpusCase) || containsUnsafeInteger(entities)) {
		skipCase(tally, "i64-precision", corpusCase.requests.length);
		return;
	}

	const policies = policySetOf(corpusCase);
	const schema = schemaOf(corpusCase);
	tally.ranCases += 1;

	for (const request of corpusCase.requests) {
		const call: AuthorizationCall = {
			principal: request.principal,
			action: request.action,
			resource: request.resource,
			context: {},
			schema,
			validateRequest: request.validateRequest ?? true,
			policies,
			entities,
		};
		const answer = cedar.isAuthorized(
			request.context === undefined ? call : { ...call, context: { ...request.context } },
		);

		if (isCedarFailure(answer)) {
			const message = answer.errors.map((error) => error.message).join("; ");
			// The corpus deliberately contains entity stores Cedar refuses to
			// deserialize. Those are a skip; anything else Cedar refuses is a
			// disagreement about a case that was supposed to produce a decision.
			if (message.includes("entity deserialization")) {
				bump(tally.skippedRequests, "entity-deserialization", 1);
				continue;
			}
			tally.mismatches.push(`${file} :: ${request.description} :: cedar failed: ${message}`);
			continue;
		}

		tally.ranRequests += 1;

		const { decision, diagnostics } = answer.response;
		const reason = asSet(diagnostics.reason);
		const errored = asSet(diagnostics.errors.map((error) => error.policyId));
		const wantReason = asSet(request.reason ?? []);
		const wantErrored = asSet(request.errors ?? []);

		if (decision !== request.decision || reason !== wantReason || errored !== wantErrored) {
			tally.mismatches.push(
				`${file} :: ${request.description} :: got ${decision} reason=${reason} errors=${errored}, ` +
					`want ${request.decision} reason=${wantReason} errors=${wantErrored}`,
			);
		}
	}
}

let cedar: CedarBinding;
let handwrittenCases: readonly string[] = [];
let generatedCases: readonly string[] = [];

beforeAll(async () => {
	requireCorpus();
	cedar = await loadCedar();
	handwrittenCases = discoverHandwrittenCases();
	generatedCases = discoverGeneratedCases();

	// A corpus that discovered nothing is a broken fetch, not an empty corpus.
	expect(handwrittenCases.length).toBeGreaterThan(0);
	expect(generatedCases.length).toBeGreaterThan(0);
});

describe("cedar corpus — binding conformance", () => {
	it("agrees with every handwritten case", () => {
		const tally = newTally();
		const startedAt = performance.now();

		for (const file of handwrittenCases) {
			runBindingCase(cedar, file, tally);
		}

		report(
			"binding · handwritten",
			tally,
			performance.now() - startedAt,
			"none (always run in full)",
		);

		expect(firstOffenders(tally)).toEqual([]);
		expect(tally.mismatches.length).toBe(0);
		// The handwritten cases are hand-checked upstream: none of them may skip.
		expect(tally.ranRequests).toBe(tally.requests);
	}, 120_000);

	it("agrees with every generated case", () => {
		const tally = newTally();
		const startedAt = performance.now();
		const selected = generatedCases.slice(0, Math.min(generatedCases.length, CASE_LIMIT));

		for (const file of selected) {
			runBindingCase(cedar, file, tally);
		}
		for (const file of generatedCases.slice(selected.length)) {
			tally.heldBackCases += 1;
			tally.heldBackRequests += readJson<CorpusCase>(file).requests.length;
		}

		report(
			"binding · generated",
			tally,
			performance.now() - startedAt,
			limitLabel("CEDAR_CORPUS_LIMIT", CASE_LIMIT, tally),
		);

		expect(firstOffenders(tally)).toEqual([]);
		expect(tally.mismatches.length).toBe(0);

		// Two guards against a future corpus refresh passing vacuously: the run has
		// to stay a substantial majority, and the skips have to stay a rounding
		// error. Measured at the pinned commit: 60 128 of 60 800 requests ran and
		// 672 (1.1%) skipped, all of them i64-precision.
		//
		// Only meaningful over the whole corpus. `CEDAR_CORPUS_LIMIT` takes a prefix
		// of a sha-ordered list, and the i64 cases are not spread evenly through it —
		// a 200-case prefix skips 3%. Asserting a proportion of an arbitrary sample
		// would make the smoke run flaky for no gain, so the guard is skipped exactly
		// when the totals block says the run was limited.
		if (tally.heldBackCases === 0) {
			const attempted = tally.ranRequests + totalOf(tally.skippedRequests);
			expect(tally.ranRequests / attempted).toBeGreaterThan(0.95);
			expect(totalOf(tally.skippedRequests) / attempted).toBeLessThan(0.02);
		}
	}, 900_000);
});

// ---------------------------------------------------------------------------
// §C — engine-level conformance
//
// The claim here is narrower than §B and worth stating precisely: for every case
// that *can* be expressed as a `PermissionsEngine`, the engine returns Cedar's
// own decision and Cedar's own determining-policy set. The wrapper — namespace
// qualification, policy-id naming, context coercion, entity passthrough —
// changes nothing.
// ---------------------------------------------------------------------------

/**
 * A single top-level `namespace <Name> {` block.
 *
 * `^` anchored so a `namespace` inside a comment or a nested position cannot
 * match, and multi-segment names (`A::B::C`) are captured whole because the
 * generated corpus is full of them.
 */
const TOP_LEVEL_NAMESPACE = /^namespace\s+([A-Za-z_]\w*(?:::[A-Za-z_]\w*)*)\s*\{/gm;

interface MappedCase {
	readonly namespace: string;
	readonly schemaText: string;
	readonly schemaJson: SchemaJson<string>;
	readonly policies: readonly PolicyRecord[];
	readonly entities: Entities;
	readonly requests: readonly CorpusRequest[];
}

type Mapping = { readonly mapped: MappedCase } | { readonly skipped: string };

/**
 * Decides whether a case can be driven through an engine, and prepares it.
 *
 * The checks run cheapest-first so that the 85% of cases which cannot be mapped
 * never pay for reading a 17 kB entity store.
 */
function mapCase(binding: CedarBinding, corpusCase: CorpusCase): Mapping {
	if (corpusCase.schemaFormat === "json") {
		return { skipped: "schema-format-json" };
	}
	if (corpusCase.policyFormat === "json") {
		return { skipped: "policy-format-json" };
	}

	const schemaText = readFileSync(path.join(CORPUS_ROOT, corpusCase.schema), "utf8");
	const namespaces = [...schemaText.matchAll(TOP_LEVEL_NAMESPACE)].map((match) => match[1]);
	const namespace = namespaces.length === 1 ? namespaces[0] : undefined;
	if (namespace === undefined) {
		// The common case, and the honest reason the engine subset is small:
		// `resolveEngineOptions` throws on an empty namespace, and most generated
		// cases declare no namespace at all.
		return { skipped: namespaces.length === 0 ? "no-namespace" : "multiple-namespaces" };
	}

	const policyText = readFileSync(path.join(CORPUS_ROOT, corpusCase.policies), "utf8");
	if (policyText.includes("?principal") || policyText.includes("?resource")) {
		// A template needs a `TemplateLinkRecord` the corpus does not carry.
		return { skipped: "template-slots" };
	}

	// `qualifyEntityType` leaves an already-qualified type alone and
	// `actionUid(ns, id)` yields `<ns>::Action`, so a case whose request types are
	// all `<ns>::`-prefixed maps onto the engine without rewriting anything.
	const qualified = corpusCase.requests.every(
		(request) =>
			normalizeEntityUid(request.principal).type.startsWith(`${namespace}::`) &&
			normalizeEntityUid(request.resource).type.startsWith(`${namespace}::`) &&
			normalizeEntityUid(request.action).type === `${namespace}::Action`,
	);
	if (!qualified) {
		return { skipped: "types-not-namespace-qualified" };
	}

	if (containsUnsafeInteger(corpusCase)) {
		return { skipped: "i64-precision" };
	}

	const schemaAnswer = schemaToJson(schemaText);
	if (isCedarFailure(schemaAnswer)) {
		return { skipped: "schema-conversion" };
	}

	// `policyRecordFromText` parses **one** policy, but a corpus `.cedar` file may
	// hold several, so the text is split first and the parts are named `policy0`,
	// `policy1`, … in source order — the same names Cedar gives them when the raw
	// text is handed to `isAuthorized`, which is what makes `reason` comparable
	// across the two levels.
	const parts = policySetTextToParts(policyText);
	if (isCedarFailure(parts)) {
		return { skipped: "policy-split" };
	}

	const policies = parts.policies.map((text, index) =>
		policyRecordFromText(binding, {
			id: `policy${String(index)}`,
			scope: GLOBAL_POLICY_SCOPE,
			text,
			updatedAt: new Date(0),
		}),
	);
	if (policies.some((policy) => containsUnsafeInteger(policy.cedarJson))) {
		return { skipped: "i64-precision" };
	}

	const entities = readJson<Entities>(corpusCase.entities);
	if (containsUnsafeInteger(entities)) {
		return { skipped: "i64-precision" };
	}

	return {
		mapped: {
			namespace,
			schemaText,
			schemaJson: schemaAnswer.json,
			policies,
			entities,
			requests: corpusCase.requests,
		},
	};
}

/**
 * The minimum a corpus schema has to look like to be an engine vocabulary.
 *
 * `create()` reads exactly one thing off it — `cedarSchemaJson`, which it hashes
 * and hands to `preparseSchema` — and `checkUnsafe` reads none, because every
 * type and action id arrives on the request as a plain string. The derived
 * unions a real `defineVocabulary()` result carries exist for compile-time
 * narrowing that this suite deliberately does not use, so they are empty rather
 * than reconstructed from a machine-generated schema. No cast: the object
 * satisfies `AnyVocabulary` structurally, which is the point of that interface.
 */
function vocabularyFor(mapped: MappedCase): AnyVocabulary {
	return {
		namespace: mapped.namespace,
		def: { namespace: mapped.namespace, entities: {}, actions: {} },
		cedarSchemaJson: mapped.schemaJson,
		entityTypeNames: [],
		actionNames: [],
		actionGroupNames: [],
		toCedarSchemaText: () => mapped.schemaText,
		actionUid: (action: string) => actionUid(mapped.namespace, action),
		entityUid: (ref) => entityRefToUid(ref, mapped.namespace),
		actionsInGroup: () => [],
	};
}

async function runEngineCase(
	binding: CedarBinding,
	file: string,
	mapped: MappedCase,
	instanceId: string,
	tally: Tally,
): Promise<void> {
	const engine = await PermissionsEngine.create<AnyVocabulary>({
		vocabulary: vocabularyFor(mapped),
		policyStore: new MemoryPolicyStore({ policies: [...mapped.policies] }),
		namespace: mapped.namespace,
		instanceId,
		cedar: binding,
		// Both off deliberately. Request validation is §B's job and it already
		// passed there with the corpus's own `validateRequest: true`; policy
		// validation would reject the generated corpus wholesale, since
		// `shouldValidate` is false for most of it. What is under test here is the
		// decision path, not the two guard rails around it.
		validateRequests: false,
		validateOnLoad: false,
	});

	try {
		for (const request of mapped.requests) {
			const principal: TypeAndId = normalizeEntityUid(request.principal);
			const resource: TypeAndId = normalizeEntityUid(request.resource);

			const result = await engine.checkUnsafe({
				scope: GLOBAL_POLICY_SCOPE,
				principal,
				action: normalizeEntityUid(request.action).id,
				resource,
				context: request.context ?? {},
				// Passing the corpus store straight through is what makes an
				// `EntityProvider` unnecessary here.
				entities: mapped.entities,
			});

			tally.ranRequests += 1;

			const reason = asSet(result.determiningPolicyIds);
			const wantReason = asSet(request.reason ?? []);
			if (result.decision !== request.decision || reason !== wantReason) {
				tally.mismatches.push(
					`${file} :: ${request.description} :: engine got ${result.decision} reason=${reason}, ` +
						`want ${request.decision} reason=${wantReason}`,
				);
			}
		}
	} finally {
		// The WASM has no unregister API for preparsed sets, so leaking ids across
		// a thousand engines is a real memory cost, not hygiene theatre.
		await engine.dispose();
	}
}

describe("cedar corpus — engine conformance", () => {
	it("returns Cedar's own decision for every mappable case", async () => {
		const tally = newTally();
		const startedAt = performance.now();
		let instances = 0;

		for (const file of [...handwrittenCases, ...generatedCases]) {
			const corpusCase = readJson<CorpusCase>(file);
			tally.cases += 1;
			tally.requests += corpusCase.requests.length;

			const mapping = mapCase(cedar, corpusCase);
			if ("skipped" in mapping) {
				skipCase(tally, mapping.skipped, corpusCase.requests.length);
				continue;
			}

			if (instances >= ENGINE_LIMIT) {
				tally.heldBackCases += 1;
				tally.heldBackRequests += corpusCase.requests.length;
				continue;
			}

			instances += 1;
			tally.ranCases += 1;
			await runEngineCase(cedar, file, mapping.mapped, `corpus-${String(instances)}`, tally);
		}

		report(
			"engine · mapped subset",
			tally,
			performance.now() - startedAt,
			limitLabel("CEDAR_CORPUS_ENGINE_LIMIT", ENGINE_LIMIT, tally),
		);

		expect(firstOffenders(tally)).toEqual([]);
		expect(tally.mismatches.length).toBe(0);

		// A mapping that stopped matching — an upstream schema-shape change, a
		// tightened `resolveEngineOptions` — would make everything above vacuous.
		// Asserted on the *mappable* count, not the run count, so the guard survives
		// `CEDAR_CORPUS_ENGINE_LIMIT`; the run count is then asserted to be exactly
		// what that cap allowed, which is what stops the cap becoming a silent
		// "engine level ran nothing".
		const mappable = tally.ranCases + tally.heldBackCases;
		expect(mappable).toBeGreaterThan(100);
		expect(tally.ranCases).toBe(Math.min(mappable, ENGINE_LIMIT));
	}, 300_000);
});
