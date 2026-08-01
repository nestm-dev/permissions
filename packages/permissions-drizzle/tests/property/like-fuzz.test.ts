// The escaping trap, fuzzed.
//
// Cedar's `like` and SQL's `LIKE` disagree about almost everything:
//
//   | character | Cedar          | SQL LIKE                |
//   |-----------|----------------|-------------------------|
//   | `*`       | the wildcard   | ordinary text           |
//   | `%`       | ordinary text  | the wildcard            |
//   | `_`       | ordinary text  | any single character    |
//   | `\`       | escapes `*`    | the default ESCAPE char |
//
// and Cedar has **no `\%` escape at all** (verified: `like "50\%*"` is a parse
// error), so a `%` in a policy is always literal text and always reaches the
// driver as one. `likeTokensToPattern` is the single place that reconciles the
// two, and this suite is what proves it did.
//
// The oracle is core's `matchLikeTokens`, which matches over the **tokens** and
// never renders a pattern string — so it cannot share a bug with the renderer it
// is checking. Against it: real Postgres, running the compiled
// `col LIKE $1 ESCAPE $2`, over the same strings.
//
// Two escape characters are fuzzed. `\` is the default and the one that hides
// bugs, because it is also Postgres's implicit escape character — a driver that
// forgot to escape `\` would still pass under `ESCAPE '\'` for many inputs and
// fail immediately under `ESCAPE '~'`.

import { likeTokensToPattern, type LikeToken, type PlanNode } from "@nestm/permissions-core/plan";
import { matchLikeTokens } from "@nestm/permissions-core/testing";
import { sql } from "drizzle-orm";
import { pgTable, text } from "drizzle-orm/pg-core";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { planNodeToSql } from "../../src/compile/plan-to-sql.ts";
import type { DrizzleResourceMapping } from "../../src/compile/mapping.ts";
import { attr } from "../fixtures/compile.ts";
import { PG_SKIPPED, assertPostgresReachable, openPg, uniqueSuffix } from "../fixtures/pg.ts";

const RUNS = Number.parseInt(process.env["DRIZZLE_LIKE_FUZZ_RUNS"] ?? "150", 10);

const TABLE = uniqueSuffix("like");

const rows = pgTable(TABLE, {
	id: text("id").primaryKey(),
	title: text("title").notNull(),
});

const baseMapping: DrizzleResourceMapping<"Row"> = {
	resourceType: "Row",
	table: rows,
	id: rows.id,
	attributes: { title: { kind: "scalar", column: rows.title, valueKind: "string" } },
};

const ESCAPE_CHARS: readonly string[] = ["\\", "~"];

function mappingFor(escapeChar: string): DrizzleResourceMapping<"Row"> {
	return { ...baseMapping, text: { escapeChar } };
}

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

/**
 * The alphabet both sides are built from.
 *
 * Every metacharacter of both dialects, plus a quote and a semicolon (so a
 * pattern that leaked into the statement text would be a syntax error rather
 * than a silent mismatch), plus one astral character — `matchLikeTokens` matches
 * code points, and a wildcard that consumed a UTF-16 unit would split it.
 */
const ALPHABET: readonly string[] = [
	"a",
	"b",
	"%",
	"_",
	"*",
	"\\",
	"~",
	"'",
	";",
	"-",
	"[",
	"]",
	"é",
	"日",
	"🙂",
	" ",
];

const fragmentArb: fc.Arbitrary<string> = fc
	.array(fc.constantFrom(...ALPHABET), { maxLength: 5 })
	.map((parts) => parts.join(""));

const tokenArb: fc.Arbitrary<LikeToken> = fc.oneof(
	{ arbitrary: fragmentArb.map((literal) => ({ literal }) as LikeToken), weight: 3 },
	{ arbitrary: fc.constant({ wildcard: true } as LikeToken), weight: 2 },
);

const patternArb: fc.Arbitrary<readonly LikeToken[]> = fc.array(tokenArb, { maxLength: 5 });

const subjectArb: fc.Arbitrary<string> = fc
	.array(fc.constantFrom(...ALPHABET), { maxLength: 8 })
	.map((parts) => parts.join(""));

const scenarioArb = fc.record({
	pattern: patternArb,
	subjects: fc.uniqueArray(subjectArb, { minLength: 4, maxLength: 20 }),
});

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let pg: ReturnType<typeof openPg>;

/** Replaces the table's contents and returns the id each subject was stored under. */
async function seed(subjects: readonly string[]): Promise<Map<string, string>> {
	const ids = new Map<string, string>();
	const records = subjects.map((title, index) => {
		const id = `s${String(index)}`;
		ids.set(title, id);
		return { id, title };
	});

	await pg.db.delete(rows);
	if (records.length > 0) {
		await pg.db.insert(rows).values(records);
	}
	return ids;
}

/** Ids the compiled `LIKE` selects. */
async function selectMatching(
	pattern: readonly LikeToken[],
	escapeChar: string,
): Promise<Set<string>> {
	const node: PlanNode = { op: "like", attr: attr("title"), pattern };
	const condition = planNodeToSql(node, mappingFor(escapeChar));
	const result = await pg.db.execute<{ id: string }>(
		sql`select "id" from ${rows} where ${condition} order by "id"`,
	);
	const list = Array.isArray(result) ? result : ((result as { rows: { id: string }[] }).rows ?? []);
	return new Set(list.map((row) => row.id));
}

const stats = { runs: 0, comparisons: 0, matched: 0 };

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe.skipIf(PG_SKIPPED)("LIKE fuzz", () => {
	beforeAll(async () => {
		await assertPostgresReachable();
		pg = openPg();
		await pg.db.execute(sql.raw(`drop table if exists "${TABLE}" cascade`));
		await pg.db.execute(
			sql.raw(`create table "${TABLE}" ("id" text primary key, "title" text not null)`),
		);
	});

	afterAll(async () => {
		if (pg !== undefined) {
			await pg.db.execute(sql.raw(`drop table if exists "${TABLE}" cascade`));
			await pg.close();
		}
	});

	it(`agrees with matchLikeTokens on every generated pattern (${String(RUNS)} runs × ${String(ESCAPE_CHARS.length)} escape chars)`, async () => {
		await fc.assert(
			fc.asyncProperty(scenarioArb, async (scenario) => {
				const ids = await seed(scenario.subjects);

				// The oracle: token-level matching, no pattern string anywhere.
				const expected = new Set(
					scenario.subjects
						.filter((subject) => matchLikeTokens(subject, scenario.pattern))
						.map((subject) => ids.get(subject) as string),
				);

				stats.runs += 1;
				stats.comparisons += scenario.subjects.length;
				stats.matched += expected.size;

				for (const escapeChar of ESCAPE_CHARS) {
					const selected = await selectMatching(scenario.pattern, escapeChar);
					if (!sameSet(expected, selected)) {
						throw new Error(describeMismatch(scenario, escapeChar, ids, expected, selected));
					}
				}
			}),
			{ numRuns: RUNS },
		);

		// oxlint-disable-next-line eslint/no-console -- a coverage figure nobody can see is a coverage figure nobody checks
		console.log(
			`  like fuzz coverage: ${String(stats.runs)} runs, ${String(stats.comparisons)} strings, ` +
				`${String(stats.matched)} matches`,
		);

		// Two empty sets are trivially equal, so the property above proves nothing
		// unless patterns actually matched something and actually failed to match
		// something.
		expect(stats.runs).toBe(RUNS);
		expect(stats.matched).toBeGreaterThan(0);
		expect(stats.matched).toBeLessThan(stats.comparisons);
	});

	// -------------------------------------------------------------------------
	// The specific traps, named
	// -------------------------------------------------------------------------

	interface Trap {
		readonly name: string;
		readonly pattern: readonly LikeToken[];
		readonly matches: readonly string[];
		readonly misses: readonly string[];
	}

	const TRAPS: readonly Trap[] = [
		{
			name: "a literal % is not a wildcard",
			pattern: [{ literal: "50% off" }],
			matches: ["50% off"],
			misses: ["50 off", "5000 off", "50%% off"],
		},
		{
			name: "a literal _ is not a single-character wildcard",
			pattern: [{ literal: "a_b" }],
			matches: ["a_b"],
			misses: ["axb", "ab"],
		},
		{
			name: "a literal backslash is data, not an escape",
			pattern: [{ literal: "back\\slash" }],
			matches: ["back\\slash"],
			misses: ["backslash", "back\\\\slash"],
		},
		{
			name: "a literal * (the policy wrote \\*) matches only an asterisk",
			pattern: [{ literal: "a*b" }],
			matches: ["a*b"],
			misses: ["ab", "axb", "a%b"],
		},
		{
			name: "the wildcard token matches any sequence, including empty",
			pattern: [{ literal: "a" }, { wildcard: true }, { literal: "b" }],
			matches: ["ab", "axb", "a%b", "a_b", "a\\b"],
			misses: ["a", "b", "ba"],
		},
		{
			name: "a lone wildcard matches everything, including the empty string",
			pattern: [{ wildcard: true }],
			matches: ["", "a", "%", "_", "\\", "🙂"],
			misses: [],
		},
		{
			name: "an empty pattern matches only the empty string",
			pattern: [],
			matches: [""],
			misses: ["a", "%", " "],
		},
		{
			name: "consecutive wildcards behave as one",
			pattern: [{ wildcard: true }, { wildcard: true }, { literal: "z" }],
			matches: ["z", "az", "aaz"],
			misses: ["za", ""],
		},
		{
			name: "matching is case-sensitive, as Cedar's like is",
			pattern: [{ literal: "Alpha" }],
			matches: ["Alpha"],
			misses: ["alpha", "ALPHA"],
		},
		{
			name: "an astral character is one character to the wildcard",
			pattern: [{ literal: "a" }, { wildcard: true }, { literal: "b" }],
			matches: ["a🙂b", "a🙂🙂b"],
			misses: ["a🙂", "🙂b"],
		},
		{
			name: "a quote and a semicolon are data",
			pattern: [{ literal: "'; drop table x; --" }],
			matches: ["'; drop table x; --"],
			misses: ["drop table x"],
		},
	];

	for (const trap of TRAPS) {
		for (const escapeChar of ESCAPE_CHARS) {
			it(`${trap.name} (ESCAPE ${JSON.stringify(escapeChar)})`, async () => {
				const subjects = [...trap.matches, ...trap.misses];
				const ids = await seed(subjects);
				const selected = await selectMatching(trap.pattern, escapeChar);

				for (const subject of trap.matches) {
					expect(matchLikeTokens(subject, trap.pattern), `oracle: ${JSON.stringify(subject)}`).toBe(
						true,
					);
					expect(selected.has(ids.get(subject) as string), `sql: ${JSON.stringify(subject)}`).toBe(
						true,
					);
				}
				for (const subject of trap.misses) {
					expect(matchLikeTokens(subject, trap.pattern), `oracle: ${JSON.stringify(subject)}`).toBe(
						false,
					);
					expect(selected.has(ids.get(subject) as string), `sql: ${JSON.stringify(subject)}`).toBe(
						false,
					);
				}
			});
		}
	}

	it("escapes the escape character itself", () => {
		// Without this, a literal `\` in a Cedar pattern would escape whatever
		// followed it — turning `back\%slash` into a pattern matching `back%slash`.
		expect(likeTokensToPattern([{ literal: "a\\b" }], { escapeChar: "\\" })).toBe("a\\\\b");
		expect(likeTokensToPattern([{ literal: "a~b" }], { escapeChar: "~" })).toBe("a~~b");
		// And a backslash under a `~` escape is *not* escaped — it is ordinary text
		// there, and escaping it would produce `~\`, an invalid escape sequence.
		expect(likeTokensToPattern([{ literal: "a\\b" }], { escapeChar: "~" })).toBe("a\\b");
	});

	it("refuses an escape character that is itself a wildcard", () => {
		// A `%` escape character cannot be distinguished from the wildcard it is
		// meant to protect, so there is no pattern this could produce correctly.
		expect(() => likeTokensToPattern([{ literal: "a" }], { escapeChar: "%" })).toThrow(TypeError);
		expect(() => likeTokensToPattern([{ literal: "a" }], { escapeChar: "_" })).toThrow(TypeError);
	});
});

function sameSet(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
	return left.size === right.size && [...left].every((value) => right.has(value));
}

function describeMismatch(
	scenario: { pattern: readonly LikeToken[]; subjects: readonly string[] },
	escapeChar: string,
	ids: ReadonlyMap<string, string>,
	expected: ReadonlySet<string>,
	selected: ReadonlySet<string>,
): string {
	const byId = new Map([...ids].map(([title, id]) => [id, title]));
	const show = (set: ReadonlySet<string>): string =>
		[...set]
			.toSorted()
			.map((id) => JSON.stringify(byId.get(id)))
			.join(", ");

	return [
		`Cedar's like and SQL LIKE disagree (ESCAPE ${JSON.stringify(escapeChar)}).`,
		`  tokens:  ${JSON.stringify(scenario.pattern)}`,
		`  pattern: ${JSON.stringify(likeTokensToPattern(scenario.pattern, { escapeChar }))}`,
		`  oracle matched: [${show(expected)}]`,
		`  sql matched:    [${show(selected)}]`,
		`  over-shared (sql matched, oracle did not): [${show(
			new Set([...selected].filter((id) => !expected.has(id))),
		)}]`,
		`  over-blocked (oracle matched, sql did not): [${show(
			new Set([...expected].filter((id) => !selected.has(id))),
		)}]`,
	].join("\n");
}
