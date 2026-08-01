// Pure operations over the `PlanNode` AST.
//
// This module has **zero imports outside `import type`**. That is deliberate and
// enforced by a test: it is the entire runtime payload of the
// `@nestm/permissions-core/plan` subpath, which the TypeORM and Drizzle drivers
// load at compile time. A driver that had to reach the engine to render a LIKE
// pattern would drag the Cedar WASM into every consumer's bundle.
//
// `likeTokensToPattern` lives here rather than in each driver for one reason:
// duplicated LIKE escaping across two packages is how exactly one of them ends
// up with a `%`-injection bug (delta D5).

import type { AttrPath, LikeToken, PlanCmp, PlanNode, PlanValue, PlanValueKind } from "./plan.ts";

/** The node that matches every row. Frozen and shared. */
export const PLAN_TRUE: PlanNode = Object.freeze({ op: "true" as const });

/** The node that matches no row. Frozen and shared. */
export const PLAN_FALSE: PlanNode = Object.freeze({ op: "false" as const });

// ---------------------------------------------------------------------------
// Constructors
// ---------------------------------------------------------------------------

/** `and` over `nodes`, with no simplification. Use {@link simplifyPlanNode} for that. */
export function planAnd(nodes: readonly PlanNode[]): PlanNode {
	return { op: "and", nodes };
}

/** `or` over `nodes`, with no simplification. */
export function planOr(nodes: readonly PlanNode[]): PlanNode {
	return { op: "or", nodes };
}

/** `not node`, with no simplification. */
export function planNot(node: PlanNode): PlanNode {
	return { op: "not", node };
}

// ---------------------------------------------------------------------------
// Traversal
// ---------------------------------------------------------------------------

/**
 * What a {@link walkPlanNode} visitor may return.
 *
 * `false` prunes the subtree; anything else (including `undefined`) continues.
 */
export type PlanNodeVisitorResult = void | boolean;

/** Called once per node, parents before children. */
export type PlanNodeVisitor = (
	node: PlanNode,
	parent: PlanNode | undefined,
) => PlanNodeVisitorResult;

/**
 * Pre-order walk over a plan tree.
 *
 * ```ts
 * const attributes = new Set<string>();
 * walkPlanNode(plan.condition, (node) => {
 *   if ("attr" in node && node.attr !== null) attributes.add(node.attr.path.join("."));
 * });
 * ```
 *
 * A visitor returning `false` skips that node's children — useful for a driver
 * that handles a whole subtree itself.
 */
export function walkPlanNode(node: PlanNode, visitor: PlanNodeVisitor): void {
	walk(node, undefined, visitor);
}

function walk(node: PlanNode, parent: PlanNode | undefined, visitor: PlanNodeVisitor): void {
	if (visitor(node, parent) === false) {
		return;
	}

	switch (node.op) {
		case "and":
		case "or": {
			for (const child of node.nodes) {
				walk(child, node, visitor);
			}
			return;
		}
		case "not": {
			walk(node.node, node, visitor);
			return;
		}
		default: {
			return;
		}
	}
}

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

/** Discriminant of a {@link PlanValue}, as a total function a driver can switch on. */
export function planValueKindOf(value: PlanValue): PlanValueKind {
	if (typeof value !== "object" || value === null || typeof value.kind !== "string") {
		throw new TypeError(`planValueKindOf expected a PlanValue, received ${describe(value)}`);
	}
	return value.kind;
}

/** Value kinds Cedar defines a total ordering for — and therefore the only ones `<`/`<=` may carry. */
const ORDERABLE_KINDS: ReadonlySet<PlanValueKind> = new Set<PlanValueKind>([
	"long",
	"datetime",
	"duration",
	"decimal",
]);

/**
 * Guards an ordering comparison (`lt`/`lte`/`gt`/`gte`) against a value kind
 * Cedar does not order.
 *
 * Cedar has **no string ordering**: `"a" < "b"` is a type error, not a
 * comparison. SQL, by contrast, orders strings happily and does so under the
 * column's collation — so a plan node that reached a driver with a string bound
 * to `<` would produce rows Cedar never authorized, silently and
 * locale-dependently. Drivers call this before emitting an ordering operator.
 *
 * @throws {TypeError} when `value` is not of an orderable kind.
 */
export function assertOrderable(value: PlanValue): void {
	const kind = planValueKindOf(value);

	if (!ORDERABLE_KINDS.has(kind)) {
		throw new TypeError(
			`Cedar does not order values of kind "${kind}", so an ordering comparison over one ` +
				`cannot be pushed down. Orderable kinds: ${[...ORDERABLE_KINDS].join(", ")}.`,
		);
	}
}

// ---------------------------------------------------------------------------
// LIKE patterns
// ---------------------------------------------------------------------------

/** Rendering options for {@link likeTokensToPattern}. */
export interface LikePatternOptions {
	/** Character meaning "any sequence". Default `"%"` (SQL). */
	readonly wildcardChar?: string;
	/**
	 * Character meaning "any single character" in the *target* dialect.
	 *
	 * Cedar has no single-character wildcard, so this is never emitted — it exists
	 * so that a literal `_` inside a Cedar pattern is escaped rather than silently
	 * becoming a wildcard in SQL. Default `"_"`.
	 */
	readonly singleChar?: string;
	/** Escape character the caller will declare (SQL `ESCAPE '\'`). Required — there is no safe default. */
	readonly escapeChar: string;
}

/**
 * Renders Cedar `like` tokens into a target-dialect pattern, escaping every
 * literal occurrence of the dialect's metacharacters.
 *
 * ```ts
 * // Cedar: resource.status like "a\*b*_%c"
 * likeTokensToPattern(node.pattern, { escapeChar: "\\" });
 * // => "a*b%\\_\\%c"   — the \* stayed literal, the * became %, _ and % got escaped
 * ```
 *
 * The caller must declare the escape character to the database
 * (`LIKE $1 ESCAPE '\'`); this function only produces the pattern.
 *
 * @throws {TypeError} when the option characters are not single characters, or
 * when the escape character collides with a wildcard character.
 */
export function likeTokensToPattern(
	tokens: readonly LikeToken[],
	options: LikePatternOptions,
): string {
	const wildcardChar = options.wildcardChar ?? "%";
	const singleChar = options.singleChar ?? "_";
	const escapeChar = options.escapeChar;

	assertSingleCharacter(wildcardChar, "wildcardChar");
	assertSingleCharacter(singleChar, "singleChar");
	assertSingleCharacter(escapeChar, "escapeChar");

	if (wildcardChar === singleChar) {
		throw new TypeError(
			`likeTokensToPattern needs distinct wildcardChar and singleChar, both were "${wildcardChar}".`,
		);
	}
	if (escapeChar === wildcardChar || escapeChar === singleChar) {
		throw new TypeError(
			`likeTokensToPattern needs an escapeChar distinct from the wildcards, "${escapeChar}" is one of them.`,
		);
	}

	// Escaping the escape character itself is not optional: without it, a literal
	// backslash in a Cedar pattern would escape the character that follows it.
	const mustEscape = new Set([wildcardChar, singleChar, escapeChar]);

	let pattern = "";

	for (const token of tokens) {
		if ("wildcard" in token) {
			pattern += wildcardChar;
			continue;
		}

		for (const character of token.literal) {
			pattern += mustEscape.has(character) ? `${escapeChar}${character}` : character;
		}
	}

	return pattern;
}

function assertSingleCharacter(value: string, option: string): void {
	// oxlint-disable-next-line typescript/no-misused-spread -- code points are exactly the unit wanted: an astral escape character is one character, not two
	if (typeof value !== "string" || [...value].length !== 1) {
		throw new TypeError(
			`likeTokensToPattern's ${option} must be a single character, received ${describe(value)}.`,
		);
	}
}

// ---------------------------------------------------------------------------
// Simplification
// ---------------------------------------------------------------------------

/** Options for {@link simplifyPlanNode}. */
export interface SimplifyOptions {
	/**
	 * Resource type the plan is being compiled for.
	 *
	 * When given, an `isType` node folds to `true`/`false` — every row of a
	 * single-type query is that type, so `resource is Run` is a constant once the
	 * planned type is known.
	 */
	readonly resourceType?: string;
}

/** `cmp` operators under negation. Total, and its own inverse. */
const NEGATED_CMP: Readonly<Record<PlanCmp, PlanCmp>> = {
	eq: "ne",
	ne: "eq",
	lt: "gte",
	gte: "lt",
	lte: "gt",
	gt: "lte",
};

/**
 * Absorbs `true`/`false`, flattens and collapses `and`/`or`, eliminates double
 * negation, pushes `not` through a comparison, and folds `isType`.
 *
 * Bottom-up and total: every `PlanNode` in, a semantically equal `PlanNode` out.
 * Pushing `not` through `cmp` is what turns Cedar's `!(x == k)` into `x != k`
 * and `!(x <= k)` into `x > k` — the ops the pushdown table promises. It is safe
 * *here* because it runs after translation, so no polarity bookkeeping depends
 * on the `not` still being present.
 */
export function simplifyPlanNode(node: PlanNode, options: SimplifyOptions = {}): PlanNode {
	switch (node.op) {
		case "and": {
			return simplifyJunction(node.nodes, options, "and");
		}
		case "or": {
			return simplifyJunction(node.nodes, options, "or");
		}
		case "not": {
			return simplifyNot(simplifyPlanNode(node.node, options));
		}
		case "isType": {
			if (options.resourceType === undefined) {
				return node;
			}
			return node.entityType === options.resourceType ? PLAN_TRUE : PLAN_FALSE;
		}
		default: {
			return node;
		}
	}
}

function simplifyJunction(
	nodes: readonly PlanNode[],
	options: SimplifyOptions,
	op: "and" | "or",
): PlanNode {
	// `and`: `false` annihilates, `true` is dropped. `or` is the mirror image.
	const annihilator = op === "and" ? "false" : "true";
	const identity = op === "and" ? "true" : "false";

	const flattened: PlanNode[] = [];

	for (const child of nodes) {
		const simplified = simplifyPlanNode(child, options);

		if (simplified.op === annihilator) {
			return annihilator === "false" ? PLAN_FALSE : PLAN_TRUE;
		}
		if (simplified.op === identity) {
			continue;
		}
		if (simplified.op === op) {
			flattened.push(...simplified.nodes);
			continue;
		}
		flattened.push(simplified);
	}

	if (flattened.length === 0) {
		return identity === "true" ? PLAN_TRUE : PLAN_FALSE;
	}
	if (flattened.length === 1) {
		return flattened[0] as PlanNode;
	}

	return op === "and" ? { op: "and", nodes: flattened } : { op: "or", nodes: flattened };
}

function simplifyNot(node: PlanNode): PlanNode {
	switch (node.op) {
		case "true": {
			return PLAN_FALSE;
		}
		case "false": {
			return PLAN_TRUE;
		}
		case "not": {
			return node.node;
		}
		case "cmp": {
			return { op: "cmp", cmp: NEGATED_CMP[node.cmp], attr: node.attr, value: node.value };
		}
		default: {
			return { op: "not", node };
		}
	}
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const CMP_SYMBOLS: Readonly<Record<PlanCmp, string>> = {
	eq: "==",
	ne: "!=",
	lt: "<",
	lte: "<=",
	gt: ">",
	gte: ">=",
};

/** `resource.status`, or `resource` for the row itself. */
export function formatAttrPath(attr: AttrPath): string {
	return attr.path.length === 0 ? attr.root : `${attr.root}.${attr.path.join(".")}`;
}

/** Debug rendering of a {@link PlanValue}. Never fed to a database. */
export function formatPlanValue(value: PlanValue): string {
	switch (value.kind) {
		case "string": {
			return JSON.stringify(value.value);
		}
		case "long": {
			return `${value.value.toString()}n`;
		}
		case "bool": {
			return value.value ? "true" : "false";
		}
		case "entity": {
			return `${value.value.type}::"${value.value.id}"`;
		}
		case "datetime": {
			return `datetime(${value.value.toISOString()})`;
		}
		case "duration": {
			return `duration(${String(value.value)}ms)`;
		}
		case "decimal": {
			return `decimal(${value.value})`;
		}
		case "ipaddr": {
			return `ip(${value.value})`;
		}
		case "set": {
			return `[${value.value.map((element) => formatPlanValue(element)).join(", ")}]`;
		}
	}
}

/** Debug rendering of a `like` pattern, with wildcards shown as `*`. */
export function formatLikePattern(tokens: readonly LikeToken[]): string {
	return tokens
		.map((token) => ("wildcard" in token ? "*" : token.literal.replaceAll("*", "\\*")))
		.join("");
}

/**
 * Debug rendering of a plan tree, in a Cedar-ish syntax.
 *
 * For `explain()` and error messages only — it is not a driver input and makes
 * no escaping promises.
 */
export function formatPlanNode(node: PlanNode): string {
	switch (node.op) {
		case "true": {
			return "true";
		}
		case "false": {
			return "false";
		}
		case "and": {
			return `(${node.nodes.map((child) => formatPlanNode(child)).join(" && ")})`;
		}
		case "or": {
			return `(${node.nodes.map((child) => formatPlanNode(child)).join(" || ")})`;
		}
		case "not": {
			return `!${formatPlanNode(node.node)}`;
		}
		case "cmp": {
			return `${formatAttrPath(node.attr)} ${CMP_SYMBOLS[node.cmp]} ${formatPlanValue(node.value)}`;
		}
		case "in": {
			return `${formatAttrPath(node.attr)} in [${node.values
				.map((value) => formatPlanValue(value))
				.join(", ")}]`;
		}
		case "contains": {
			return `${formatAttrPath(node.attr)}.contains(${formatPlanValue(node.value)})`;
		}
		case "like": {
			return `${formatAttrPath(node.attr)} like "${formatLikePattern(node.pattern)}"`;
		}
		case "exists": {
			return `${node.attr.root} has ${node.attr.path.join(".")}`;
		}
		case "isEmpty": {
			return `${formatAttrPath(node.attr)}.isEmpty()`;
		}
		case "isType": {
			return `resource is ${node.entityType}`;
		}
		case "inHierarchy": {
			const left = node.attr === null ? "resource" : formatAttrPath(node.attr);
			return `${left} in ${node.parent.type}::"${node.parent.id}"`;
		}
	}
}

/** Renders an unexpected argument for an error message, without ever `[object Object]`-ing it. */
function describe(value: unknown): string {
	if (value === null) {
		return "null";
	}
	if (typeof value === "object" || typeof value === "string") {
		return JSON.stringify(value);
	}
	if (typeof value === "number" || typeof value === "boolean") {
		return `${typeof value} ${value.toString()}`;
	}
	if (typeof value === "bigint") {
		return `bigint ${value.toString()}`;
	}
	return typeof value;
}
