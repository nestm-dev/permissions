// The reference plan interpreter (core.md §5.7).
//
// Exported from `@nestm/permissions-core/testing`. Its whole reason to exist is
// differential testing: a driver runs its generated SQL against a fixture table,
// runs this over the same rows, and asserts set equality. If the two disagree,
// exactly one of them is selecting rows Cedar never authorized.
//
// That makes the semantics of *this* file the specification the drivers are held
// to, so every rule below is stated explicitly rather than inherited from
// whatever JavaScript's `==` happens to do:
//
//   * **Three-valued, like SQL.** A leaf that reads an attribute the row does not
//     have evaluates to UNKNOWN, not `false`, and UNKNOWN propagates through
//     `and`/`or`/`not` by Kleene's rules — the same rules Postgres applies to
//     NULL. `evaluatePlanNode` then collapses a top-level UNKNOWN to `false`,
//     which is what `WHERE <expr>` does to a NULL. Two-valued logic would
//     disagree with every driver on `NOT(col = 'x')` over a NULL column.
//   * **Total semantics.** Cedar *errors* on an unguarded optional access and
//     drops the policy; the compiler models the guarded form, and `validateOnLoad`
//     refuses the unguarded one (errata core.md 7). Under a `has` guard —
//     `resource has x && resource.x == 5` — Cedar, this interpreter and SQL all
//     agree, because `false && UNKNOWN` is `false` in all three.
//   * **Cedar `in` is reflexive.** `inHierarchy` is descendant-*or-self*; an
//     interpreter that only walked strict ancestors would disagree with `check()`
//     on every self-match, which is a silent over-block in a driver's differential.
//   * **`like` is evaluated over the token array**, never over a rendered pattern.
//     Re-serialising tokens to a string is the `%`/`_` injection trap the tokens
//     exist to prevent (delta D5), and a reference implementation that fell into
//     it would validate a driver that fell into it too.
//
// A row value whose JavaScript type cannot represent the `PlanValue` it is
// compared against is a **throw**, not a `false`. This is a test oracle: a fixture
// that stores `"3"` where the vocabulary says `Long` is a bug in the fixture, and
// silently answering `false` would hide it behind a passing differential.

import type { EntityRef } from "../cedar/uid.ts";
import { PermissionsError } from "../diagnostics/errors.ts";
import { assertOrderable } from "./plan-node.ts";
import type { AttrPath, LikeToken, PlanCmp, PlanNode, PlanValue } from "./plan.ts";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * The interpreter could not answer a node.
 *
 * Always a configuration or fixture problem — a missing `HierarchyResolver`
 * (**D7**), an attribute path deeper than the compiler can produce, or a row
 * value of the wrong JavaScript type. Never a "this row does not match": that is
 * a `false`, and it never throws.
 */
export class PlanEvaluationError extends PermissionsError {
	override readonly name = "PlanEvaluationError";

	constructor(message: string, options: ErrorOptions = {}) {
		super("PLAN_EVALUATION", message, options);
	}
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

/**
 * One row, as a map from **depth-1** attribute name to its JavaScript value.
 *
 * Depth 1 because that is all a compiled plan ever contains: `AttrPath.path`
 * has exactly one element in anything this package compiles, since a nested
 * access needs a join the core cannot know about and is rejected at compile time.
 *
 * A key that is absent, or present with the value `undefined` or `null`, is
 * **absent**: `null` is what a driver reading a nullable column produces for a
 * Cedar optional attribute that was never set, and treating it as a value would
 * make `col IS NULL` rows match `col != 'x'`.
 *
 * Accepted value shapes, per {@link PlanValue} kind:
 *
 * | kind       | row value                                        | comparison |
 * |------------|--------------------------------------------------|------------|
 * | `string`   | `string`                                         | code-unit exact, case-sensitive |
 * | `long`     | `number` (must be an integer) or `bigint`        | exact, via `bigint` |
 * | `bool`     | `boolean`                                        | identity |
 * | `entity`   | `string` id, or `{ type, id }`                   | a bare string compares against the id alone — the column implies the type |
 * | `datetime` | `Date`, or an ISO-8601 `string`, or epoch `number`/`bigint` ms | epoch milliseconds |
 * | `duration` | `number` or `bigint` milliseconds                | milliseconds |
 * | `decimal`  | `string`, `number` or `bigint`                   | fixed-point, 4 fractional digits (Cedar's own precision) |
 * | `ipaddr`   | `string`                                         | parsed to (version, address bytes, prefix length) |
 * | `set`      | `readonly unknown[]`                             | unordered, duplicate-insensitive, element-wise |
 *
 * Anything else throws {@link PlanEvaluationError}.
 */
export type PlanRow = Readonly<Record<string, unknown>>;

/** What a {@link HierarchyResolver} is asked. */
export interface HierarchyQuery {
	/**
	 * Attribute holding the child reference, or `null` when the **row itself** is
	 * the child (Cedar `resource in P`).
	 */
	readonly attr: string | null;
	/** `EvaluatePlanOptions.rowId`, when the caller supplied one. */
	readonly rowId: string | undefined;
	/** The ancestor being tested against. Vocabulary-local type, not namespaced. */
	readonly parent: EntityRef<string>;
	/**
	 * The row being evaluated.
	 *
	 * Not part of the minimal `{ attr, rowId, parent }` contract — a resolver that
	 * destructures only those three still type-checks — but supplied because a
	 * fixture-backed resolver usually wants the row it is being asked about.
	 */
	readonly row: PlanRow;
	/** `row[attr]`, or `undefined` when `attr` is `null`. */
	readonly value: unknown;
}

/**
 * Answers "is this row (or this attribute of it) a descendant-or-self of
 * `parent`?".
 *
 * **D7**: required whenever the plan tree contains an `inHierarchy` node, and it
 * must answer with a `boolean`. Returning anything else — `undefined` for "I do
 * not know" — throws {@link PlanEvaluationError} rather than defaulting, because
 * both defaults are wrong: `true` over-shares and `false` silently over-blocks a
 * differential into passing.
 */
export type HierarchyResolver = (query: HierarchyQuery) => boolean;

/** Options for {@link evaluatePlanNode}. */
export interface EvaluatePlanOptions {
	/** Id of the row, for `inHierarchy` nodes rooted at the row itself. */
	readonly rowId?: string;
	/**
	 * Entity type the rows belong to.
	 *
	 * Required only when the tree still contains an `isType` node. A plan compiled
	 * by this package never does — `simplifyPlanNode` folds `isType` against the
	 * planned resource type — so this is for hand-built trees.
	 */
	readonly resourceType?: string;
	/** Hierarchy oracle. Required iff the tree contains `inHierarchy` (**D7**). */
	readonly hierarchy?: HierarchyResolver;
}

// ---------------------------------------------------------------------------
// Three-valued logic
// ---------------------------------------------------------------------------

/**
 * Kleene truth value.
 *
 * `undefined` is UNKNOWN — SQL's NULL. It is produced by exactly one thing: a
 * leaf that had to read an attribute the row does not have.
 */
type Truth = boolean | undefined;

/** Kleene `NOT`. UNKNOWN is its own negation. */
function notTruth(value: Truth): Truth {
	return value === undefined ? undefined : !value;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Evaluates a compiled plan condition against one row.
 *
 * ```ts
 * const plan = await engine.plan({ scope, principal, action: "run:read", resourceType: "Run" });
 * const selected = rows.filter((row) =>
 *   plan.kind === "ALWAYS_ALLOW" ||
 *   (plan.kind === "CONDITIONAL" &&
 *     evaluatePlanNode(plan.condition, row, { rowId: row.id, resourceType: "Run" })),
 * );
 * ```
 *
 * A top-level UNKNOWN collapses to `false`, exactly as `WHERE <expr>` drops a row
 * whose predicate is NULL.
 *
 * @throws {@link PlanEvaluationError} when the tree needs something the options
 * did not supply (a `HierarchyResolver` for an `inHierarchy` node, a
 * `resourceType` for an `isType` node), when it contains a shape the compiler
 * cannot produce (a `principal`-rooted path, a path deeper than 1), or when a row
 * value's JavaScript type cannot represent the `PlanValue` it is compared with.
 */
export function evaluatePlanNode(
	node: PlanNode,
	row: PlanRow,
	options: EvaluatePlanOptions = {},
): boolean {
	// Eager, before a single row is looked at: a `&&` that short-circuits away the
	// only `inHierarchy` in the tree would otherwise let a missing resolver ship,
	// and surface as wrong rows on whichever row first reaches that branch.
	assertResolvable(node, options);

	return evaluate(node, row, options) === true;
}

/**
 * Convenience over {@link evaluatePlanNode}: keeps the rows the condition selects.
 *
 * `rowId` is derived per row so a driver's differential does not have to thread it
 * manually; everything else in `options` is shared.
 */
export function filterRowsByPlan<Row extends PlanRow>(
	rows: readonly Row[],
	node: PlanNode,
	// `rowId` is replaced rather than intersected: `EvaluatePlanOptions` declares it
	// as a `string`, and `string & ((row) => string)` is uninhabited.
	options: Omit<EvaluatePlanOptions, "rowId"> & { readonly rowId?: (row: Row) => string } = {},
): Row[] {
	const { rowId, ...shared } = options;

	return rows.filter((row) =>
		evaluatePlanNode(node, row, rowId === undefined ? shared : { ...shared, rowId: rowId(row) }),
	);
}

// ---------------------------------------------------------------------------
// Pre-flight
// ---------------------------------------------------------------------------

/** Walks the tree once for the two things the options, not the row, must satisfy (**D7**). */
function assertResolvable(node: PlanNode, options: EvaluatePlanOptions): void {
	switch (node.op) {
		case "and":
		case "or": {
			for (const child of node.nodes) {
				assertResolvable(child, options);
			}
			return;
		}
		case "not": {
			assertResolvable(node.node, options);
			return;
		}
		case "inHierarchy": {
			if (options.hierarchy === undefined) {
				throw new PlanEvaluationError(
					`The plan contains "${formatNodeBriefly(node)}" but no hierarchy resolver was ` +
						`supplied. Cedar's "in" is descendant-or-self over a graph no row carries, so it ` +
						`cannot be answered from row values alone — pass options.hierarchy.`,
				);
			}
			return;
		}
		case "in": {
			if (node.attr === null && node.values.length > 0) {
				if (options.rowId === undefined || options.resourceType === undefined) {
					throw new PlanEvaluationError(
						"A row-identity membership plan requires both options.rowId and options.resourceType.",
					);
				}
			}
			return;
		}
		case "isType": {
			if (options.resourceType === undefined) {
				throw new PlanEvaluationError(
					`The plan contains "resource is ${node.entityType}" but no resourceType was ` +
						`supplied. A compiled plan never carries an isType node (it folds against the ` +
						`planned type); a hand-built one must say what the rows are.`,
				);
			}
			return;
		}
		default: {
			return;
		}
	}
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

function evaluate(node: PlanNode, row: PlanRow, options: EvaluatePlanOptions): Truth {
	switch (node.op) {
		case "true": {
			return true;
		}
		case "false": {
			return false;
		}

		case "and": {
			// Kleene AND: one FALSE decides it; otherwise an UNKNOWN poisons the rest.
			// Note this is *not* short-circuiting on UNKNOWN — `UNKNOWN && false` is
			// `false`, which is exactly why `resource has x && resource.x == 5` agrees
			// with Cedar no matter which conjunct is written first.
			let unknown = false;
			for (const child of node.nodes) {
				const value = evaluate(child, row, options);
				if (value === false) {
					return false;
				}
				if (value === undefined) {
					unknown = true;
				}
			}
			return unknown ? undefined : true;
		}

		case "or": {
			let unknown = false;
			for (const child of node.nodes) {
				const value = evaluate(child, row, options);
				if (value === true) {
					return true;
				}
				if (value === undefined) {
					unknown = true;
				}
			}
			return unknown ? undefined : false;
		}

		case "not": {
			return notTruth(evaluate(node.node, row, options));
		}

		case "cmp": {
			const value = attrValue(node.attr, row);
			return value === ABSENT ? undefined : compare(node.cmp, value, node.value);
		}

		case "in": {
			if (node.attr === null) {
				return node.values.some((candidate) => {
					if (candidate.kind !== "entity") {
						throw new PlanEvaluationError(
							"A row-identity membership plan may contain only entity references.",
						);
					}
					return (
						candidate.value.type === options.resourceType && candidate.value.id === options.rowId
					);
				});
			}

			// `["a","b"].contains(resource.status)` — a scalar column against a set of
			// constants. Cedar sets are unordered, so this is plain membership.
			const value = attrValue(node.attr, row);
			if (value === ABSENT) {
				return undefined;
			}
			return node.values.some((candidate) => valueEquals(value, candidate));
		}

		case "contains": {
			// `resource.labels.contains("x")` — a set-valued column holding an element.
			const value = attrValue(node.attr, row);
			if (value === ABSENT) {
				return undefined;
			}
			return elementsOf(value, node.attr).some((element) => valueEquals(element, node.value));
		}

		case "like": {
			const value = attrValue(node.attr, row);
			if (value === ABSENT) {
				return undefined;
			}
			if (typeof value !== "string") {
				throw typeMismatch(node.attr, value, "a string, because `like` only applies to strings");
			}
			return matchLikeTokens(value, node.pattern);
		}

		case "exists": {
			// Cedar `resource has x`. Two-valued by construction: "is this column NULL"
			// is a definite question even when the column is NULL, which is why a
			// `has` guard rescues everything downstream of it.
			return attrValue(node.attr, row) !== ABSENT;
		}

		case "isEmpty": {
			const value = attrValue(node.attr, row);
			return value === ABSENT ? undefined : elementsOf(value, node.attr).length === 0;
		}

		case "isType": {
			// `assertResolvable` guaranteed `resourceType` is set.
			return node.entityType === options.resourceType;
		}

		case "inHierarchy": {
			return evaluateInHierarchy(node, row, options);
		}
	}
}

function evaluateInHierarchy(
	node: Extract<PlanNode, { op: "inHierarchy" }>,
	row: PlanRow,
	options: EvaluatePlanOptions,
): Truth {
	// `assertResolvable` guaranteed the resolver is present.
	const resolve = options.hierarchy as HierarchyResolver;

	let attr: string | null = null;
	let value: unknown;

	if (node.attr !== null) {
		assertDepthOne(node.attr);
		attr = node.attr.path[0] as string;
		const raw = attrValue(node.attr, row);
		// An absent reference column joins to nothing. UNKNOWN rather than `false`
		// so it composes like the NULL a driver's LEFT JOIN would produce.
		if (raw === ABSENT) {
			return undefined;
		}
		value = raw;
	}

	const answer = resolve({ attr, rowId: options.rowId, parent: node.parent, row, value });

	if (typeof answer !== "boolean") {
		throw new PlanEvaluationError(
			`The hierarchy resolver returned ${describe(answer)} for ` +
				`"${formatNodeBriefly(node)}"; it must return a boolean (D7). Remember Cedar's "in" ` +
				`is descendant-or-self: a row that *is* ${node.parent.type}::"${node.parent.id}" ` +
				`matches.`,
		);
	}

	return answer;
}

// ---------------------------------------------------------------------------
// Attribute access
// ---------------------------------------------------------------------------

/** Distinguishes "the row has no such attribute" from a legitimate value. */
const ABSENT = Symbol("absent");

function assertDepthOne(attr: AttrPath): void {
	if (attr.root !== "resource") {
		throw new PlanEvaluationError(
			`The plan reads "${attr.root}.${attr.path.join(".")}", but a row only carries resource ` +
				`attributes. A principal-rooted path means the plan was compiled for a different ` +
				`unknown than the rows being filtered.`,
		);
	}
	if (attr.path.length !== 1) {
		throw new PlanEvaluationError(
			`The plan reads "${attr.root}.${attr.path.join(".")}", a depth-${String(attr.path.length)} ` +
				`path. Compiled plans are depth 1 by construction — nested access is rejected at ` +
				`compile time as "nested-attribute" because it needs a join the core cannot know about.`,
		);
	}
}

function attrValue(attr: AttrPath, row: PlanRow): unknown {
	assertDepthOne(attr);

	const name = attr.path[0] as string;
	const value = row[name];

	// `null` is absent: it is what a driver reads back from a nullable column for
	// a Cedar optional attribute that was never set.
	return value === undefined || value === null ? ABSENT : value;
}

function elementsOf(value: unknown, attr: AttrPath): readonly unknown[] {
	if (!Array.isArray(value)) {
		throw typeMismatch(attr, value, "an array, because the node treats it as a Cedar set");
	}
	return value as readonly unknown[];
}

// ---------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------

function compare(cmp: PlanCmp, rowValue: unknown, planValue: PlanValue): boolean {
	if (cmp === "eq") {
		return valueEquals(rowValue, planValue);
	}
	if (cmp === "ne") {
		return !valueEquals(rowValue, planValue);
	}

	// The same guard the drivers call before emitting `<`: Cedar has no ordering
	// for strings, bools, entities, ipaddrs or sets, so a plan carrying one here
	// is a compiler bug, not a row that fails to match.
	assertOrderable(planValue);

	const ordering = orderOf(rowValue, planValue);

	switch (cmp) {
		case "lt": {
			return ordering < 0;
		}
		case "lte": {
			return ordering <= 0;
		}
		case "gt": {
			return ordering > 0;
		}
		case "gte": {
			return ordering >= 0;
		}
	}
}

/** `-1`/`0`/`1` for the orderable kinds. Never called for the others. */
function orderOf(rowValue: unknown, planValue: PlanValue): number {
	switch (planValue.kind) {
		case "long": {
			const left = toBigInt(rowValue, "long");
			return left === planValue.value ? 0 : left < planValue.value ? -1 : 1;
		}
		case "datetime": {
			const left = toEpochMillis(rowValue);
			const right = planValue.value.getTime();
			return left === right ? 0 : left < right ? -1 : 1;
		}
		case "duration": {
			const left = toBigInt(rowValue, "duration");
			const right = BigInt(planValue.value);
			return left === right ? 0 : left < right ? -1 : 1;
		}
		case "decimal": {
			const left = toDecimalUnits(rowValue);
			const right = decimalUnitsOfLiteral(planValue.value);
			return left === right ? 0 : left < right ? -1 : 1;
		}
		default: {
			// Unreachable: `assertOrderable` has already thrown for every other kind.
			throw new PlanEvaluationError(
				`No ordering is defined for a PlanValue of kind "${planValue.kind}".`,
			);
		}
	}
}

/**
 * Cedar equality for one row value against one `PlanValue`.
 *
 * Verified against cedar-wasm 4.12.0 for every non-obvious case:
 * `decimal("1.5") == decimal("1.50")`, `duration("1h") == duration("60m")`,
 * `datetime("2026-01-01") == datetime("2026-01-01T00:00:00Z")`,
 * `ip("1.2.3.4") == ip("1.2.3.4/32")`, `[1,2,2] == [2,1]` — all true; and
 * `ip("1.2.3.0/24") == ip("1.2.3.1/24")` — false.
 */
function valueEquals(rowValue: unknown, planValue: PlanValue): boolean {
	switch (planValue.kind) {
		case "string": {
			if (typeof rowValue !== "string") {
				throw kindMismatch(rowValue, planValue.kind, "a string");
			}
			// Code-unit exact. Cedar is case-sensitive; a driver whose column sits under
			// a case-insensitive collation over-matches, which is why the SQL compilers
			// refuse citext outright.
			return rowValue === planValue.value;
		}

		case "long": {
			return toBigInt(rowValue, "long") === planValue.value;
		}

		case "bool": {
			if (typeof rowValue !== "boolean") {
				throw kindMismatch(rowValue, planValue.kind, "a boolean");
			}
			return rowValue === planValue.value;
		}

		case "entity": {
			return entityEquals(rowValue, planValue.value);
		}

		case "datetime": {
			return toEpochMillis(rowValue) === planValue.value.getTime();
		}

		case "duration": {
			return toBigInt(rowValue, "duration") === BigInt(planValue.value);
		}

		case "decimal": {
			return toDecimalUnits(rowValue) === decimalUnitsOfLiteral(planValue.value);
		}

		case "ipaddr": {
			if (typeof rowValue !== "string") {
				throw kindMismatch(rowValue, planValue.kind, "a string holding an IP literal");
			}
			return ipEquals(rowValue, planValue.value);
		}

		case "set": {
			return setEquals(rowValue, planValue.value);
		}
	}
}

/**
 * A row's entity reference against a constant.
 *
 * A bare string compares against the **id only**: an `entity_id` column carries
 * no type, and the column's type is fixed by the vocabulary anyway. A
 * `{ type, id }` value compares both, so a fixture that models a polymorphic
 * reference still gets the type checked.
 */
function entityEquals(rowValue: unknown, reference: EntityRef<string>): boolean {
	if (typeof rowValue === "string") {
		return rowValue === reference.id;
	}
	if (typeof rowValue === "object" && rowValue !== null) {
		const candidate = rowValue as { type?: unknown; id?: unknown };
		if (typeof candidate.type === "string" && typeof candidate.id === "string") {
			return candidate.type === reference.type && candidate.id === reference.id;
		}
	}

	throw kindMismatch(rowValue, "entity", "an id string or a { type, id } object");
}

/** Cedar sets are unordered and duplicate-insensitive: mutual containment. */
function setEquals(rowValue: unknown, elements: readonly PlanValue[]): boolean {
	if (!Array.isArray(rowValue)) {
		throw kindMismatch(rowValue, "set", "an array");
	}
	const rowElements = rowValue as readonly unknown[];

	const everyRowElementExpected = rowElements.every((element) =>
		elements.some((expected) => valueEquals(element, expected)),
	);
	if (!everyRowElementExpected) {
		return false;
	}

	return elements.every((expected) =>
		rowElements.some((element) => valueEquals(element, expected)),
	);
}

// ---------------------------------------------------------------------------
// Scalar coercions
// ---------------------------------------------------------------------------

function toBigInt(value: unknown, kind: "long" | "duration"): bigint {
	if (typeof value === "bigint") {
		return value;
	}
	if (typeof value === "number") {
		if (!Number.isInteger(value)) {
			throw new PlanEvaluationError(
				`A ${kind} was compared against the non-integer number ${String(value)}. Cedar ${kind}s ` +
					`are i64; a fractional row value means the fixture and the vocabulary disagree.`,
			);
		}
		return BigInt(value);
	}
	throw kindMismatch(value, kind, "a number or a bigint");
}

function toEpochMillis(value: unknown): number {
	if (value instanceof Date) {
		const millis = value.getTime();
		if (Number.isNaN(millis)) {
			throw new PlanEvaluationError("A datetime was compared against an invalid Date.");
		}
		return millis;
	}
	if (typeof value === "string") {
		const millis = Date.parse(value);
		if (Number.isNaN(millis)) {
			throw new PlanEvaluationError(
				`A datetime was compared against ${JSON.stringify(value)}, which is not a parseable ` +
					`timestamp.`,
			);
		}
		return millis;
	}
	if (typeof value === "number" || typeof value === "bigint") {
		return Number(value);
	}
	throw kindMismatch(value, "datetime", "a Date, an ISO-8601 string, or epoch milliseconds");
}

/** Cedar decimals are fixed-point with exactly 4 fractional digits. */
const DECIMAL_SCALE = 10_000n;

/** Row-side decimal text: a sign, digits, and at most 4 fractional digits. */
const DECIMAL_TEXT = /^([+-]?)(\d+)(?:\.(\d{1,4}))?$/;

/**
 * A decimal as a count of ten-thousandths.
 *
 * Fixed-point rather than `Number`: `decimal("1.5") == decimal("1.50")` is true
 * in Cedar (verified) and `0.1 + 0.2 !== 0.3` in IEEE-754, so text comparison and
 * float comparison are both wrong.
 */
function toDecimalUnits(value: unknown): bigint {
	if (typeof value === "bigint") {
		return value * DECIMAL_SCALE;
	}
	if (typeof value === "number") {
		if (!Number.isFinite(value)) {
			throw new PlanEvaluationError(`A decimal was compared against ${String(value)}.`);
		}
		// Via text so the value is read at Cedar's precision rather than at IEEE-754's.
		return decimalUnitsOf(value.toFixed(4), String(value));
	}
	if (typeof value === "string") {
		return decimalUnitsOf(value, value);
	}
	throw kindMismatch(value, "decimal", "a decimal string, a number, or a bigint");
}

function decimalUnitsOfLiteral(literal: string): bigint {
	return decimalUnitsOf(literal, literal);
}

function decimalUnitsOf(text: string, original: string): bigint {
	const match = DECIMAL_TEXT.exec(text.trim());
	if (match === null) {
		throw new PlanEvaluationError(
			`${JSON.stringify(original)} is not a Cedar decimal: it needs an optional sign, an ` +
				`integer part, and at most 4 fractional digits.`,
		);
	}

	const [, sign, whole, fraction = ""] = match;
	const units =
		BigInt(whole as string) * DECIMAL_SCALE + BigInt(fraction.padEnd(4, "0").slice(0, 4));

	return sign === "-" ? -units : units;
}

// ---------------------------------------------------------------------------
// IP addresses
// ---------------------------------------------------------------------------

/**
 * Cedar `ipaddr` equality: same version, same address bytes, same prefix length.
 *
 * Not text equality, and not network containment. Verified against cedar-wasm
 * 4.12.0:
 *
 * ```text
 * ip("1.2.3.4")    == ip("1.2.3.4/32")   -> true    a bare address is a full-width prefix
 * ip("::1")        == ip("0:0:0:0:0:0:0:1") -> true zero-compression is not significant
 * ip("FE80::1")    == ip("fe80::1")      -> true    hex digits are case-insensitive
 * ip("1.2.3.0/24") == ip("1.2.3.1/24")   -> false   the *address*, not the network, is compared
 * ip("1.2.3.0/24") == ip("1.2.3.0/25")   -> false   the prefix length is part of the value
 * ```
 *
 * `<`/`<=` never reach here: `assertOrderable` rejects `ipaddr`, and Cedar's only
 * range operator (`isInRange`) is an extension call on the unknown, which the
 * compiler rejects as `extension-on-unknown`.
 */
function ipEquals(left: string, right: string): boolean {
	const a = parseIp(left);
	const b = parseIp(right);

	return (
		a.bits === b.bits &&
		a.prefix === b.prefix &&
		a.bytes.length === b.bytes.length &&
		a.bytes.every((byte, index) => byte === b.bytes[index])
	);
}

interface ParsedIp {
	/** 32 for v4, 128 for v6. Distinguishes the two families. */
	readonly bits: 32 | 128;
	readonly bytes: readonly number[];
	readonly prefix: number;
}

function parseIp(literal: string): ParsedIp {
	const slash = literal.lastIndexOf("/");
	const address = slash === -1 ? literal : literal.slice(0, slash);
	const suffix = slash === -1 ? undefined : literal.slice(slash + 1);

	const bytes = address.includes(":") ? parseIpv6(address, literal) : parseIpv4(address, literal);
	const bits = bytes.length === 4 ? 32 : 128;

	if (suffix === undefined) {
		return { bits, bytes, prefix: bits };
	}

	if (!/^\d{1,3}$/.test(suffix)) {
		throw new PlanEvaluationError(`${JSON.stringify(literal)} has a malformed prefix length.`);
	}
	const prefix = Number(suffix);
	if (prefix > bits) {
		throw new PlanEvaluationError(
			`${JSON.stringify(literal)} has a /${String(prefix)} prefix, longer than the ` +
				`${String(bits)} bits of the address.`,
		);
	}

	return { bits, bytes, prefix };
}

function parseIpv4(address: string, literal: string): number[] {
	const parts = address.split(".");
	if (parts.length !== 4) {
		throw new PlanEvaluationError(`${JSON.stringify(literal)} is not a valid IPv4 address.`);
	}

	return parts.map((part) => {
		// Cedar rejects leading zeros (`ip("01.2.3.4")` errors), so this does too:
		// accepting them here would make the interpreter agree with a driver that
		// stores a form Cedar itself cannot evaluate.
		if (!/^(?:0|[1-9]\d{0,2})$/.test(part)) {
			throw new PlanEvaluationError(
				`${JSON.stringify(literal)} is not a valid IPv4 address: "${part}" is not a ` +
					`leading-zero-free octet.`,
			);
		}
		const octet = Number(part);
		if (octet > 255) {
			throw new PlanEvaluationError(
				`${JSON.stringify(literal)} is not a valid IPv4 address: ${part} exceeds 255.`,
			);
		}
		return octet;
	});
}

function parseIpv6(address: string, literal: string): number[] {
	// Cedar rejects the IPv4-mapped form (`ip("::ffff:1.2.3.4")` errors), so an
	// embedded dot is a malformed address rather than a shape to support.
	if (address.includes(".")) {
		throw new PlanEvaluationError(
			`${JSON.stringify(literal)} embeds an IPv4 address in an IPv6 literal, which Cedar ` +
				`rejects.`,
		);
	}

	const halves = address.split("::");
	if (halves.length > 2) {
		throw new PlanEvaluationError(
			`${JSON.stringify(literal)} contains more than one "::" compression.`,
		);
	}

	const head = groupsOf(halves[0] ?? "", literal);
	const tail = halves.length === 2 ? groupsOf(halves[1] ?? "", literal) : [];
	const explicit = head.length + tail.length;

	if (halves.length === 1) {
		if (explicit !== 8) {
			throw new PlanEvaluationError(
				`${JSON.stringify(literal)} has ${String(explicit)} IPv6 groups; 8 are required ` +
					`without "::".`,
			);
		}
	} else if (explicit > 7) {
		throw new PlanEvaluationError(
			`${JSON.stringify(literal)} uses "::" but already spells out ${String(explicit)} groups.`,
		);
	}

	const groups = [...head, ...Array.from({ length: 8 - explicit }, () => 0), ...tail];

	return groups.flatMap((group) => [(group >> 8) & 0xff, group & 0xff]);
}

function groupsOf(half: string, literal: string): number[] {
	if (half === "") {
		return [];
	}

	return half.split(":").map((group) => {
		if (!/^[0-9A-Fa-f]{1,4}$/.test(group)) {
			throw new PlanEvaluationError(
				`${JSON.stringify(literal)} has the malformed IPv6 group "${group}".`,
			);
		}
		return Number.parseInt(group, 16);
	});
}

// ---------------------------------------------------------------------------
// LIKE
// ---------------------------------------------------------------------------

/**
 * Cedar `like`, evaluated over the **tokens**.
 *
 * Never renders a pattern string: `{ literal: "%" }` is a literal percent sign
 * and `{ literal: "*" }` a literal asterisk (the policy wrote `\*`), so any
 * round-trip through a string is a chance to promote one of them to a wildcard.
 * That promotion is exactly the injection this AST shape exists to prevent, and a
 * reference implementation that did it would bless a driver that did it too.
 *
 * Matching runs over Unicode **code points**, not UTF-16 units, so an astral
 * character is one character to `*` just as it is to Cedar.
 *
 * Exported for the LIKE fuzz suite, which cross-checks it against Cedar's own
 * decisions and against `likeTokensToPattern` + a SQL-LIKE interpreter.
 */
export function matchLikeTokens(text: string, tokens: readonly LikeToken[]): boolean {
	// oxlint-disable-next-line typescript/no-misused-spread -- code points are the unit Cedar matches on; UTF-16 units would split astral characters
	const characters = [...text];
	const parts = normalizeLikeTokens(tokens);

	let index = 0;
	// Position to resume from if a later literal fails and we have to let the last
	// wildcard swallow one more character.
	let starIndex = -1;
	let starPart = -1;
	let part = 0;

	while (index < characters.length) {
		const current = parts[part];

		if (current !== undefined && current.wildcard) {
			starPart = part;
			starIndex = index;
			part += 1;
			continue;
		}

		if (current !== undefined && matchesLiteralAt(characters, index, current.literal)) {
			// oxlint-disable-next-line typescript/no-misused-spread -- as above
			index += [...current.literal].length;
			part += 1;
			continue;
		}

		if (starPart === -1) {
			return false;
		}

		// Backtrack: the wildcard takes one more character.
		starIndex += 1;
		index = starIndex;
		part = starPart + 1;
	}

	// Trailing wildcards may match the empty string; a trailing literal may not.
	return parts.slice(part).every((remaining) => remaining.wildcard);
}

/** One `like` part: a wildcard, or a run of literal text. */
type LikePart =
	| { readonly wildcard: true; readonly literal?: undefined }
	| { readonly wildcard: false; readonly literal: string };

/**
 * Merges adjacent literals and collapses runs of wildcards.
 *
 * Cedar hands back one token per source character, so `"ab"` arrives as two
 * literals; merging them first is what keeps the matcher's backtracking linear in
 * the number of *parts* rather than in the number of characters.
 */
function normalizeLikeTokens(tokens: readonly LikeToken[]): readonly LikePart[] {
	const parts: LikePart[] = [];
	let pending = "";

	for (const token of tokens) {
		if ("wildcard" in token) {
			if (pending !== "") {
				parts.push({ wildcard: false, literal: pending });
				pending = "";
			}
			if (parts.at(-1)?.wildcard !== true) {
				parts.push({ wildcard: true });
			}
			continue;
		}
		pending += token.literal;
	}

	if (pending !== "") {
		parts.push({ wildcard: false, literal: pending });
	}

	return parts;
}

function matchesLiteralAt(characters: readonly string[], index: number, literal: string): boolean {
	// oxlint-disable-next-line typescript/no-misused-spread -- code points again
	const expected = [...literal];

	if (index + expected.length > characters.length) {
		return false;
	}
	return expected.every((character, offset) => characters[index + offset] === character);
}

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

function typeMismatch(attr: AttrPath, value: unknown, expectation: string): PlanEvaluationError {
	return new PlanEvaluationError(
		`Row attribute "${attr.path.join(".")}" holds ${describe(value)}; the plan needs ` +
			`${expectation}.`,
	);
}

function kindMismatch(value: unknown, kind: string, expectation: string): PlanEvaluationError {
	return new PlanEvaluationError(
		`A ${kind} constant was compared against ${describe(value)}; the row value must be ` +
			`${expectation}. A reference interpreter that answered "no match" here would hide the ` +
			`fixture/vocabulary mismatch behind a passing differential.`,
	);
}

/** Short, non-`[object Object]` rendering of an unexpected value. */
function describe(value: unknown): string {
	if (value === null) {
		return "null";
	}
	if (value === undefined) {
		return "undefined";
	}
	if (typeof value === "string") {
		return `the string ${JSON.stringify(value)}`;
	}
	if (typeof value === "bigint") {
		return `the bigint ${value.toString()}`;
	}
	if (typeof value === "number" || typeof value === "boolean") {
		return `the ${typeof value} ${value.toString()}`;
	}
	if (Array.isArray(value)) {
		return `an array of ${String(value.length)}`;
	}
	if (value instanceof Date) {
		return `the Date ${value.toISOString()}`;
	}
	return `a value of type ${typeof value}`;
}

/** Enough of a node to name it in an error, without pulling in the formatter. */
function formatNodeBriefly(node: Extract<PlanNode, { op: "inHierarchy" | "isType" }>): string {
	if (node.op === "isType") {
		return `resource is ${node.entityType}`;
	}
	const left = node.attr === null ? "resource" : `resource.${node.attr.path.join(".")}`;
	return `${left} in ${node.parent.type}::"${node.parent.id}"`;
}
