// LIKE fuzz — the escaping trap, three ways.
//
// Cedar's `like` and SQL's `LIKE` share a name and almost nothing else:
//
//   * Cedar's wildcard is `*`; SQL's are `%` and `_`.
//   * Cedar has **no** escape for `%` or `_` — verified, `like "50\%*"` is a
//     *parse* error, not an escaped percent. So `%` and `_` are ordinary
//     characters in a Cedar pattern and metacharacters in a SQL one.
//   * Cedar's only escapes are `\*`, `\\` and `\"`.
//
// Which means a naive driver that pasted the pattern through would turn
// `resource.title like "50% off"` into a filter matching `50<anything> off` — a
// silent widening on exactly the kind of string a policy author writes without
// thinking. The escaping lives in core (`likeTokensToPattern`, delta D5) so that
// both drivers cannot diverge; this suite proves this driver *uses* it and that
// Postgres agrees with Cedar about the result.
//
// Three oracles per case:
//   (a) real cedar-wasm `check()` over a one-attribute entity,
//   (b) core's `matchLikeTokens` interpreter,
//   (c) `SELECT … WHERE title LIKE $1 ESCAPE $2` against real Postgres.
//
// Run count is env-tunable: TYPEORM_LIKE_FUZZ_RUNS=500.

import {
	MemoryPolicyStore,
	createEngine,
	loadCedar,
	policyRecordFromText,
	type CedarBinding,
	type PermissionsEngine,
} from "@nestm/permissions-core";
import type { LikeToken, PlanNode } from "@nestm/permissions-core/plan";
import { matchLikeTokens } from "@nestm/permissions-core/testing";
import fc from "fast-check";
import { DataSource } from "typeorm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { planNodeToBrackets } from "../../src/compile/plan-to-brackets.ts";
import type { TypeOrmResourceMapping } from "../../src/compile/mapping.ts";
import {
	checkEntities,
	createDocEntities,
	docMappingColumnAndRecursive,
	docTableDdl,
	docTableDropDdl,
	docVocabulary,
	fixedEntities,
	seedDocs,
	seedHierarchy,
	type DocEntities,
	type DocRow,
	type DocVocabulary,
} from "../fixtures/doc-population.ts";
import { PG_SKIPPED, PG_URL, assertPostgresReachable, uniqueSuffix } from "../fixtures/pg.ts";

const RUNS = Number.parseInt(process.env["TYPEORM_LIKE_FUZZ_RUNS"] ?? "120", 10);

const SCHEMA = uniqueSuffix("nestm_like");
const PREFIX = "l_";
const TENANT = "org:1";
const PRINCIPAL = { type: "User", id: "u1" } as const;
const FIXTURE_TIME = new Date("2026-07-30T00:00:00.000Z");
const FIXED = fixedEntities();

let cedar: CedarBinding;
let dataSource: DataSource;
let entities: DocEntities;
let mapping: TypeOrmResourceMapping<"Doc">;
const engines: PermissionsEngine<DocVocabulary>[] = [];

/**
 * Characters chosen so every metacharacter of *both* languages appears:
 * `*` (Cedar wildcard), `%` and `_` (SQL wildcards), `\` (both escape
 * characters), plus quotes and ordinary letters to make the results readable.
 */
const ALPHABET = ["a", "b", "%", "_", "*", "\\", "'", '"', " "] as const;

const subjectArb: fc.Arbitrary<string> = fc
	.array(fc.constantFrom(...ALPHABET), { minLength: 0, maxLength: 6 })
	.map((parts) => parts.join(""));

/**
 * A pattern as `LikeToken`s, which is the form the plan carries and the only form
 * that can distinguish "a literal `%`" from "a wildcard".
 */
const patternArb: fc.Arbitrary<readonly LikeToken[]> = fc
	.array(
		fc.oneof(
			{
				arbitrary: subjectArb.filter((text) => text.length > 0).map((literal) => ({ literal })),
				weight: 3,
			},
			{ arbitrary: fc.constant({ wildcard: true as const }), weight: 2 },
		),
		{ minLength: 0, maxLength: 4 },
	)
	.map((tokens) => tokens as readonly LikeToken[]);

/** The same pattern in Cedar source form, with Cedar's escaping rules. */
function toCedarPattern(tokens: readonly LikeToken[]): string {
	return tokens
		.map((token) =>
			"wildcard" in token
				? "*"
				: // Only `\` and `*` need escaping inside a Cedar pattern; `"` needs it
					// because the pattern is written inside a double-quoted string.
					token.literal.replaceAll("\\", "\\\\").replaceAll("*", "\\*").replaceAll('"', '\\"'),
		)
		.join("");
}

async function cedarMatches(
	tokens: readonly LikeToken[],
	subjects: readonly string[],
): Promise<Set<string>> {
	const text = `permit(principal, action == Test::Action::"doc:read", resource) when { resource.title like "${toCedarPattern(tokens)}" };`;
	const engine = await createEngine<DocVocabulary>({
		vocabulary: docVocabulary,
		policyStore: new MemoryPolicyStore({
			policies: [
				policyRecordFromText(cedar, { id: "p", scope: TENANT, text, updatedAt: FIXTURE_TIME }),
			],
		}),
		instanceId: `typeorm-like-${String(process.pid)}-${String(engines.length)}`,
		cedar,
	});
	engines.push(engine);

	const rows = subjects.map((title, index) => docRow(index, title));
	const results = await engine.checkMany(
		rows.map((row) => ({
			scope: TENANT,
			principal: PRINCIPAL,
			action: "doc:read" as const,
			resource: { type: "Doc" as const, id: row.id },
			entities: checkEntities(row, FIXED),
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

function docRow(index: number, title: string): DocRow {
	return {
		id: `d${String(index)}`,
		folder: "f1",
		owner: "u1",
		status: "draft",
		title,
		size: 1,
		archived: false,
		labels: [],
	};
}

describe.skipIf(PG_SKIPPED)("like fuzz", () => {
	beforeAll(async () => {
		await assertPostgresReachable();
		cedar = await loadCedar();

		entities = createDocEntities(SCHEMA, PREFIX);
		dataSource = new DataSource({
			type: "postgres",
			url: PG_URL,
			entities: [entities.docs, entities.closure, entities.nodes],
			extra: { max: 4 },
		});
		await dataSource.initialize();

		await dataSource.query(docTableDropDdl(SCHEMA, PREFIX));
		for (const statement of docTableDdl(SCHEMA, PREFIX)) {
			await dataSource.query(statement);
		}

		mapping = docMappingColumnAndRecursive(dataSource, entities);
	});

	afterAll(async () => {
		await Promise.all(engines.map((engine) => engine.dispose()));
		if (dataSource?.isInitialized) {
			await dataSource.query(docTableDropDdl(SCHEMA, PREFIX));
			await dataSource.query(`drop schema if exists "${SCHEMA}" cascade`);
			await dataSource.destroy();
		}
	});

	it(`matches exactly what Cedar matches (${String(RUNS)} runs)`, async () => {
		let checked = 0;
		let matched = 0;

		await fc.assert(
			fc.asyncProperty(
				patternArb,
				fc.uniqueArray(subjectArb, { minLength: 4, maxLength: 10 }),
				async (tokens, subjects) => {
					const rows = subjects.map((title, index) => docRow(index, title));
					await seedDocs(dataSource, entities, rows);
					await seedHierarchy(dataSource, entities, rows);

					const node: PlanNode = {
						op: "like",
						attr: { root: "resource", path: ["title"] },
						pattern: tokens,
					};

					// (c) real Postgres, through the compiled `LIKE … ESCAPE`.
					const selected = new Set(
						(
							await dataSource
								.createQueryBuilder(entities.docs, "doc")
								.select("doc.id", "id")
								.andWhere(planNodeToBrackets(node, mapping))
								.getRawMany<{ id: string }>()
						).map((row) => row.id),
					);

					// (b) core's own interpreter over the same strings.
					const interpreted = new Set(
						rows.filter((row) => matchLikeTokens(row.title, tokens)).map((row) => row.id),
					);

					// (a) real Cedar.
					const authorized = await cedarMatches(tokens, subjects);

					checked += rows.length;
					matched += authorized.size;

					const describeCase = (): string =>
						`pattern ${JSON.stringify(tokens)} (cedar: "${toCedarPattern(tokens)}")\n` +
						`  subjects: ${JSON.stringify(subjects)}\n` +
						`  cedar: [${[...authorized].toSorted().join(", ")}]\n` +
						`  interpreter: [${[...interpreted].toSorted().join(", ")}]\n` +
						`  postgres: [${[...selected].toSorted().join(", ")}]`;

					expect([...selected].toSorted(), `postgres vs cedar\n${describeCase()}`).toEqual(
						[...authorized].toSorted(),
					);
					expect([...interpreted].toSorted(), `interpreter vs cedar\n${describeCase()}`).toEqual(
						[...authorized].toSorted(),
					);
				},
			),
			{ numRuns: RUNS },
		);

		// A fuzz where nothing ever matched would pass while proving nothing.
		expect(checked).toBeGreaterThan(0);
		expect(matched).toBeGreaterThan(0);
	});

	it("a literal % or _ in the pattern does not become a wildcard", async () => {
		const rows = [docRow(0, "50% off"), docRow(1, "5000 off"), docRow(2, "a_b"), docRow(3, "axb")];
		await seedDocs(dataSource, entities, rows);
		await seedHierarchy(dataSource, entities, rows);

		const select = async (pattern: readonly LikeToken[]): Promise<string[]> =>
			(
				await dataSource
					.createQueryBuilder(entities.docs, "doc")
					.select("doc.id", "id")
					.andWhere(
						planNodeToBrackets(
							{ op: "like", attr: { root: "resource", path: ["title"] }, pattern },
							mapping,
						),
					)
					.orderBy("doc.id")
					.getRawMany<{ id: string }>()
			).map((row) => row.id);

		// `%` is data here, not a wildcard: `5000 off` must not match.
		expect(await select([{ literal: "50% off" }])).toEqual(["d0"]);
		// `_` likewise: `axb` must not match.
		expect(await select([{ literal: "a_b" }])).toEqual(["d2"]);
		// And a real wildcard still is one.
		expect(await select([{ literal: "50" }, { wildcard: true }])).toEqual(["d0", "d1"]);
	});
});
