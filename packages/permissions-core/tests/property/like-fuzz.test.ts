import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { CedarBinding } from "../../src/cedar/binding.ts";
import { loadCedar } from "../../src/cedar/loader.ts";
import { PermissionsEngine, createEngine } from "../../src/engine.ts";
import { MemoryPolicyStore } from "../../src/policy/memory-policy-store.ts";
import { policyRecordFromText } from "../../src/policy/policy-codec.ts";
import { matchLikeTokens } from "../../src/plan/evaluate-plan.ts";
import { formatLikePattern, likeTokensToPattern } from "../../src/plan/plan-node.ts";
import type { LikeToken, PlanNode } from "../../src/plan/plan.ts";
import { testVocabulary, type TestVocabulary } from "../../src/testing/fixtures.ts";
import { fixedEntities, docEntity, type DocRow } from "../fixtures/doc-population.ts";

/**
 * LIKE fuzz (core.md §8 item 4) — the `%`/`_`/`*`/`\` escaping trap.
 *
 * Cedar hands `like` patterns over **tokenised**: `like "a\*b*_%c"` arrives as
 * `[{Literal:"a"},{Literal:"*"},{Literal:"b"},"Wildcard",{Literal:"_"},…]`.
 * A `%` or `_` can therefore only ever appear inside a `Literal` — Cedar does not
 * treat them as metacharacters at all — while `*` is the wildcard and `\*` is a
 * literal asterisk. SQL's metacharacters are the exact complement of that, which
 * is why re-serialising tokens to a string anywhere between Cedar and the
 * database turns a literal `%` in a policy into a wildcard in the query.
 *
 * Three oracles have to agree on every generated (pattern, string) pair:
 *
 *   1. **Real Cedar.** The pattern is rendered back into policy source and run
 *      through `engine.check()` per string. This is ground truth.
 *   2. **`matchLikeTokens`** — what the reference interpreter, and therefore every
 *      driver differential, uses.
 *   3. **`likeTokensToPattern` + a SQL-LIKE interpreter** written from scratch
 *      below. This is the driver-escaping trap's oracle: it is what a database
 *      will actually do with the pattern the driver hands it.
 *
 * A fourth check closes the loop: the tokens Cedar produces from the rendered
 * source are compared against the tokens the test started from, so a rendering
 * bug cannot hide by being symmetric with a parsing bug.
 */

const RUNS = Number.parseInt(process.env["LIKE_FUZZ_RUNS"] ?? "60", 10);

const TENANT = "org:1";
const PRINCIPAL = { type: "User", id: "u1" } as const;
const ACTION = "doc:read";
const FIXTURE_TIME = new Date("2026-07-30T00:00:00.000Z");
const FIXED = fixedEntities();

let cedar: CedarBinding;
let instanceCounter = 0;
const engines: PermissionsEngine<TestVocabulary>[] = [];

beforeAll(async () => {
	cedar = await loadCedar();
});

afterAll(async () => {
	await Promise.all(engines.map((engine) => engine.dispose()));
});

// ---------------------------------------------------------------------------
// The alphabet
// ---------------------------------------------------------------------------

/**
 * Every character that means something to somebody.
 *
 * `%` and `_` are SQL wildcards and Cedar literals; `*` is a Cedar wildcard and a
 * SQL literal; `\` is the escape character on both sides and has to survive being
 * one; `"` terminates a Cedar string literal early; `é` is multi-byte and `😀` is
 * astral, so a matcher that walks UTF-16 units rather than code points splits it.
 */
const ALPHABET: readonly string[] = ["a", "b", "%", "_", "*", "\\", '"', " ", "é", "😀"];

const literalChar = fc.constantFrom(...ALPHABET);

/** A token stream, generated in the canonical form rather than parsed out of text. */
const tokensArb: fc.Arbitrary<readonly LikeToken[]> = fc.array(
	fc.oneof(
		{ arbitrary: literalChar.map((literal): LikeToken => ({ literal })), weight: 3 },
		{ arbitrary: fc.constant<LikeToken>({ wildcard: true }), weight: 2 },
	),
	{ maxLength: 8 },
);

const textArb: fc.Arbitrary<string> = fc
	.array(literalChar, { maxLength: 10 })
	.map((chars) => chars.join(""));

/**
 * A subject string built *from* the pattern, so it usually matches.
 *
 * Purely random subjects almost never satisfy a random pattern, and a fuzz that
 * only ever observes "no match" agrees with anything — including an interpreter
 * that returns `false` unconditionally. Filling each wildcard with 0–2 characters
 * and leaving the literals alone produces a match by construction; the mutation
 * arm then perturbs one character so near-misses are covered too.
 */
function derivedTextArb(tokens: readonly LikeToken[]): fc.Arbitrary<string> {
	const pieces = tokens.map((token) =>
		"wildcard" in token
			? fc.array(literalChar, { maxLength: 2 }).map((chars) => chars.join(""))
			: fc.constant(token.literal),
	);

	const exact =
		pieces.length === 0
			? fc.constant("")
			: fc.tuple(...pieces).map((parts) => (parts as string[]).join(""));

	return fc.oneof(
		{ arbitrary: exact, weight: 3 },
		{
			// One character appended, prepended or swapped in — the near-miss family,
			// which is where an off-by-one in the backtracking shows up.
			arbitrary: fc
				.tuple(exact, literalChar, fc.constantFrom("prefix", "suffix", "swap"))
				.map(([text, extra, how]) => {
					if (how === "prefix") {
						return extra + text;
					}
					if (how === "suffix") {
						return text + extra;
					}
					// oxlint-disable-next-line typescript/no-misused-spread -- code points, so an astral swap stays one character
					const chars = [...text];
					if (chars.length === 0) {
						return extra;
					}
					chars[0] = extra;
					return chars.join("");
				}),
			weight: 2,
		},
		{ arbitrary: textArb, weight: 1 },
	);
}

// ---------------------------------------------------------------------------
// Rendering tokens back into Cedar source
// ---------------------------------------------------------------------------

/**
 * A token stream as it would be written inside `like "..."` in a policy.
 *
 * Only three characters need escaping, and each for a different reason: `\`
 * because it introduces an escape, `"` because it closes the string, and `*`
 * because unescaped it *is* the wildcard. Verified against 4.12.0: `\%` is a
 * parse error ("the input `\%` is not a valid escape"), so escaping `%` here —
 * the instinct a SQL author brings — would not even compile.
 */
function tokensToCedarSource(tokens: readonly LikeToken[]): string {
	let source = "";

	for (const token of tokens) {
		if ("wildcard" in token) {
			source += "*";
			continue;
		}
		for (const character of token.literal) {
			if (character === "\\" || character === '"' || character === "*") {
				source += `\\${character}`;
			} else {
				source += character;
			}
		}
	}

	return source;
}

// ---------------------------------------------------------------------------
// A SQL LIKE interpreter, written from scratch
// ---------------------------------------------------------------------------

/**
 * `text LIKE pattern ESCAPE escapeChar`, implemented independently of everything
 * else in this package.
 *
 * Deliberately naive and deliberately not sharing code with `matchLikeTokens`:
 * two implementations that agree because they are the same implementation prove
 * nothing about the escaping. `%` is any sequence, `_` is exactly one character,
 * and `escapeChar` makes the next character literal.
 */
function sqlLike(text: string, pattern: string, escapeChar: string): boolean {
	type SqlPart = { kind: "any" } | { kind: "one" } | { kind: "char"; value: string };

	const parts: SqlPart[] = [];
	// oxlint-disable-next-line typescript/no-misused-spread -- code points, so an astral character stays one character
	const patternChars = [...pattern];

	for (let index = 0; index < patternChars.length; index += 1) {
		const character = patternChars[index] as string;

		if (character === escapeChar) {
			const next = patternChars[index + 1];
			if (next === undefined) {
				throw new Error(
					`dangling escape at the end of the LIKE pattern ${JSON.stringify(pattern)}`,
				);
			}
			parts.push({ kind: "char", value: next });
			index += 1;
			continue;
		}
		if (character === "%") {
			parts.push({ kind: "any" });
			continue;
		}
		if (character === "_") {
			parts.push({ kind: "one" });
			continue;
		}
		parts.push({ kind: "char", value: character });
	}

	// oxlint-disable-next-line typescript/no-misused-spread -- as above
	const chars = [...text];

	function match(partIndex: number, charIndex: number): boolean {
		if (partIndex === parts.length) {
			return charIndex === chars.length;
		}

		const part = parts[partIndex] as SqlPart;

		if (part.kind === "any") {
			for (let skip = charIndex; skip <= chars.length; skip += 1) {
				if (match(partIndex + 1, skip)) {
					return true;
				}
			}
			return false;
		}
		if (charIndex >= chars.length) {
			return false;
		}
		if (part.kind === "one") {
			return match(partIndex + 1, charIndex + 1);
		}
		return chars[charIndex] === part.value && match(partIndex + 1, charIndex + 1);
	}

	return match(0, 0);
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function docWithTitle(id: string, title: string): DocRow {
	return {
		id,
		folder: "f1",
		owner: "u1",
		status: "draft",
		title,
		size: 1,
		archived: false,
		labels: [],
	};
}

/** Builds an engine holding exactly one `like` policy over `resource.title`. */
async function engineForPattern(source: string): Promise<PermissionsEngine<TestVocabulary>> {
	instanceCounter += 1;
	const text =
		`permit(principal, action == Test::Action::"doc:read", resource) ` +
		`when { resource.title like "${source}" };`;

	const engine = await createEngine<TestVocabulary>({
		vocabulary: testVocabulary,
		policyStore: new MemoryPolicyStore({
			policies: [
				policyRecordFromText(cedar, { id: "p0", scope: TENANT, text, updatedAt: FIXTURE_TIME }),
			],
		}),
		instanceId: `like-fuzz-${String(instanceCounter)}`,
		cedar,
	});
	engines.push(engine);
	return engine;
}

/** The `like` node Cedar's own partial evaluation produced for that policy. */
function likeNodeOf(condition: PlanNode): Extract<PlanNode, { op: "like" }> {
	if (condition.op !== "like") {
		throw new Error(`expected the plan to compile to a single like node, got ${condition.op}`);
	}
	return condition;
}

// ---------------------------------------------------------------------------
// The property
// ---------------------------------------------------------------------------

describe("like fuzz", () => {
	it(`agrees with Cedar, the interpreter and SQL LIKE (${String(RUNS)} runs)`, async () => {
		let pairs = 0;
		let matches = 0;

		await fc.assert(
			fc.asyncProperty(
				tokensArb.chain((tokens) =>
					fc.tuple(
						fc.constant(tokens),
						fc.array(derivedTextArb(tokens), { minLength: 4, maxLength: 12 }),
					),
				),
				async ([tokens, texts]) => {
					const source = tokensToCedarSource(tokens);
					const engine = await engineForPattern(source);

					// Loop-closing check: what Cedar tokenised our rendered source into
					// must be what we rendered it from. A rendering bug that happened to
					// be symmetric with a parsing bug would pass every match assertion
					// below and still hand a driver the wrong pattern.
					const plan = await engine.plan({
						scope: TENANT,
						principal: PRINCIPAL,
						action: ACTION,
						resourceType: "Doc",
						entities: FIXED,
					});
					if (plan.kind !== "CONDITIONAL") {
						throw new Error(`expected a CONDITIONAL plan for like "${source}", got ${plan.kind}`);
					}
					const node = likeNodeOf(plan.condition);
					expect(normalizeTokens(node.pattern)).toEqual(normalizeTokens(tokens));

					// Ground truth: real Cedar, one check per string.
					const rows = texts.map((text, index) => docWithTitle(`d${String(index)}`, text));
					const results = await engine.checkMany(
						rows.map((row) => ({
							scope: TENANT,
							principal: PRINCIPAL,
							action: ACTION,
							resource: { type: "Doc" as const, id: row.id },
							entities: [...FIXED, docEntity(row)],
						})),
					);

					const sqlPattern = likeTokensToPattern(node.pattern, { escapeChar: "\\" });

					results.forEach((result, index) => {
						const text = texts[index] as string;
						const expected = result.allowed;

						pairs += 1;
						if (expected) {
							matches += 1;
						}

						const interpreted = matchLikeTokens(text, node.pattern);
						const viaSql = sqlLike(text, sqlPattern, "\\");

						if (interpreted !== expected || viaSql !== expected) {
							throw new Error(
								[
									"like oracles disagree.",
									`  cedar source : like "${source}"`,
									`  tokens       : ${formatLikePattern(node.pattern)}`,
									`  sql pattern  : ${JSON.stringify(sqlPattern)} ESCAPE '\\'`,
									`  subject      : ${JSON.stringify(text)}`,
									`  cedar        : ${String(expected)}`,
									`  interpreter  : ${String(interpreted)}`,
									`  sql          : ${String(viaSql)}`,
								].join("\n"),
							);
						}
					});
				},
			),
			{ numRuns: RUNS, verbose: true },
		);

		// oxlint-disable-next-line eslint/no-console -- as above: the vacuity numbers are the point
		console.log(`  like-fuzz coverage: ${String(pairs)} pairs, ${String(matches)} matched`);

		// Vacuity guard: a fuzz where nothing ever matched would agree perfectly and
		// mean nothing. Both outcomes have to occur.
		expect(pairs).toBeGreaterThan(0);
		expect(matches).toBeGreaterThan(0);
		expect(matches).toBeLessThan(pairs);
	}, 600_000);
});

/** Merges adjacent literals so `[{a},{b}]` and `[{ab}]` compare equal. */
function normalizeTokens(tokens: readonly LikeToken[]): LikeToken[] {
	const merged: LikeToken[] = [];

	for (const token of tokens) {
		if ("wildcard" in token) {
			merged.push({ wildcard: true });
			continue;
		}
		const previous = merged.at(-1);
		if (previous !== undefined && "literal" in previous) {
			merged[merged.length - 1] = { literal: previous.literal + token.literal };
			continue;
		}
		merged.push({ literal: token.literal });
	}

	return merged;
}

// ---------------------------------------------------------------------------
// Regression pins
// ---------------------------------------------------------------------------

describe("like escaping, pinned", () => {
	it.each([
		// [tokens, subject, expected]
		[[{ literal: "50%" }], "50%", true],
		[[{ literal: "50%" }], "50x", false],
		[[{ literal: "a" }, { wildcard: true }], "abc", true],
		[[{ literal: "_" }], "x", false],
		[[{ literal: "_" }], "_", true],
		[[{ literal: "*" }], "*", true],
		[[{ literal: "*" }], "anything", false],
		[[{ wildcard: true }], "anything", true],
		[[{ wildcard: true }], "", true],
		[[], "", true],
		[[], "x", false],
		[[{ literal: "😀" }, { wildcard: true }], "😀ok", true],
		[[{ wildcard: true }, { literal: "😀" }], "ok😀", true],
	] as const)("matches %j against %j", (tokens, subject, expected) => {
		// The interpreter and the SQL round-trip must both agree with the pin. The
		// `_` and `%` rows are the whole point: they are ordinary characters to
		// Cedar and metacharacters to SQL, so a driver that forgot to escape them
		// would pass the first assertion and fail the second.
		expect(matchLikeTokens(subject, tokens)).toBe(expected);
		expect(sqlLike(subject, likeTokensToPattern(tokens, { escapeChar: "\\" }), "\\")).toBe(
			expected,
		);
	});
});
