// Cedar residual expression grammar + normaliser (core.md §5.3 step 2).
//
// cedar-wasm's `Expr` is a union of single-key objects plus `ExtFuncCall`, which
// its own `.d.ts` types as `Record<string, Expr[]>` — i.e. structurally open.
// Narrowing that union at twenty call sites is how a compiler mistakes an
// extension call for an operator, so it happens exactly once, in `viewExpr`.
//
// What partial evaluation actually hands back (all verified against cedar-wasm
// 4.12.0, not from memory):
//
//   * the unknown is the extension call `{"unknown":[{"Value":"resource"}]}`;
//   * `principal`/`action`/`resource` scope constraints are flattened to
//     `{op:"All"}` and folded into `conditions`, so only `conditions` matters;
//   * every residual body is wrapped in a chain of `{"Value":true} && …`, one
//     per folded-away scope constraint;
//   * `>` arrives as `!(x <= k)` and `>=` as `!(x < k)`. Nothing emits `>`/`>=`
//     directly, so recovering them is mandatory, not cosmetic;
//   * a policy whose condition became constant appears as `{"Value":true}` or
//     `{"Value":false}` — including every policy that *errored*.
//
// One deliberate limitation, stated once here: this compiler models Cedar's
// **total** semantics, not its error semantics. `X || true` folds to `true` even
// though Cedar would error on that row if `X` errored. That gap is closed
// upstream — `validateOnLoad` (default on) refuses policies that read an
// optional attribute unguarded, and an errored policy makes `plan()` throw.

import type { CedarValueJson, Clause, Expr, PatternElem, Var } from "../cedar/binding.ts";

// ---------------------------------------------------------------------------
// Grammar view
// ---------------------------------------------------------------------------

/** Binary operators in Cedar's JSON expression grammar. */
export type BinaryExprOp =
	| "=="
	| "!="
	| "in"
	| "<"
	| "<="
	| ">"
	| ">="
	| "&&"
	| "||"
	| "+"
	| "-"
	| "*"
	| "contains"
	| "containsAll"
	| "containsAny"
	| "getTag"
	| "hasTag";

/** Unary operators in Cedar's JSON expression grammar. */
export type UnaryExprOp = "!" | "neg" | "isEmpty";

const BINARY_OPS: ReadonlySet<string> = new Set<BinaryExprOp>([
	"==",
	"!=",
	"in",
	"<",
	"<=",
	">",
	">=",
	"&&",
	"||",
	"+",
	"-",
	"*",
	"contains",
	"containsAll",
	"containsAny",
	"getTag",
	"hasTag",
]);

const UNARY_ARG_OPS: ReadonlySet<string> = new Set<UnaryExprOp>(["!", "neg", "isEmpty"]);

/**
 * A discriminated view of one Cedar expression node.
 *
 * `unrecognised` is not an error here: the translator turns it into a typed,
 * fail-closed rejection with the offending expression attached.
 */
export type ExprView =
	| { readonly node: "value"; readonly value: CedarValueJson }
	| { readonly node: "var"; readonly variable: Var }
	| { readonly node: "slot"; readonly slot: string }
	| { readonly node: "unary"; readonly op: UnaryExprOp; readonly arg: Expr }
	| {
			readonly node: "binary";
			readonly op: BinaryExprOp;
			readonly left: Expr;
			readonly right: Expr;
	  }
	| { readonly node: "attr"; readonly left: Expr; readonly attr: string }
	/** `left has attr…`. Cedar allows a dotted chain, which arrives as an array. */
	| { readonly node: "has"; readonly left: Expr; readonly attrs: readonly string[] }
	| { readonly node: "like"; readonly left: Expr; readonly pattern: readonly PatternElem[] }
	| {
			readonly node: "is";
			readonly left: Expr;
			readonly entityType: string;
			readonly in: Expr | undefined;
	  }
	| {
			readonly node: "ite";
			readonly condition: Expr;
			readonly whenTrue: Expr;
			readonly whenFalse: Expr;
	  }
	| { readonly node: "set"; readonly elements: readonly Expr[] }
	| { readonly node: "record"; readonly fields: Readonly<Record<string, Expr>> }
	/** Any extension call, **including** the `unknown` marker. */
	| { readonly node: "ext"; readonly fn: string; readonly args: readonly Expr[] }
	| { readonly node: "unrecognised" };

const UNRECOGNISED: ExprView = Object.freeze({ node: "unrecognised" as const });

function keysOf(expr: Expr): readonly string[] {
	if (typeof expr !== "object" || expr === null || Array.isArray(expr)) {
		return [];
	}
	return Object.keys(expr);
}

// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the single narrowing point for cedar-wasm's open `Expr` union; every field read is guarded below
const asRecord = (expr: Expr): Record<string, unknown> =>
	expr as unknown as Record<string, unknown>;

function isExpr(value: unknown): value is Expr {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exprArray(value: unknown): readonly Expr[] | undefined {
	if (!Array.isArray(value)) {
		return undefined;
	}
	return value.every((element) => isExpr(element)) ? (value as readonly Expr[]) : undefined;
}

/**
 * Narrows one Cedar expression into {@link ExprView}.
 *
 * The **only** place in this package that inspects an `Expr`'s shape. Anything
 * structurally unexpected becomes `{ node: 'unrecognised' }` rather than a cast
 * that would let a mis-shaped node be read as an operator.
 */
export function viewExpr(expr: Expr): ExprView {
	const keys = keysOf(expr);
	if (keys.length !== 1) {
		return UNRECOGNISED;
	}

	const key = keys[0] as string;
	const record = asRecord(expr);
	const payload = record[key];

	if (key === "Value") {
		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- `CedarValueJson` covers every JSON value; there is nothing to validate
		return { node: "value", value: payload as CedarValueJson };
	}
	if (key === "Var" && typeof payload === "string") {
		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- guarded by the schema; an unexpected string simply never matches a supported form
		return { node: "var", variable: payload as Var };
	}
	if (key === "Slot" && typeof payload === "string") {
		return { node: "slot", slot: payload };
	}

	if (key === "Set") {
		const elements = exprArray(payload);
		return elements === undefined ? UNRECOGNISED : { node: "set", elements };
	}

	if (key === "Record") {
		if (!isExpr(payload)) {
			return UNRECOGNISED;
		}
		const fields = asRecord(payload);
		return Object.values(fields).every((value) => isExpr(value))
			? // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- every value checked by `isExpr` immediately above
				{ node: "record", fields: fields as Record<string, Expr> }
			: UNRECOGNISED;
	}

	// An extension call is the one arm whose payload is an array of expressions.
	// `unknown` is one of these, which is why the check comes before the
	// operator tables would otherwise reject it.
	const args = exprArray(payload);
	if (args !== undefined) {
		return { node: "ext", fn: key, args };
	}

	if (!isExpr(payload)) {
		return UNRECOGNISED;
	}
	const operands = asRecord(payload);

	if (UNARY_ARG_OPS.has(key) && isExpr(operands["arg"])) {
		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- `key` was matched against the operator set on the line above
		return { node: "unary", op: key as UnaryExprOp, arg: operands["arg"] };
	}

	if (BINARY_OPS.has(key) && isExpr(operands["left"]) && isExpr(operands["right"])) {
		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- ditto
		return {
			node: "binary",
			op: key as BinaryExprOp,
			left: operands["left"],
			right: operands["right"],
		};
	}

	if (key === "." && isExpr(operands["left"]) && typeof operands["attr"] === "string") {
		return { node: "attr", left: operands["left"], attr: operands["attr"] };
	}

	if (key === "has" && isExpr(operands["left"])) {
		const attr = operands["attr"];
		if (typeof attr === "string") {
			return { node: "has", left: operands["left"], attrs: [attr] };
		}
		if (Array.isArray(attr) && attr.every((part) => typeof part === "string")) {
			return { node: "has", left: operands["left"], attrs: attr };
		}
		return UNRECOGNISED;
	}

	if (key === "like" && isExpr(operands["left"]) && Array.isArray(operands["pattern"])) {
		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- `PatternElem` is `"Wildcard" | { Literal: string }`; malformed elements fail the token guard in `expr-to-plan`
		return {
			node: "like",
			left: operands["left"],
			pattern: operands["pattern"] as readonly PatternElem[],
		};
	}

	if (key === "is" && isExpr(operands["left"]) && typeof operands["entity_type"] === "string") {
		return {
			node: "is",
			left: operands["left"],
			entityType: operands["entity_type"],
			in: isExpr(operands["in"]) ? operands["in"] : undefined,
		};
	}

	if (
		key === "if-then-else" &&
		isExpr(operands["if"]) &&
		isExpr(operands["then"]) &&
		isExpr(operands["else"])
	) {
		return {
			node: "ite",
			condition: operands["if"],
			whenTrue: operands["then"],
			whenFalse: operands["else"],
		};
	}

	return UNRECOGNISED;
}

// ---------------------------------------------------------------------------
// Constants and the unknown marker
// ---------------------------------------------------------------------------

/** The literal `true` expression Cedar emits for a folded-away constraint. */
export const EXPR_TRUE: Expr = Object.freeze({ Value: true });

/** The literal `false` expression an errored or non-matching policy residual becomes. */
export const EXPR_FALSE: Expr = Object.freeze({ Value: false });

/** `true` when `expr` is the literal boolean `value`. */
export function isBooleanLiteral(expr: Expr, value: boolean): boolean {
	const view = viewExpr(expr);
	return view.node === "value" && view.value === value;
}

/**
 * The variable name an `unknown` marker stands for, or `undefined`.
 *
 * Verified shape: `{"unknown":[{"Value":"resource"}]}`. Recognising this as an
 * *extension call* rather than as an operator is finding 17 of core.md §0.
 */
export function unknownVarOf(expr: Expr): string | undefined {
	const view = viewExpr(expr);
	if (view.node !== "ext" || view.fn !== "unknown" || view.args.length !== 1) {
		return undefined;
	}

	const argument = viewExpr(view.args[0] as Expr);
	return argument.node === "value" && typeof argument.value === "string"
		? argument.value
		: undefined;
}

/** `true` when `expr` contains an `unknown` marker anywhere inside it. */
export function containsUnknown(expr: Expr): boolean {
	if (unknownVarOf(expr) !== undefined) {
		return true;
	}

	const view = viewExpr(expr);
	switch (view.node) {
		case "unary": {
			return containsUnknown(view.arg);
		}
		case "binary": {
			return containsUnknown(view.left) || containsUnknown(view.right);
		}
		case "attr":
		case "like": {
			return containsUnknown(view.left);
		}
		case "has": {
			return containsUnknown(view.left);
		}
		case "is": {
			return containsUnknown(view.left) || (view.in !== undefined && containsUnknown(view.in));
		}
		case "ite": {
			return (
				containsUnknown(view.condition) ||
				containsUnknown(view.whenTrue) ||
				containsUnknown(view.whenFalse)
			);
		}
		case "set": {
			return view.elements.some((element) => containsUnknown(element));
		}
		case "record": {
			return Object.values(view.fields).some((field) => containsUnknown(field));
		}
		case "ext": {
			return view.args.some((argument) => containsUnknown(argument));
		}
		default: {
			return false;
		}
	}
}

// ---------------------------------------------------------------------------
// Clauses
// ---------------------------------------------------------------------------

/**
 * One policy clause as a single expression: `when { b }` is `b`, `unless { b }`
 * is `!b`.
 *
 * Residuals only ever carry `when` in practice — Cedar rewrites `unless` before
 * partial evaluation — but a raw `PolicyJson` from a store can carry either, and
 * reading `unless` as `when` would invert a forbid.
 */
export function clauseToExpr(clause: Clause): Expr {
	return clause.kind === "unless" ? { "!": { arg: clause.body } } : clause.body;
}

/** Multiple clauses of one policy, `&&`-ed left to right. `[]` is `true`. */
export function clausesToExpr(clauses: readonly Clause[]): Expr {
	if (clauses.length === 0) {
		return EXPR_TRUE;
	}

	let combined = clauseToExpr(clauses[0] as Clause);
	for (let index = 1; index < clauses.length; index += 1) {
		combined = { "&&": { left: combined, right: clauseToExpr(clauses[index] as Clause) } };
	}
	return combined;
}

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

/**
 * Rebuilds a binary node.
 *
 * A computed key cannot be proven to inhabit the `Expr` union, so this is the
 * one assertion the rebuild path needs — and `op` is always a member of
 * {@link BINARY_OPS}, which is exactly the set of keys `Expr` declares.
 */
function binaryExpr(op: BinaryExprOp, left: Expr, right: Expr): Expr {
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see above
	return { [op]: { left, right } } as Expr;
}

/** `<` and `<=` under negation, which is how `>` and `>=` come back. */
const NEGATED_COMPARISON: Readonly<Record<string, BinaryExprOp>> = {
	"<": ">=",
	"<=": ">",
	">": "<=",
	">=": "<",
};

/**
 * Constant-folds, eliminates double negation and recovers `>`/`>=`.
 *
 * Total and semantics-preserving under Cedar's non-erroring evaluation: every
 * `Expr` in, an `Expr` out with the same truth value on every row.
 *
 * What it does **not** do is push `!` through `&&`/`||` (De Morgan) or through
 * `==`. Both would be sound, and both would move a subterm across a `not`,
 * changing the polarity at which an untranslatable subterm is reported — and
 * polarity is what decides whether an approximation is safe. `!=` is recovered
 * later instead, by `simplifyPlanNode`, once polarity no longer matters.
 */
export function normalizeExpr(expr: Expr): Expr {
	const view = viewExpr(expr);

	switch (view.node) {
		case "unary": {
			return normalizeUnary(view.op, normalizeExpr(view.arg));
		}
		case "binary": {
			return normalizeBinary(view.op, normalizeExpr(view.left), normalizeExpr(view.right));
		}
		case "attr": {
			return { ".": { left: normalizeExpr(view.left), attr: view.attr } };
		}
		case "has": {
			return {
				has:
					view.attrs.length === 1
						? { left: normalizeExpr(view.left), attr: view.attrs[0] as string }
						: { left: normalizeExpr(view.left), attr: [...view.attrs] },
			};
		}
		case "like": {
			return { like: { left: normalizeExpr(view.left), pattern: [...view.pattern] } };
		}
		case "is": {
			return {
				is: {
					left: normalizeExpr(view.left),
					entity_type: view.entityType,
					...(view.in === undefined ? {} : { in: normalizeExpr(view.in) }),
				},
			};
		}
		case "ite": {
			return normalizeIfThenElse(
				normalizeExpr(view.condition),
				normalizeExpr(view.whenTrue),
				normalizeExpr(view.whenFalse),
			);
		}
		case "set": {
			return { Set: view.elements.map((element) => normalizeExpr(element)) };
		}
		case "record": {
			const fields: Record<string, Expr> = {};
			for (const [name, field] of Object.entries(view.fields)) {
				fields[name] = normalizeExpr(field);
			}
			return { Record: fields };
		}
		case "ext": {
			// The unknown marker is a leaf: rewriting its `{"Value":"resource"}`
			// argument would only risk breaking the shape everything else matches on.
			if (unknownVarOf(expr) !== undefined) {
				return expr;
			}
			return { [view.fn]: view.args.map((argument) => normalizeExpr(argument)) };
		}
		default: {
			return expr;
		}
	}
}

function normalizeUnary(op: UnaryExprOp, arg: Expr): Expr {
	if (op !== "!") {
		return op === "neg" ? { neg: { arg } } : { isEmpty: { arg } };
	}

	if (isBooleanLiteral(arg, true)) {
		return EXPR_FALSE;
	}
	if (isBooleanLiteral(arg, false)) {
		return EXPR_TRUE;
	}

	const inner = viewExpr(arg);

	// `!!x` -> `x`. Cedar emits this for `!(a != b)`, among others.
	if (inner.node === "unary" && inner.op === "!") {
		return inner.arg;
	}

	// The one rewrite core.md §0 makes mandatory: `>` is only ever `!(x <= k)`
	// and `>=` only ever `!(x < k)`, so without this no plan ever contains `gt`.
	if (inner.node === "binary") {
		const flipped = NEGATED_COMPARISON[inner.op];
		if (flipped !== undefined) {
			return binaryExpr(flipped, inner.left, inner.right);
		}
	}

	return { "!": { arg } };
}

function normalizeBinary(op: BinaryExprOp, left: Expr, right: Expr): Expr {
	if (op === "&&") {
		if (isBooleanLiteral(left, false) || isBooleanLiteral(right, false)) {
			return EXPR_FALSE;
		}
		if (isBooleanLiteral(left, true)) {
			return right;
		}
		if (isBooleanLiteral(right, true)) {
			return left;
		}
		return { "&&": { left, right } };
	}

	if (op === "||") {
		if (isBooleanLiteral(left, true) || isBooleanLiteral(right, true)) {
			return EXPR_TRUE;
		}
		if (isBooleanLiteral(left, false)) {
			return right;
		}
		if (isBooleanLiteral(right, false)) {
			return left;
		}
		return { "||": { left, right } };
	}

	return binaryExpr(op, left, right);
}

function normalizeIfThenElse(condition: Expr, whenTrue: Expr, whenFalse: Expr): Expr {
	if (isBooleanLiteral(condition, true)) {
		return whenTrue;
	}
	if (isBooleanLiteral(condition, false)) {
		return whenFalse;
	}
	// oxlint-disable-next-line unicorn/no-thenable -- `then` is Cedar's own key for the branch; the object is an `Expr`, never awaited
	return { "if-then-else": { if: condition, then: whenTrue, else: whenFalse } };
}

// ---------------------------------------------------------------------------
// Flattening
// ---------------------------------------------------------------------------

function flatten(expr: Expr, op: "&&" | "||", into: Expr[]): void {
	const view = viewExpr(expr);
	if (view.node === "binary" && view.op === op) {
		flatten(view.left, op, into);
		flatten(view.right, op, into);
		return;
	}
	into.push(expr);
}

/**
 * The operands of a nested `&&` chain, in source order.
 *
 * Cedar nests `&&` to the right and prefixes one `{"Value":true} &&` per
 * folded-away scope constraint, so a two-condition policy arrives four levels
 * deep. Flattening here is what lets the AST be n-ary.
 */
export function flattenConjuncts(expr: Expr): readonly Expr[] {
	const operands: Expr[] = [];
	flatten(expr, "&&", operands);
	return operands;
}

/** The operands of a nested `||` chain, in source order. */
export function flattenDisjuncts(expr: Expr): readonly Expr[] {
	const operands: Expr[] = [];
	flatten(expr, "||", operands);
	return operands;
}
