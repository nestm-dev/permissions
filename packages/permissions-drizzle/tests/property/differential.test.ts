// The flagship suite: three independently-computed row sets, asserted equal.
//
//   (a) `authorized` — brute force. Every row through **real** cedar-wasm
//       `check()`, one entity graph at a time. This is the definition of correct.
//   (b) `interpreted` — one `plan()`, then core's reference interpreter
//       (`filterRowsByPlan`) over the same rows. This is what core promises.
//   (c) `selected`  — `SELECT id FROM docs WHERE <planToSql(...)>` against **real
//       Postgres**. This is what an application actually gets.
//
// **All three must be equal.** Not "(c) ⊆ (a)", not "mostly": a filter that
// selects a row Cedar would deny is a data leak, and one that drops a row Cedar
// would allow is a silent outage. (a) vs (b) is core's contract, re-run here to
// catch integration drift; (b) vs (c) is this package's entire reason to exist.
//
// The suite runs against two *different* hierarchy mappings over one ground
// truth, so `column` + `recursive` and `closure` + `recursive` have to agree with
// each other as well as with Cedar. A compiler that got reflexivity wrong in one
// strategy and right in another shows up here rather than in production.
//
// Run count is env-tunable:
//   DRIZZLE_DIFFERENTIAL_RUNS=100 pnpm --filter @nestm/permissions-drizzle test tests/property

import {
	createEngine,
	loadCedar,
	policyRecordFromText,
	MemoryPolicyStore,
	type CedarBinding,
	type EntityGraph,
	type PermissionsEngine,
	type PolicyRecord,
	type TemplateLinkRecord,
} from "@nestm/permissions-core";
import { formatPlanNode, type PlanNode } from "@nestm/permissions-core/plan";
import { filterRowsByPlan } from "@nestm/permissions-core/testing";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { planToSql } from "../../src/compile/plan-to-sql.ts";
import type { DrizzleResourceMapping } from "../../src/compile/mapping.ts";
import {
	ADDRESSES,
	docMappingClosureAndRecursive,
	docMappingColumnAndRecursive,
	createDocTables,
	checkEntities,
	docTableDdl,
	docTableDropDdl,
	FOLDER_IDS,
	fixedEntities,
	LABELS,
	ORG_ID,
	PUBLISH_DATES,
	RATES,
	resolveHierarchy,
	seedDocs,
	seedHierarchy,
	selectIdsWhere,
	STATUSES,
	TITLES,
	TTLS,
	toPlanRow,
	USER_IDS,
	docVocabulary,
	type DocRow,
	type DocTables,
	type DocVocabulary,
} from "../fixtures/doc-population.ts";
import { PG_SKIPPED, assertPostgresReachable, openPg, uniqueSuffix } from "../fixtures/pg.ts";
import { sql } from "drizzle-orm";

const RUNS = Number.parseInt(process.env["DRIZZLE_DIFFERENTIAL_RUNS"] ?? "12", 10);

const TENANT = "org:1";
const PRINCIPAL = { type: "User", id: "u1" } as const;
const ACTION = "doc:read";
const READ = 'action == Test::Action::"doc:read"';
const FIXTURE_TIME = new Date("2026-07-30T00:00:00.000Z");

const FIXED = fixedEntities();
const PREFIX = `${uniqueSuffix("diff")}_`;

let cedar: CedarBinding;
let pg: ReturnType<typeof openPg>;
let tables: DocTables;
let mappings: readonly { name: string; mapping: DrizzleResourceMapping<"Doc"> }[];
let instanceCounter = 0;
const engines: PermissionsEngine<DocVocabulary>[] = [];

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
		// `undefined` is generated often and on purpose: the optional-attribute path
		// is where plan, check and SQL are most likely to disagree, because Cedar
		// *errors* on an unguarded read while SQL yields NULL.
		publishedAt: fc.option(fc.constantFrom(...PUBLISH_DATES), { nil: undefined, freq: 2 }),
		reviewer: fc.option(fc.constantFrom(...USER_IDS), { nil: undefined, freq: 2 }),
		score: fc.option(fc.integer({ min: 0, max: 20 }), { nil: undefined, freq: 2 }),
		rate: fc.option(fc.constantFrom(...RATES), { nil: undefined, freq: 2 }),
		addr: fc.option(fc.constantFrom(...ADDRESSES), { nil: undefined, freq: 2 }),
		ttl: fc.option(fc.constantFrom(...TTLS), { nil: undefined, freq: 2 }),
	});

const population: fc.Arbitrary<readonly DocRow[]> = fc
	.integer({ min: 25, max: 60 })
	.chain((count) => fc.tuple(...Array.from({ length: count }, (_, index) => rowArb(index))));

const DATE_LITERALS: readonly string[] = [
	"2025-06-01T00:00:00Z",
	"2026-01-01T00:00:00Z",
	"2026-12-31T23:59:59Z",
];

/**
 * `like` patterns in Cedar source form.
 *
 * `\\*` here is `\*` in the policy — a **literal** asterisk. Cedar has no escape
 * for `%` or `_` (verified: `like "50\%*"` is a parse error), so those two reach
 * the driver as ordinary text and become wildcards unless it escapes them.
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
	"back\\\\slash",
	"*",
	"",
];

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
	// NUMERIC: `decimal("1.5") == decimal("1.50")` is true in Cedar and in Postgres,
	// and false under text comparison — which is why the value is bound `::numeric`.
	fc
		.tuple(fc.constantFrom("==", "!="), fc.constantFrom(...RATES))
		.map(([op, rate]) => `resource has rate && resource.rate ${op} decimal("${rate}")`),
	// INET: address + prefix, Cedar's rule and Postgres's.
	fc
		.tuple(fc.constantFrom("==", "!="), fc.constantFrom(...ADDRESSES))
		.map(([op, addr]) => `resource has addr && resource.addr ${op} ip("${addr}")`),
	fc
		.tuple(fc.constantFrom("<", "<=", ">", ">=", "==", "!="), fc.constantFrom(...TTLS))
		.map(([op, ms]) => `resource has ttl && resource.ttl ${op} duration("${String(ms)}ms")`),
	fc.constantFrom(...USER_IDS).map((user) => `resource.owner == Test::User::"${user}"`),
	fc
		.constantFrom(...USER_IDS)
		.map((user) => `resource has reviewer && resource.reviewer == Test::User::"${user}"`),
	// Hierarchy, including both reflexive shapes.
	fc.constantFrom(...FOLDER_IDS).map((folder) => `resource in Test::Folder::"${folder}"`),
	fc.constant(`resource in Test::Org::"${ORG_ID}"`),
	fc.constantFrom(...FOLDER_IDS).map((folder) => `resource.folder in Test::Folder::"${folder}"`),
	fc.constant(`resource.folder in Test::Org::"${ORG_ID}"`),
	fc.integer({ min: 0, max: 40 }).map((n) => `resource in Test::Doc::"d${String(n)}"`),
);

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
	readonly templated: boolean;
	readonly otherAction: boolean;
}

const policyArb: fc.Arbitrary<GeneratedPolicy> = fc.record({
	// Forbids are rarer but must appear: `NOT(OR(forbids))` is half the assembled
	// condition and the half where a sign error is a CVE.
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

const scenarioArb = fc.record({
	rows: population,
	policies: fc.array(policyArb, { minLength: 1, maxLength: 3 }),
});

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function buildPolicies(policies: readonly GeneratedPolicy[]): {
	records: PolicyRecord[];
	links: TemplateLinkRecord[];
	sources: string[];
} {
	const records: PolicyRecord[] = [];
	const links: TemplateLinkRecord[] = [];
	const sources: string[] = [];

	policies.forEach((policy, index) => {
		const id = `p${String(index)}`;
		const action = policy.otherAction ? 'action == Test::Action::"doc:write"' : READ;
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

async function makeEngine(
	records: readonly PolicyRecord[],
	links: readonly TemplateLinkRecord[],
): Promise<PermissionsEngine<DocVocabulary>> {
	instanceCounter += 1;
	const engine = await createEngine<DocVocabulary>({
		vocabulary: docVocabulary,
		policyStore: new MemoryPolicyStore({ policies: [...records], links: [...links] }),
		instanceId: `drizzle-diff-${String(process.pid)}-${String(instanceCounter)}`,
		cedar,
	});
	engines.push(engine);
	return engine;
}

/** The brute-force pass: real Cedar, one `check()` per row. */
async function authorizedIds(
	engine: PermissionsEngine<DocVocabulary>,
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

function difference(left: ReadonlySet<string>, right: ReadonlySet<string>): string[] {
	return [...left].filter((id) => !right.has(id)).toSorted();
}

const stats = { runs: 0, rows: 0, authorized: 0, kinds: {} as Record<string, number> };

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe.skipIf(PG_SKIPPED)("three-way differential", () => {
	beforeAll(async () => {
		await assertPostgresReachable();
		cedar = await loadCedar();
		pg = openPg();
		tables = createDocTables(PREFIX);

		await pg.db.execute(sql.raw(docTableDropDdl(PREFIX)));
		for (const statement of docTableDdl(PREFIX)) {
			await pg.db.execute(sql.raw(statement));
		}

		mappings = [
			{ name: "column+recursive", mapping: docMappingColumnAndRecursive(tables) },
			{ name: "closure+recursive", mapping: docMappingClosureAndRecursive(tables) },
		];
	});

	afterAll(async () => {
		// Every engine owns a WASM policy-set id and the WASM has no unregister API;
		// `dispose()` overwrites each id with an empty set, which is the only thing
		// that gives the memory back.
		await Promise.all(engines.map((engine) => engine.dispose()));
		if (pg !== undefined) {
			await pg.db.execute(sql.raw(docTableDropDdl(PREFIX)));
			await pg.close();
		}
	});

	it(`selects exactly the rows check() allows (${String(RUNS)} runs, 2 mappings each)`, async () => {
		await fc.assert(
			fc.asyncProperty(scenarioArb, async (scenario) => {
				const { records, links, sources } = buildPolicies(scenario.policies);
				const engine = await makeEngine(records, links);

				await seedDocs(pg.db, tables, scenario.rows);
				await seedHierarchy(pg.db, tables, scenario.rows);

				const authorized = await authorizedIds(engine, scenario.rows);

				const plan = await engine.plan({
					scope: TENANT,
					principal: PRINCIPAL,
					action: ACTION,
					resourceType: "Doc",
					entities: FIXED,
				});

				const description =
					plan.kind === "CONDITIONAL" ? `CONDITIONAL ${formatPlanNode(plan.condition)}` : plan.kind;

				stats.runs += 1;
				stats.rows += scenario.rows.length;
				stats.authorized += authorized.size;
				stats.kinds[plan.kind] = (stats.kinds[plan.kind] ?? 0) + 1;

				// (b) the reference interpreter over the same rows. The two constant plan
				// kinds become the constant nodes, so all three arms go through one path.
				const node: PlanNode =
					plan.kind === "CONDITIONAL"
						? plan.condition
						: plan.kind === "ALWAYS_ALLOW"
							? { op: "true" }
							: { op: "false" };

				const interpreted = new Set(
					filterRowsByPlan(
						scenario.rows.map((row) => ({ ...toPlanRow(row), __id: row.id })),
						node,
						{
							rowId: (row) => row["__id"] as string,
							resourceType: "Doc",
							hierarchy: resolveHierarchy,
						},
					).map((row) => row["__id"] as string),
				);

				for (const { name, mapping } of mappings) {
					// (c) real Postgres, through the compiled WHERE clause.
					const selected = await selectIdsWhere(pg.db, tables.docs, planToSql(plan, mapping));

					report(name, "check vs sql", authorized, selected, sources, description, scenario.rows);
					report(
						name,
						"interpreter vs sql",
						interpreted,
						selected,
						sources,
						description,
						scenario.rows,
					);
				}

				report(
					"—",
					"check vs interpreter",
					authorized,
					interpreted,
					sources,
					description,
					scenario.rows,
				);
			}),
			{ numRuns: RUNS },
		);

		// oxlint-disable-next-line eslint/no-console -- a coverage figure nobody can see is a coverage figure nobody checks
		console.log(
			`  differential coverage: ${String(stats.runs)} runs, ${String(stats.rows)} rows, ` +
				`${String(stats.authorized)} authorized, plans ${JSON.stringify(stats.kinds)}`,
		);

		// Set equality is trivially satisfied by two empty sets, so the property
		// passing proves nothing on its own. These turn that risk into a failing test.
		expect(stats.runs).toBe(RUNS);
		expect(stats.authorized).toBeGreaterThan(0);
		expect(stats.authorized).toBeLessThan(stats.rows);
		expect(stats.kinds["CONDITIONAL"] ?? 0).toBeGreaterThanOrEqual(
			Math.max(1, Math.floor(RUNS * 0.25)),
		);
	});
});

function report(
	mappingName: string,
	comparison: string,
	expected: ReadonlySet<string>,
	actual: ReadonlySet<string>,
	sources: readonly string[],
	description: string,
	rows: readonly DocRow[],
): void {
	const overShared = difference(actual, expected);
	const overBlocked = difference(expected, actual);

	if (overShared.length === 0 && overBlocked.length === 0) {
		return;
	}

	const offender = (overShared[0] ?? overBlocked[0]) as string;
	throw new Error(
		[
			`${comparison} disagree (mapping: ${mappingName}).`,
			`  policies:\n    ${sources.join("\n    ")}`,
			`  plan: ${description}`,
			`  over-shared (second selected, first did not): [${overShared.join(", ")}]`,
			`  over-blocked (first selected, second did not): [${overBlocked.join(", ")}]`,
			`  first offending row: ${JSON.stringify(rows.find((row) => row.id === offender))}`,
		].join("\n"),
	);
}
