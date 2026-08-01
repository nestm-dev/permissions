import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { CedarBinding } from "../../src/cedar/binding.ts";
import { loadCedar } from "../../src/cedar/loader.ts";
import type { EntityGraph } from "../../src/entities/entity-provider.ts";
import { UnsupportedResidualError } from "../../src/diagnostics/errors.ts";
import { PermissionsEngine, createEngine } from "../../src/engine.ts";
import { MemoryPolicyStore } from "../../src/policy/memory-policy-store.ts";
import { policyRecordFromText } from "../../src/policy/policy-codec.ts";
import type { PolicyRecord, TemplateLinkRecord } from "../../src/policy/policy-store.ts";
import { formatPlanNode } from "../../src/plan/plan-node.ts";
import { evaluatePlanNode } from "../../src/plan/evaluate-plan.ts";
import { testVocabulary, type TestVocabulary } from "../../src/testing/fixtures.ts";
import {
	FOLDER_IDS,
	LABELS,
	ORG_ID,
	STATUSES,
	TITLES,
	USER_IDS,
	checkEntities,
	fixedEntities,
	resolveHierarchy,
	toPlanRow,
	type DocRow,
} from "../fixtures/doc-population.ts";

/**
 * The flagship suite (core.md §8 item 2).
 *
 * For a randomly generated population and a randomly generated policy set drawn
 * from the pushdown-able grammar, two row sets are computed independently:
 *
 *   * `authorized` — brute force. Every row goes through **real** cedar-wasm
 *     `check()`, one entity graph at a time. This is the definition of correct.
 *   * `planned` — one `plan()` call, then `evaluatePlanNode` over the same rows.
 *     This is what a driver's `WHERE` clause will select.
 *
 * **They must be equal.** Not "planned ⊆ authorized", not "mostly": a plan that
 * selects a row Cedar would deny is a data leak, and a plan that drops a row
 * Cedar would allow is a silent outage. §5.5 states the contract as an equality
 * and this is where that claim is actually tested.
 *
 * The second half tests the other direction — that a policy the compiler *cannot*
 * push down fails closed rather than quietly widening. A permit must throw; a
 * forbid may be approximated, but only restrictively, and never silently.
 *
 * Run count is env-tunable: `PLAN_PROPERTY_RUNS=200 pnpm --filter
 * @nestm/permissions-core test tests/property`. The default keeps the file
 * comfortably inside a normal `pnpm test`.
 */

/**
 * Default 75 — the top of the range core.md §8 suggests, which measures at ~2 s
 * here (each run is one engine, one `plan()` and ~125 real `check()` calls).
 * A 600-run sweep takes ~13 s and covered 72 528 rows with zero disagreements,
 * so raising this in CI is cheap:
 *
 * ```sh
 * PLAN_PROPERTY_RUNS=600 pnpm --filter @nestm/permissions-core test tests/property
 * ```
 */
const RUNS = Number.parseInt(process.env["PLAN_PROPERTY_RUNS"] ?? "75", 10);

const TENANT = "org:1";
const PRINCIPAL = { type: "User", id: "u1" } as const;
const ACTION = "doc:read";
const READ = 'action == Test::Action::"doc:read"';

const FIXED = fixedEntities();

let cedar: CedarBinding;
let instanceCounter = 0;
const engines: PermissionsEngine<TestVocabulary>[] = [];

beforeAll(async () => {
	cedar = await loadCedar();
});

afterAll(async () => {
	// Every engine owns a WASM policy-set id and the WASM has no unregister API.
	// `dispose()` overwrites each id with an empty set, which is the only thing
	// that gives the memory back (§0 finding 5).
	await Promise.all(engines.map((engine) => engine.dispose()));
});

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

const rowArb = (index: number): fc.Arbitrary<DocRow> =>
	fc.record({
		id: fc.constant(`d${String(index)}`),
		folder: fc.constantFrom(...FOLDER_IDS),
		owner: fc.constantFrom(...USER_IDS),
		status: fc.constantFrom(...STATUSES),
		title: fc.constantFrom(...TITLES),
		size: fc.integer({ min: 0, max: 20 }),
		archived: fc.boolean(),
		labels: fc.uniqueArray(fc.constantFrom(...LABELS), { maxLength: 3 }),
		// `undefined` is generated on purpose and often: the optional-attribute path
		// is where plan and check are most likely to disagree, because Cedar *errors*
		// on an unguarded read while SQL yields NULL.
		publishedAt: fc.option(fc.constantFrom(...PUBLISH_DATES), { nil: undefined, freq: 2 }),
		reviewer: fc.option(fc.constantFrom(...USER_IDS), { nil: undefined, freq: 2 }),
		score: fc.option(fc.integer({ min: 0, max: 20 }), { nil: undefined, freq: 2 }),
	});

/** Cedar accepts `YYYY-MM-DD` and `YYYY-MM-DDThh:mm:ssZ`; nothing local, no `:` in an offset. */
const PUBLISH_DATES: readonly Date[] = [
	new Date("2025-01-01T00:00:00.000Z"),
	new Date("2026-01-01T00:00:00.000Z"),
	new Date("2026-07-30T12:00:00.000Z"),
	new Date("2027-01-01T00:00:00.000Z"),
];

const DATE_LITERALS: readonly string[] = [
	"2025-06-01T00:00:00Z",
	"2026-01-01T00:00:00Z",
	"2026-12-31T23:59:59Z",
];

/**
 * `like` patterns, in Cedar source form.
 *
 * `\\*` in this TypeScript source is `\*` in the policy — a **literal** asterisk.
 * Cedar has no escape for `%` or `_` because it does not treat them specially;
 * that asymmetry is exactly why the AST carries tokens and why a driver has to
 * escape on the way out (delta D5). Verified against 4.12.0: `like "50\%*"` is a
 * parse error ("the input `\%` is not a valid escape").
 */
const LIKE_PATTERNS: readonly string[] = [
	"alpha",
	"alpha*",
	"*beta",
	"*a*",
	"a\\*b",
	"50% off",
	"50%*",
	"under_score",
	"*",
	"",
];

const population: fc.Arbitrary<readonly DocRow[]> = fc
	.integer({ min: 50, max: 200 })
	.chain((count) => fc.tuple(...Array.from({ length: count }, (_, index) => rowArb(index))));

/** A leaf condition: one pushdown-able comparison, always `has`-guarded where optional. */
const leafCondition: fc.Arbitrary<string> = fc.oneof(
	fc.constantFrom(...STATUSES).map((status) => `resource.status == "${status}"`),
	fc.constantFrom(...STATUSES).map((status) => `resource.status != "${status}"`),
	fc
		.uniqueArray(fc.constantFrom(...STATUSES), { minLength: 1, maxLength: 3 })
		.map((set) => `[${set.map((s) => `"${s}"`).join(",")}].contains(resource.status)`),
	fc
		.tuple(fc.constantFrom("<", "<=", ">", ">="), fc.integer({ min: 0, max: 20 }))
		.map(([op, n]) => `resource.size ${op} ${String(n)}`),
	fc.constantFrom("resource.archived", "!resource.archived"),
	fc.constantFrom(...LIKE_PATTERNS).map((pattern) => `resource.title like "${pattern}"`),
	fc.constantFrom(...LABELS).map((label) => `resource.labels.contains("${label}")`),
	fc.constant("resource.labels.isEmpty()"),
	fc.constant("resource has publishedAt"),
	fc
		.tuple(fc.constantFrom("<", "<=", ">", ">="), fc.constantFrom(...DATE_LITERALS))
		.map(([op, at]) => `resource has publishedAt && resource.publishedAt ${op} datetime("${at}")`),
	fc
		.tuple(fc.constantFrom("<", "<=", ">", ">=", "==", "!="), fc.integer({ min: 0, max: 20 }))
		.map(([op, n]) => `resource has score && resource.score ${op} ${String(n)}`),
	fc.constantFrom(...USER_IDS).map((user) => `resource.owner == Test::User::"${user}"`),
	fc
		.constantFrom(...USER_IDS)
		.map((user) => `resource has reviewer && resource.reviewer == Test::User::"${user}"`),
	// Hierarchy, including both reflexive shapes. `resource in Doc::"dN"` is the
	// self-match at the row; `resource.folder in Folder::"fN"` is the self-match at
	// an attribute. A strict-ancestor interpreter passes every other case here.
	fc.constantFrom(...FOLDER_IDS).map((folder) => `resource in Test::Folder::"${folder}"`),
	fc.constant(`resource in Test::Org::"${ORG_ID}"`),
	fc.constantFrom(...FOLDER_IDS).map((folder) => `resource.folder in Test::Folder::"${folder}"`),
	fc.constant(`resource.folder in Test::Org::"${ORG_ID}"`),
	fc.integer({ min: 0, max: 30 }).map((n) => `resource in Test::Doc::"d${String(n)}"`),
);

/** A condition tree: leaves combined with `&&`, `||`, `!` and `if-then-else`, depth-capped. */
const conditionArb: fc.Arbitrary<string> = fc.letrec<{ condition: string }>((tie) => ({
	condition: fc.oneof(
		{ maxDepth: 2, withCrossShrink: true },
		leafCondition,
		fc.tuple(tie("condition"), tie("condition")).map(([a, b]) => `(${a}) && (${b})`),
		fc.tuple(tie("condition"), tie("condition")).map(([a, b]) => `(${a}) || (${b})`),
		tie("condition").map((a) => `!(${a})`),
		fc
			.tuple(leafCondition, tie("condition"), tie("condition"))
			.map(([c, t, f]) => `if (${c}) then (${t}) else (${f})`),
	),
})).condition;

interface GeneratedPolicy {
	readonly effect: "permit" | "forbid";
	readonly condition: string;
	/** `true` when the policy should be emitted as a template + link instead. */
	readonly templated: boolean;
	/** Occasionally target the *other* action, so irrelevant policies get filtered out. */
	readonly otherAction: boolean;
}

const policyArb: fc.Arbitrary<GeneratedPolicy> = fc.record({
	// Forbids are rarer than permits but must appear: `NOT(OR(forbids))` is half
	// the assembled condition and the half where a sign error is a CVE.
	effect: fc.oneof(
		{ arbitrary: fc.constant("permit" as const), weight: 3 },
		{ arbitrary: fc.constant("forbid" as const), weight: 1 },
	),
	condition: conditionArb,
	templated: fc.oneof(
		{ arbitrary: fc.constant(false), weight: 4 },
		{ arbitrary: fc.constant(true), weight: 1 },
	),
	otherAction: fc.oneof(
		{ arbitrary: fc.constant(false), weight: 6 },
		{ arbitrary: fc.constant(true), weight: 1 },
	),
});

interface Scenario {
	readonly rows: readonly DocRow[];
	readonly policies: readonly GeneratedPolicy[];
}

const scenarioArb: fc.Arbitrary<Scenario> = fc.record({
	rows: population,
	policies: fc.array(policyArb, { minLength: 1, maxLength: 4 }),
});

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface BuiltPolicies {
	readonly records: readonly PolicyRecord[];
	readonly links: readonly TemplateLinkRecord[];
	/** Cedar source of every policy, for the failure message. */
	readonly sources: readonly string[];
}

function buildPolicies(policies: readonly GeneratedPolicy[]): BuiltPolicies {
	const records: PolicyRecord[] = [];
	const links: TemplateLinkRecord[] = [];
	const sources: string[] = [];

	policies.forEach((policy, index) => {
		const id = `p${String(index)}`;
		const action = policy.otherAction ? 'action == Test::Action::"doc:write"' : READ;

		// A template + link is not decoration: §0 finding 22 is that
		// `isAuthorizedPartial` honours `templateLinks`, which is what makes templates
		// usable as the role-grant primitive for *both* check and plan. If that ever
		// regressed, only a suite that links templates would notice.
		const principal = policy.templated ? "principal == ?principal" : "principal";
		const text = `${policy.effect}(${principal}, ${action}, resource) when { ${policy.condition} };`;

		sources.push(`${id}: ${text}`);
		records.push(policyRecordFromText(cedar, { id, scope: TENANT, text, updatedAt: FIXTURE_TIME }));

		if (policy.templated) {
			links.push({
				id: `${id}:link`,
				scope: TENANT,
				templateId: id,
				values: { "?principal": { type: "User", id: PRINCIPAL.id } },
				updatedAt: FIXTURE_TIME,
			});
		}
	});

	return { records, links, sources };
}

const FIXTURE_TIME = new Date("2026-07-30T00:00:00.000Z");

async function makeEngine(
	records: readonly PolicyRecord[],
	links: readonly TemplateLinkRecord[],
	overrides: { readonly validateOnLoad?: boolean } = {},
): Promise<PermissionsEngine<TestVocabulary>> {
	instanceCounter += 1;
	const engine = await createEngine<TestVocabulary>({
		vocabulary: testVocabulary,
		policyStore: new MemoryPolicyStore({ policies: [...records], links: [...links] }),
		instanceId: `plan-prop-${String(instanceCounter)}`,
		cedar,
		...overrides,
	});
	engines.push(engine);
	return engine;
}

/** The brute-force pass: real Cedar, one `check()` per row. This is the definition of correct. */
async function authorizedIds(
	engine: PermissionsEngine<TestVocabulary>,
	rows: readonly DocRow[],
): Promise<Set<string>> {
	const results = await engine.checkMany(
		rows.map((row) => ({
			scope: TENANT,
			principal: PRINCIPAL,
			action: ACTION,
			resource: { type: "Doc" as const, id: row.id },
			entities: checkEntities(row, FIXED) as EntityGraph,
		})),
	);

	const allowed = new Set<string>();
	results.forEach((result, index) => {
		if (result.allowed) {
			allowed.add((rows[index] as DocRow).id);
		}
	});
	return allowed;
}

/** The plan pass: one `plan()`, then the reference interpreter over the same rows. */
async function plannedIds(
	engine: PermissionsEngine<TestVocabulary>,
	rows: readonly DocRow[],
): Promise<{ ids: Set<string>; description: string }> {
	const plan = await engine.plan({
		scope: TENANT,
		principal: PRINCIPAL,
		action: ACTION,
		resourceType: "Doc",
		// The principal graph only. There is no resource to resolve when planning.
		entities: FIXED,
	});

	if (plan.kind === "ALWAYS_DENY") {
		return { ids: new Set(), description: "ALWAYS_DENY" };
	}
	if (plan.kind === "ALWAYS_ALLOW") {
		return { ids: new Set(rows.map((row) => row.id)), description: "ALWAYS_ALLOW" };
	}

	const ids = new Set<string>();
	for (const row of rows) {
		const matched = evaluatePlanNode(plan.condition, toPlanRow(row), {
			rowId: row.id,
			resourceType: "Doc",
			hierarchy: resolveHierarchy,
		});
		if (matched) {
			ids.add(row.id);
		}
	}

	return { ids, description: `CONDITIONAL ${formatPlanNode(plan.condition)}` };
}

function difference(left: ReadonlySet<string>, right: ReadonlySet<string>): string[] {
	return [...left].filter((id) => !right.has(id)).toSorted();
}

// ---------------------------------------------------------------------------
// Soundness
// ---------------------------------------------------------------------------

/**
 * Coverage counters, asserted after the property runs.
 *
 * A set-equality property is trivially satisfiable by two empty sets, so "it
 * passed" is not by itself evidence of anything: a generator that only ever
 * produced `ALWAYS_DENY` plans, or a population every policy rejected, would be
 * green and worthless. These counters turn that risk into a failing test.
 */
const stats = { runs: 0, rows: 0, authorized: 0, kinds: {} as Record<string, number> };

/**
 * Real WASM, ~125 real `check()` calls per run, so the per-test budget is
 * generous on purpose: a timeout here reads as a flake when it is almost always a
 * genuine slowdown worth looking at.
 */
const PROPERTY_TIMEOUT_MS = 600_000;

describe("plan soundness", () => {
	it(
		`selects exactly the rows check() allows (${String(RUNS)} runs)`,
		async () => {
			await fc.assert(
				fc.asyncProperty(scenarioArb, async (scenario) => {
					const { records, links, sources } = buildPolicies(scenario.policies);
					const engine = await makeEngine(records, links);

					const authorized = await authorizedIds(engine, scenario.rows);
					const { ids: planned, description } = await plannedIds(engine, scenario.rows);

					stats.runs += 1;
					stats.rows += scenario.rows.length;
					stats.authorized += authorized.size;
					stats.kinds[description.split(" ")[0] as string] =
						(stats.kinds[description.split(" ")[0] as string] ?? 0) + 1;

					const overShared = difference(planned, authorized);
					const overBlocked = difference(authorized, planned);

					if (overShared.length > 0 || overBlocked.length > 0) {
						const offender = (overShared[0] ?? overBlocked[0]) as string;
						const row = scenario.rows.find((candidate) => candidate.id === offender);

						throw new Error(
							[
								"plan and check disagree.",
								`  policies:\n    ${sources.join("\n    ")}`,
								`  plan: ${description}`,
								`  over-shared (plan selected, check denied): [${overShared.join(", ")}]`,
								`  over-blocked (check allowed, plan dropped): [${overBlocked.join(", ")}]`,
								`  first offending row: ${JSON.stringify(row)}`,
							].join("\n"),
						);
					}
				}),
				{ numRuns: RUNS, verbose: true },
			);

			// oxlint-disable-next-line eslint/no-console -- a coverage figure nobody can see is a coverage figure nobody checks
			console.log(
				`  plan-soundness coverage: ${String(stats.runs)} runs, ${String(stats.rows)} rows, ` +
					`${String(stats.authorized)} authorized, plans ${JSON.stringify(stats.kinds)}`,
			);

			// The property ran at all, over a real population.
			expect(stats.runs).toBe(RUNS);
			expect(stats.rows).toBeGreaterThanOrEqual(RUNS * 50);

			// It discriminated: some rows were authorized and some were not. Two empty
			// sets satisfy set equality perfectly and prove nothing.
			expect(stats.authorized).toBeGreaterThan(0);
			expect(stats.authorized).toBeLessThan(stats.rows);

			// And a real filter was compiled, not just the two constant plans. A quarter
			// is well below what the generator actually produces (~2/3) but far enough
			// above zero to catch a grammar change that stopped compiling conditions.
			expect(stats.kinds["CONDITIONAL"] ?? 0).toBeGreaterThanOrEqual(
				Math.max(1, Math.floor(RUNS * 0.25)),
			);
		},
		PROPERTY_TIMEOUT_MS,
	);
});

// ---------------------------------------------------------------------------
// Fail-closed
// ---------------------------------------------------------------------------

/**
 * Every shape §5.4 declares un-pushdown-able, with the reason the compiler must
 * attribute it to.
 *
 * These are policy *conditions*, dropped into a permit or a forbid unchanged. The
 * point is not that they are exotic — `resource.owner.org` is the most natural
 * thing an author could write — but that each one has to fail loudly in a permit
 * and restrictively in a forbid, with no third option.
 */
const UNSUPPORTED: readonly {
	readonly name: string;
	readonly condition: string;
	readonly reason: string;
	/** Tags are not modelled by `defineVocabulary` (errata core.md 8), so the validator must be off. */
	readonly skipValidation?: boolean;
}[] = [
	{
		name: "nested attribute",
		condition: `resource.owner.org == Test::Org::"${ORG_ID}"`,
		reason: "nested-attribute",
	},
	{
		name: "arithmetic",
		condition: "resource.size + 1 > 5",
		reason: "arithmetic",
	},
	{
		name: "extension call on the unknown",
		condition:
			'resource has publishedAt && resource.publishedAt.offset(duration("1h")) < datetime("2026-01-01T00:00:00Z")',
		reason: "extension-on-unknown",
	},
	{
		name: "unknown on both sides",
		condition: "resource.title == resource.status",
		reason: "unknown-both-sides",
	},
	{
		name: "row identity",
		condition: 'resource == Test::Doc::"d3"',
		reason: "entity-identity",
	},
	{
		name: "containsAll over an unknown attribute",
		condition: 'resource.labels.containsAll(["urgent","nightly"])',
		reason: "unsupported-operator",
	},
	{
		name: "tag operator",
		condition: 'resource.hasTag("owner")',
		reason: "unsupported-operator",
		skipValidation: true,
	},
];

/** Tags are not modelled by `defineVocabulary` (errata core.md 8), so those rows need the validator off. */
function validationOverride(entry: { readonly skipValidation?: boolean }): {
	readonly validateOnLoad?: boolean;
} {
	return entry.skipValidation === true ? { validateOnLoad: false } : {};
}

describe("fail-closed", () => {
	describe("in a permit — dropping the subterm would widen the row set", () => {
		it.each(UNSUPPORTED)("throws UnsupportedResidualError for $name", async (entry) => {
			const text = `permit(principal, ${READ}, resource) when { ${entry.condition} };`;
			const record = policyRecordFromText(cedar, {
				id: "p:unsupported",
				scope: TENANT,
				text,
				updatedAt: FIXTURE_TIME,
			});
			const engine = await makeEngine([record], [], validationOverride(entry));

			// `'error'` is the default for `unsupportedResidual`, and that default is
			// the entire fail-closed contract: an unsound plan is a data leak, so the
			// library refuses to return one unless the caller explicitly opted into a
			// slower-but-correct alternative.
			await expect(
				engine.plan({
					scope: TENANT,
					principal: PRINCIPAL,
					action: ACTION,
					resourceType: "Doc",
					entities: FIXED,
				}),
			).rejects.toThrow(UnsupportedResidualError);
		});
	});

	describe("in a forbid — dropping the subterm narrows the row set", () => {
		it.each(UNSUPPORTED)("records a restrictive approximation for $name", async (entry) => {
			// A permit alongside it, so there is something for the forbid to cut down;
			// a forbid on its own leaves nothing to over-block.
			const permit = policyRecordFromText(cedar, {
				id: "p:allow-all",
				scope: TENANT,
				text: `permit(principal, ${READ}, resource);`,
				updatedAt: FIXTURE_TIME,
			});
			const forbid = policyRecordFromText(cedar, {
				id: "f:unsupported",
				scope: TENANT,
				text: `forbid(principal, ${READ}, resource) when { ${entry.condition} };`,
				updatedAt: FIXTURE_TIME,
			});
			const engine = await makeEngine([permit, forbid], [], validationOverride(entry));

			const plan = await engine.plan({
				scope: TENANT,
				principal: PRINCIPAL,
				action: ACTION,
				resourceType: "Doc",
				entities: FIXED,
			});

			expect(plan.approximations.length).toBeGreaterThan(0);

			// The whole safety argument in one assertion: a widened *forbid* narrows
			// `NOT(OR(forbids))`, so the result is a subset. A `permissive` entry here
			// would mean the opposite, which is the classic vulnerability §5.5 names.
			for (const approximation of plan.approximations) {
				expect(approximation.direction).toBe("restrictive");
			}
			expect(plan.approximations.map((a) => a.reason)).toContain(entry.reason);

			// And it is never silent: every approximation carries the offending Cedar
			// sub-expression verbatim, for the audit log.
			for (const approximation of plan.approximations) {
				expect(approximation.policyId).toBe("f:unsupported");
				expect(approximation.effect).toBe("forbid");
				expect(approximation.expr).toBeDefined();
				expect(approximation.message.length).toBeGreaterThan(0);
			}
		});

		it("still selects a subset of what check() allows", async () => {
			// The restrictive claim, measured rather than asserted: with an
			// untranslatable forbid the plan must over-block, never over-share.
			const rows: DocRow[] = STATUSES.flatMap((status, index) =>
				FOLDER_IDS.map((folder, offset) => ({
					id: `d${String(index * 3 + offset)}`,
					folder,
					owner: "u1",
					status,
					title: "alpha",
					size: index,
					archived: false,
					labels: ["nightly"],
				})),
			);

			const permit = policyRecordFromText(cedar, {
				id: "p:allow-all",
				scope: TENANT,
				text: `permit(principal, ${READ}, resource);`,
				updatedAt: FIXTURE_TIME,
			});
			const forbid = policyRecordFromText(cedar, {
				id: "f:unsupported",
				scope: TENANT,
				text: `forbid(principal, ${READ}, resource) when { resource.title == resource.status };`,
				updatedAt: FIXTURE_TIME,
			});
			const engine = await makeEngine([permit, forbid], []);

			const authorized = await authorizedIds(engine, rows);
			const { ids: planned } = await plannedIds(engine, rows);

			expect(difference(planned, authorized)).toEqual([]);
		});
	});
});
