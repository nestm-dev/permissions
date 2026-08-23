// The pushdown table (core.md §5.4) — the only place a Cedar residual becomes a
// `PlanNode`, and the only place a shape is declared un-pushdown-able.
//
// The rule the whole file obeys: **every path either produces a node whose row
// set exactly matches Cedar's, or produces a typed rejection.** There is no
// "close enough" branch, no default that becomes `true`, and no operator handled
// by falling through to a generic case. What the caller does with a rejection —
// throw, post-filter, or record a restrictive approximation — is decided by
// `approximation.ts` from the *polarity* this module tracks.
//
// Polarity lives here rather than in the caller because only the recursion knows
// it: it starts at `+1` and flips under every `!`. `translateExpr` decomposes
// `&&`/`||`/`!` itself precisely so that a failure is attributed to the smallest
// enclosing subterm, at the right polarity, instead of poisoning a whole policy.

import type { CedarValueJson, Expr, PatternElem } from "../cedar/binding.ts";
import { unqualifyEntityType, type EntityRef } from "../cedar/uid.ts";
import {
	containsUnknown,
	flattenConjuncts,
	flattenDisjuncts,
	unknownVarOf,
	viewExpr,
	type ExprView,
} from "./expr-normalize.ts";
import { PLAN_FALSE, PLAN_TRUE, planAnd, planNot, planOr } from "./plan-node.ts";
import type {
	AttrPath,
	AttrRoot,
	LikeToken,
	PlanApproximationReason,
	PlanCmp,
	PlanNode,
	PlanValue,
} from "./plan.ts";

// ---------------------------------------------------------------------------
// Target
// ---------------------------------------------------------------------------

/** What the translation is planning over. */
export interface PlanTarget {
	/**
	 * Cedar variable left unknown in the partial-evaluation call — `"resource"`
	 * for forward planning. An `unknown` for any other variable is a
	 * `wrong-unknown-root` rejection rather than something to guess at.
	 */
	readonly unknownVar: AttrRoot;
	/** Vocabulary-local resource type being planned over, e.g. `"Run"`. */
	readonly resourceType: string;
	/** Cedar namespace, stripped from entity types so refs stay vocabulary-local. */
	readonly namespace: string;
}

// ---------------------------------------------------------------------------
// Outcomes
// ---------------------------------------------------------------------------

/** A subterm that could not be pushed down, with the reason and the offending node. */
export interface PlanRejection {
	readonly ok: false;
	readonly reason: PlanApproximationReason;
	/** The **innermost** offending sub-expression, for the audit log. */
	readonly expr: Expr;
}

/** A subterm that translated exactly. */
export interface PlanTranslation {
	readonly ok: true;
	readonly node: PlanNode;
}

/** Result of an all-or-nothing translation attempt. */
export type PlanOutcome = PlanTranslation | PlanRejection;

/** A subterm handed to {@link TranslateOptions.onUnsupported}. */
export interface UnsupportedSubterm {
	readonly reason: PlanApproximationReason;
	readonly expr: Expr;
	/** `1` at even `not`-depth, `-1` at odd. Decides whether dropping it is safe. */
	readonly polarity: 1 | -1;
}

/** Options for {@link translateExpr}. */
export interface TranslateOptions {
	readonly target: PlanTarget;
	/**
	 * Called for every subterm that cannot be pushed down.
	 *
	 * Returns the node to substitute, or throws. It is never given a choice about
	 * *whether* a substitution is safe — that is `approximationDirection`'s job,
	 * and this callback is where its verdict is applied.
	 */
	readonly onUnsupported: (subterm: UnsupportedSubterm) => PlanNode;
}

function ok(node: PlanNode): PlanTranslation {
	return { ok: true, node };
}

function reject(reason: PlanApproximationReason, expr: Expr): PlanRejection {
	return { ok: false, reason, expr };
}

// ---------------------------------------------------------------------------
// Operands
// ---------------------------------------------------------------------------

/** How one side of a binary operator relates to the unknown. */
type Operand =
	/** A depth-1 attribute of the unknown: a column. */
	| { readonly kind: "attr"; readonly attr: AttrPath }
	/** The unknown entity itself. */
	| { readonly kind: "unknown" }
	/** A constant Cedar could fully evaluate. */
	| { readonly kind: "constant"; readonly value: PlanValue }
	/** Unknown-derived but not pushdown-able, or a constant that has no `PlanValue`. */
	| { readonly kind: "reject"; readonly rejection: PlanRejection };

/** Unwinds a `.` chain down to its base, outermost attribute last. */
function attrChain(expr: Expr): { base: Expr; path: readonly string[] } {
	const path: string[] = [];
	let current = expr;

	for (;;) {
		const view = viewExpr(current);
		if (view.node !== "attr") {
			return { base: current, path: path.reverse() };
		}
		path.push(view.attr);
		current = view.left;
	}
}

function classifyOperand(expr: Expr, target: PlanTarget): Operand {
	const marker = unknownVarOf(expr);
	if (marker !== undefined) {
		return marker === target.unknownVar
			? { kind: "unknown" }
			: { kind: "reject", rejection: reject("wrong-unknown-root", expr) };
	}

	const view = viewExpr(expr);

	if (view.node === "attr") {
		const { base, path } = attrChain(expr);
		const baseMarker = unknownVarOf(base);

		if (baseMarker === undefined) {
			// A `.` over something that is not an unknown. Either it reaches an
			// unknown further in (an extension result, say) or Cedar would have
			// folded it — both are rejections, never constants.
			return { kind: "reject", rejection: rejectionFor(expr, target) };
		}
		if (baseMarker !== target.unknownVar) {
			return { kind: "reject", rejection: reject("wrong-unknown-root", expr) };
		}
		if (path.length !== 1) {
			// `resource.owner.dept` — a join the core cannot know about.
			return { kind: "reject", rejection: reject("nested-attribute", expr) };
		}

		return { kind: "attr", attr: { root: target.unknownVar, path } };
	}

	const constant = tryPlanValue(expr, target);
	if (constant !== undefined) {
		return { kind: "constant", value: constant };
	}

	return { kind: "reject", rejection: rejectionFor(expr, target) };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Cedar extension constructors whose literal argument maps onto a `PlanValue`. */
const EXTENSION_VALUE_FNS: ReadonlySet<string> = new Set(["datetime", "duration", "decimal", "ip"]);

/**
 * `expr` as a `PlanValue`, or `undefined` when it is not a fully-evaluated
 * constant this package can bind.
 *
 * Deliberately conservative: a shape that does not parse becomes `undefined`,
 * which becomes a rejection, which fails closed. Guessing at a literal is how a
 * mis-parsed timestamp silently selects the wrong rows.
 */
export function tryPlanValue(expr: Expr, target: PlanTarget): PlanValue | undefined {
	const view = viewExpr(expr);

	if (view.node === "value") {
		return cedarValueToPlanValue(view.value, target);
	}

	if (view.node === "set") {
		const elements: PlanValue[] = [];
		for (const element of view.elements) {
			const value = tryPlanValue(element, target);
			if (value === undefined) {
				return undefined;
			}
			elements.push(value);
		}
		return { kind: "set", value: elements };
	}

	if (view.node === "ext" && EXTENSION_VALUE_FNS.has(view.fn) && view.args.length === 1) {
		const argument = viewExpr(view.args[0] as Expr);
		if (argument.node !== "value" || typeof argument.value !== "string") {
			return undefined;
		}
		return extensionValue(view.fn, argument.value);
	}

	return undefined;
}

function cedarValueToPlanValue(value: CedarValueJson, target: PlanTarget): PlanValue | undefined {
	if (typeof value === "string") {
		return { kind: "string", value };
	}
	if (typeof value === "boolean") {
		return { kind: "bool", value };
	}
	if (typeof value === "number") {
		// Cedar longs are i64 but the residual crosses the WASM boundary as JSON,
		// so anything above 2^53 has *already* been rounded by the time it gets
		// here (verified: 9007199254740993 comes back as ...992). Converting to
		// `bigint` keeps the driver side exact; it cannot undo the rounding.
		return Number.isInteger(value) ? { kind: "long", value: BigInt(value) } : undefined;
	}
	if (Array.isArray(value)) {
		const elements: PlanValue[] = [];
		for (const element of value) {
			const planValue = cedarValueToPlanValue(element, target);
			if (planValue === undefined) {
				return undefined;
			}
			elements.push(planValue);
		}
		return { kind: "set", value: elements };
	}
	if (value === null || typeof value !== "object") {
		return undefined;
	}

	if ("__entity" in value) {
		const uid = value.__entity;
		if (typeof uid !== "object" || uid === null || Array.isArray(uid)) {
			return undefined;
		}
		const reference = entityRefOf(uid, target);
		return reference === undefined ? undefined : { kind: "entity", value: reference };
	}

	if ("__extn" in value) {
		const call = value.__extn;
		if (typeof call !== "object" || call === null || Array.isArray(call)) {
			return undefined;
		}
		const fn = "fn" in call ? call.fn : undefined;
		const argument = "arg" in call ? call.arg : undefined;
		if (typeof fn !== "string" || typeof argument !== "string") {
			return undefined;
		}
		return EXTENSION_VALUE_FNS.has(fn) ? extensionValue(fn, argument) : undefined;
	}

	// A record literal. No `PlanValue` represents one, by design.
	return undefined;
}

function entityRefOf(uid: object, target: PlanTarget): EntityRef<string> | undefined {
	const type = "type" in uid ? uid.type : undefined;
	const id = "id" in uid ? uid.id : undefined;

	if (typeof type !== "string" || typeof id !== "string") {
		return undefined;
	}
	return { type: unqualifyEntityType(target.namespace, type), id };
}

function extensionValue(fn: string, literal: string): PlanValue | undefined {
	switch (fn) {
		case "datetime": {
			const parsed = parseCedarDateTime(literal);
			return parsed === undefined ? undefined : { kind: "datetime", value: parsed };
		}
		case "duration": {
			const parsed = parseCedarDuration(literal);
			return parsed === undefined ? undefined : { kind: "duration", value: parsed };
		}
		case "decimal": {
			return CEDAR_DECIMAL.test(literal) ? { kind: "decimal", value: literal } : undefined;
		}
		case "ip": {
			return CEDAR_IPADDR.test(literal) ? { kind: "ipaddr", value: literal } : undefined;
		}
		default: {
			return undefined;
		}
	}
}

/** Cedar decimal: a sign, an integer part, and 1–4 fractional digits. */
const CEDAR_DECIMAL = /^-?\d+\.\d{1,4}$/;

/** Cedar ipaddr: v4/v6 characters and an optional prefix length. Cedar itself validates further. */
const CEDAR_IPADDR = /^[0-9A-Fa-f.:]+(?:\/\d{1,3})?$/;

/**
 * Cedar's five accepted `datetime` literal forms (RFC 80).
 *
 * `YYYY-MM-DD`, and `YYYY-MM-DDThh:mm:ss[.SSS]` followed by `Z` or `±hhmm`.
 * Note there is **no** colon in the offset and **no** bare local form; both are
 * rejected rather than guessed at.
 */
const CEDAR_DATETIME =
	/^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{3}))?(Z|[+-]\d{4}))?$/;

/** Parses a Cedar `datetime` literal into a `Date`, or `undefined` when malformed. */
export function parseCedarDateTime(literal: string): Date | undefined {
	const match = CEDAR_DATETIME.exec(literal);
	if (match === null) {
		return undefined;
	}

	const year = Number(match[1]);
	const month = Number(match[2]);
	const day = Number(match[3]);
	const hours = match[4] === undefined ? 0 : Number(match[4]);
	const minutes = match[5] === undefined ? 0 : Number(match[5]);
	const seconds = match[6] === undefined ? 0 : Number(match[6]);
	const millis = match[7] === undefined ? 0 : Number(match[7]);
	const zone = match[8];

	if (month < 1 || month > 12 || day < 1 || day > 31) {
		return undefined;
	}
	if (hours > 23 || minutes > 59 || seconds > 59) {
		return undefined;
	}

	const utc = Date.UTC(year, month - 1, day, hours, minutes, seconds, millis);
	const date = new Date(utc);

	// Rejects 2026-02-30 and friends, which `Date.UTC` would happily roll over.
	if (
		date.getUTCFullYear() !== year ||
		date.getUTCMonth() !== month - 1 ||
		date.getUTCDate() !== day
	) {
		return undefined;
	}

	if (zone === undefined || zone === "Z") {
		return date;
	}

	const sign = zone.startsWith("-") ? -1 : 1;
	const offsetHours = Number(zone.slice(1, 3));
	const offsetMinutes = Number(zone.slice(3, 5));
	if (offsetHours > 23 || offsetMinutes > 59) {
		return undefined;
	}

	// `+0130` means the wall-clock reading is 1h30 *ahead* of UTC.
	return new Date(utc - sign * (offsetHours * 3_600_000 + offsetMinutes * 60_000));
}

/** Cedar duration: an optional sign then `d`,`h`,`m`,`s`,`ms` components in that order. */
const CEDAR_DURATION = /^(-)?(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?(?:(\d+)ms)?$/;

/** Parses a Cedar `duration` literal into signed milliseconds, or `undefined` when malformed. */
export function parseCedarDuration(literal: string): number | undefined {
	const match = CEDAR_DURATION.exec(literal);
	if (match === null) {
		return undefined;
	}

	const [, sign, days, hours, minutes, seconds, millis] = match;

	// The regex matches the empty string and a bare `-`; a duration needs a unit.
	if (
		days === undefined &&
		hours === undefined &&
		minutes === undefined &&
		seconds === undefined &&
		millis === undefined
	) {
		return undefined;
	}

	const total =
		Number(days ?? 0) * 86_400_000 +
		Number(hours ?? 0) * 3_600_000 +
		Number(minutes ?? 0) * 60_000 +
		Number(seconds ?? 0) * 1000 +
		Number(millis ?? 0);

	return sign === "-" ? -total : total;
}

// ---------------------------------------------------------------------------
// Rejection reasons
// ---------------------------------------------------------------------------

/**
 * Picks the most specific reason for a shape with no dedicated translation path.
 *
 * Every operator with its own path builds its own rejection; this is the
 * fallback, and it exists so a rejection is never just `'other'` when something
 * more actionable is knowable.
 */
function rejectionFor(expr: Expr, target: PlanTarget): PlanRejection {
	const view: ExprView = viewExpr(expr);

	switch (view.node) {
		case "unary": {
			return reject(view.op === "neg" ? "arithmetic" : "other", expr);
		}
		case "binary": {
			if (view.op === "+" || view.op === "-" || view.op === "*") {
				return reject("arithmetic", expr);
			}
			if (
				view.op === "getTag" ||
				view.op === "hasTag" ||
				view.op === "containsAll" ||
				view.op === "containsAny"
			) {
				return reject("unsupported-operator", expr);
			}
			return reject("other", expr);
		}
		case "attr": {
			const { base, path } = attrChain(expr);
			if (unknownVarOf(base) !== undefined && path.length > 1) {
				return reject("nested-attribute", expr);
			}
			return reject("other", expr);
		}
		case "record": {
			return reject("unsupported-value", expr);
		}
		case "set": {
			return reject(containsUnknown(expr) ? "unknown-both-sides" : "unsupported-value", expr);
		}
		case "var":
		case "slot": {
			return reject("unsupported-operator", expr);
		}
		case "value": {
			return reject("unsupported-value", expr);
		}
		case "ext": {
			const marker = unknownVarOf(expr);
			if (marker !== undefined) {
				return reject(marker === target.unknownVar ? "other" : "wrong-unknown-root", expr);
			}
			// An extension *applied* to the unknown — `ip(resource.addr).isInRange(…)`,
			// `resource.at.durationSince(…)`. The database has no equivalent.
			return reject(containsUnknown(expr) ? "extension-on-unknown" : "unsupported-value", expr);
		}
		default: {
			return reject("other", expr);
		}
	}
}

/** Rejection for a binary operator whose operands do not form a supported pair. */
function rejectBinary(
	expr: Expr,
	left: Operand,
	right: Operand,
	fallback: PlanApproximationReason,
): PlanRejection {
	if (left.kind === "reject") {
		return left.rejection;
	}
	if (right.kind === "reject") {
		return right.rejection;
	}
	const leftUnknown = left.kind === "attr" || left.kind === "unknown";
	const rightUnknown = right.kind === "attr" || right.kind === "unknown";

	if (leftUnknown && rightUnknown) {
		return reject("unknown-both-sides", expr);
	}
	if (left.kind === "unknown" || right.kind === "unknown") {
		return reject("entity-identity", expr);
	}
	return reject(fallback, expr);
}

// ---------------------------------------------------------------------------
// Translation
// ---------------------------------------------------------------------------

const ORDERING_CMP: Readonly<Record<string, PlanCmp>> = {
	"<": "lt",
	"<=": "lte",
	">": "gt",
	">=": "gte",
};
/** Ordering operators read right-to-left, for when the attribute is the right operand. */
const MIRRORED_CMP: Readonly<Record<PlanCmp, PlanCmp>> = {
	lt: "gt",
	lte: "gte",
	gt: "lt",
	gte: "lte",
	eq: "eq",
	ne: "ne",
};

/**
 * Translates one residual expression, **all or nothing**.
 *
 * Used for leaves, and for `if-then-else`, where §5.4 requires all three
 * branches to translate before any of them is trusted.
 */
export function tryTranslate(expr: Expr, target: PlanTarget): PlanOutcome {
	const view = viewExpr(expr);

	switch (view.node) {
		case "value": {
			if (view.value === true) {
				return ok(PLAN_TRUE);
			}
			if (view.value === false) {
				return ok(PLAN_FALSE);
			}
			return reject("unsupported-value", expr);
		}

		case "binary": {
			switch (view.op) {
				case "&&": {
					return translateJunction(flattenConjuncts(expr), target, "and");
				}
				case "||": {
					return translateJunction(flattenDisjuncts(expr), target, "or");
				}
				case "==":
				case "!=": {
					return translateEquality(expr, view.op, view.left, view.right, target);
				}
				case "<":
				case "<=":
				case ">":
				case ">=": {
					return translateOrdering(expr, view.op, view.left, view.right, target);
				}
				case "in": {
					return translateIn(expr, view.left, view.right, target);
				}
				case "contains": {
					return translateContains(expr, view.left, view.right, target);
				}
				default: {
					return rejectionFor(expr, target);
				}
			}
		}

		case "unary": {
			if (view.op === "!") {
				const inner = tryTranslate(view.arg, target);
				return inner.ok ? ok(planNot(inner.node)) : inner;
			}
			if (view.op === "isEmpty") {
				const operand = classifyOperand(view.arg, target);
				return operand.kind === "attr"
					? ok({ op: "isEmpty", attr: operand.attr })
					: operandRejection(operand, view.arg, target);
			}
			return reject("arithmetic", expr);
		}

		case "attr": {
			// A bare attribute at boolean position — `when { resource.archived }`.
			// Cedar guarantees it is a Bool there (the validator rejects otherwise,
			// and a mistyped one lands in `errored[]`), so `attr == true` is exact.
			const operand = classifyOperand(expr, target);
			return operand.kind === "attr"
				? ok({ op: "cmp", cmp: "eq", attr: operand.attr, value: { kind: "bool", value: true } })
				: operandRejection(operand, expr, target);
		}

		case "has": {
			if (unknownVarOf(view.left) !== target.unknownVar) {
				const operand = classifyOperand(view.left, target);
				return operand.kind === "reject" ? operand.rejection : reject("nested-attribute", expr);
			}
			if (view.attrs.length !== 1) {
				return reject("nested-attribute", expr);
			}
			return ok({
				op: "exists",
				attr: { root: target.unknownVar, path: [view.attrs[0] as string] },
			});
		}

		case "like": {
			const operand = classifyOperand(view.left, target);
			if (operand.kind !== "attr") {
				return operandRejection(operand, view.left, target);
			}
			const pattern = likeTokens(view.pattern);
			return pattern === undefined
				? reject("unsupported-value", expr)
				: ok({ op: "like", attr: operand.attr, pattern });
		}

		case "is": {
			if (unknownVarOf(view.left) !== target.unknownVar) {
				const operand = classifyOperand(view.left, target);
				return operand.kind === "reject" ? operand.rejection : reject("unsupported-operator", expr);
			}

			const isType: PlanNode = {
				op: "isType",
				entityType: unqualifyEntityType(target.namespace, view.entityType),
			};
			if (view.in === undefined) {
				return ok(isType);
			}

			const inNode = translateIn(expr, view.left, view.in, target);
			return inNode.ok ? ok(planAnd([isType, inNode.node])) : inNode;
		}

		case "ite": {
			// All three branches or none: a plan built from two of them would be a
			// guess about the third.
			const condition = tryTranslate(view.condition, target);
			if (!condition.ok) {
				return condition;
			}
			const whenTrue = tryTranslate(view.whenTrue, target);
			if (!whenTrue.ok) {
				return whenTrue;
			}
			const whenFalse = tryTranslate(view.whenFalse, target);
			if (!whenFalse.ok) {
				return whenFalse;
			}

			return ok(
				planOr([
					planAnd([condition.node, whenTrue.node]),
					planAnd([planNot(condition.node), whenFalse.node]),
				]),
			);
		}

		default: {
			return rejectionFor(expr, target);
		}
	}
}

function operandRejection(operand: Operand, expr: Expr, target: PlanTarget): PlanRejection {
	return operand.kind === "reject" ? operand.rejection : rejectionFor(expr, target);
}

function translateJunction(
	operands: readonly Expr[],
	target: PlanTarget,
	op: "and" | "or",
): PlanOutcome {
	const nodes: PlanNode[] = [];

	for (const operand of operands) {
		const outcome = tryTranslate(operand, target);
		if (!outcome.ok) {
			return outcome;
		}
		nodes.push(outcome.node);
	}

	return ok(op === "and" ? planAnd(nodes) : planOr(nodes));
}

function translateEquality(
	expr: Expr,
	op: "==" | "!=",
	leftExpr: Expr,
	rightExpr: Expr,
	target: PlanTarget,
): PlanOutcome {
	const left = classifyOperand(leftExpr, target);
	const right = classifyOperand(rightExpr, target);
	const cmp: PlanCmp = op === "==" ? "eq" : "ne";

	if (left.kind === "attr" && right.kind === "constant") {
		return ok({ op: "cmp", cmp, attr: left.attr, value: right.value });
	}
	if (right.kind === "attr" && left.kind === "constant") {
		return ok({ op: "cmp", cmp, attr: right.attr, value: left.value });
	}

	return rejectBinary(expr, left, right, "other");
}

function translateOrdering(
	expr: Expr,
	op: "<" | "<=" | ">" | ">=",
	leftExpr: Expr,
	rightExpr: Expr,
	target: PlanTarget,
): PlanOutcome {
	const left = classifyOperand(leftExpr, target);
	const right = classifyOperand(rightExpr, target);
	const cmp = ORDERING_CMP[op] as PlanCmp;

	if (left.kind === "attr" && right.kind === "constant") {
		return ok({ op: "cmp", cmp, attr: left.attr, value: right.value });
	}
	if (right.kind === "attr" && left.kind === "constant") {
		// `5 < resource.attempt` is `resource.attempt > 5`.
		return ok({ op: "cmp", cmp: MIRRORED_CMP[cmp], attr: right.attr, value: left.value });
	}

	return rejectBinary(expr, left, right, "other");
}

function translateIn(expr: Expr, leftExpr: Expr, rightExpr: Expr, target: PlanTarget): PlanOutcome {
	const right = classifyOperand(rightExpr, target);

	// The hierarchy parent has to be one concrete entity. A set, an attribute or
	// anything else would need the driver to resolve a hierarchy it was never
	// given — §5.4 rejects all of it.
	if (right.kind !== "constant" || right.value.kind !== "entity") {
		return right.kind === "reject" ? right.rejection : reject("non-literal-hierarchy", expr);
	}
	const parent = right.value.value;

	const marker = unknownVarOf(leftExpr);
	if (marker !== undefined) {
		return marker === target.unknownVar
			? ok({ op: "inHierarchy", attr: null, parent })
			: reject("wrong-unknown-root", leftExpr);
	}

	const left = classifyOperand(leftExpr, target);
	return left.kind === "attr"
		? ok({ op: "inHierarchy", attr: left.attr, parent })
		: operandRejection(left, leftExpr, target);
}

function translateContains(
	expr: Expr,
	leftExpr: Expr,
	rightExpr: Expr,
	target: PlanTarget,
): PlanOutcome {
	const left = classifyOperand(leftExpr, target);
	const right = classifyOperand(rightExpr, target);

	// `["a","b"].contains(resource.status)` and
	// `[Workspace::"a"].contains(resource)` are membership tests, i.e. `IN`.
	if (left.kind === "constant" && left.value.kind === "set") {
		if (right.kind === "attr") {
			return ok({ op: "in", attr: right.attr, values: left.value.value });
		}

		const marker = unknownVarOf(rightExpr);
		if (marker !== undefined) {
			if (marker !== target.unknownVar) {
				return reject("wrong-unknown-root", rightExpr);
			}
			if (left.value.value.every((value) => value.kind === "entity")) {
				return ok({ op: "in", attr: null, values: left.value.value });
			}
			return reject("unsupported-value", leftExpr);
		}
	}

	// `resource.labels.contains("x")` — a set-valued column containing an element.
	if (left.kind === "attr" && right.kind === "constant") {
		return ok({ op: "contains", attr: left.attr, value: right.value });
	}

	return rejectBinary(expr, left, right, "other");
}

function likeTokens(pattern: readonly PatternElem[]): readonly LikeToken[] | undefined {
	const tokens: LikeToken[] = [];

	for (const element of pattern) {
		if (element === "Wildcard") {
			tokens.push({ wildcard: true });
			continue;
		}
		if (
			typeof element === "object" &&
			element !== null &&
			"Literal" in element &&
			typeof element.Literal === "string"
		) {
			tokens.push({ literal: element.Literal });
			continue;
		}
		return undefined;
	}

	return tokens;
}

// ---------------------------------------------------------------------------
// Polarity-aware entry point
// ---------------------------------------------------------------------------

/** Flips polarity. Exported so the direction matrix can test it directly. */
export function flipPolarity(polarity: 1 | -1): 1 | -1 {
	return polarity === 1 ? -1 : 1;
}

/**
 * Translates a residual body, localising every failure to the smallest subterm.
 *
 * `&&`, `||` and `!` are decomposed here rather than in {@link tryTranslate} so
 * that one untranslatable conjunct does not condemn its siblings, and so that
 * the polarity at the point of failure is exact. Everything else is all-or-
 * nothing and goes through `tryTranslate`.
 */
export function translateExpr(expr: Expr, polarity: 1 | -1, options: TranslateOptions): PlanNode {
	const view = viewExpr(expr);

	if (view.node === "binary" && view.op === "&&") {
		return planAnd(
			flattenConjuncts(expr).map((operand) => translateExpr(operand, polarity, options)),
		);
	}
	if (view.node === "binary" && view.op === "||") {
		return planOr(
			flattenDisjuncts(expr).map((operand) => translateExpr(operand, polarity, options)),
		);
	}
	if (view.node === "unary" && view.op === "!") {
		return planNot(translateExpr(view.arg, flipPolarity(polarity), options));
	}

	const outcome = tryTranslate(expr, options.target);
	if (outcome.ok) {
		return outcome.node;
	}

	return options.onUnsupported({ reason: outcome.reason, expr: outcome.expr, polarity });
}
