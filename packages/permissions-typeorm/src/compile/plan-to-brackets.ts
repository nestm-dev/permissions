// `planToBrackets` — the whole point of this package.
//
// ## The fail-closed contract (README, verbatim)
//
// > `planToSql` / `planToBrackets` compile **exactly** the `PlanNode` grammar.
// > Anything a mapping does not cover raises a `PlanCompilationError` before any
// > SQL is produced. There is no configuration in which an uncompilable node
// > becomes `TRUE`.
//
// ## Why NULL is safe here
//
// The assembled condition is `OR(permits) AND NOT(OR(forbids))`. SQL's
// three-valued logic makes any NULL-touching subterm propagate to NULL, and a
// top-level NULL excludes the row. Under this shape that is *uniformly
// restrictive*: a NULL inside a permit drops the row, and a NULL inside a forbid
// makes `NOT NULL` NULL, which also drops the row. So a nullable column mapped to
// a Cedar optional attribute is fail-closed by construction — and it agrees with
// Cedar, where reading an absent attribute errors the policy into `false`, and
// with core's reference interpreter, which is three-valued for exactly this
// reason.
//
// Two consequences are load-bearing and are re-stated at each site:
//
//   * **never wrap the compiled condition in `COALESCE(…, true)`.** It converts
//     "we could not evaluate this" into "everyone may see this row".
//   * **never emit `NOT IN` against a nullable subquery.** `x NOT IN (SELECT …)`
//     is NULL — not `true` — as soon as the subquery yields one NULL, which
//     silently empties a negated filter. Every negation in this file is
//     `NOT (…)` over an expression this compiler produced, and every membership
//     test is a bound literal list.
//
// ## Totality, and why the expression is compiled twice
//
// `planToBrackets` returns a `Brackets` for every input or throws. It never
// returns `undefined`, and it never produces an empty `Brackets` — TypeORM's
// equivalent of drizzle's `SQL | undefined` hazard, and just as invisible.
//
// The final SQL needs two things only the *target query builder* has: its main
// alias, and the parameter names already on it. Both are available inside the
// `Brackets` factory and nowhere else. But a mapping error discovered inside that
// factory would surface halfway through `getQuery()`, from a stack frame the
// caller never wrote. So the expression is compiled **twice**: once eagerly, with
// a placeholder alias, purely so every fail-closed check fires at the call site;
// once inside the factory, with the real alias and a seeded parameter counter, to
// produce the text that runs. Compilation is a pure walk over a small AST — the
// second pass costs microseconds — and the alternative is a library whose errors
// arrive at the wrong time.

import {
	assertOrderable,
	likeTokensToPattern,
	simplifyPlanNode,
	type AttrPath,
	type PlanNode,
	type PlanValue,
	type QueryPlan,
} from "@nestm/permissions-core/plan";
import { Brackets } from "typeorm";
import type { WhereExpressionBuilder } from "typeorm";

import { PlanCompilationError, UnmappedAttributeError } from "../errors.ts";
import { columnRef, type CompileContext } from "./context.ts";
import { compileHierarchy, type HierarchyTarget } from "./hierarchy.ts";
import {
	DEFAULT_ESCAPE_CHAR,
	DEFAULT_PARAMETER_PREFIX,
	type PlanCompileOptions,
	type ResolvedAttributeMapping,
	type TypeOrmResourceMapping,
	type TypeOrmScalarKind,
} from "./mapping.ts";
import { ParameterBag } from "./parameters.ts";
import { allOf, anyOf, negate, sqlFalse, sqlTrue } from "./sql-helpers.ts";
import { bindEntityId, bindScalar, sqlTypeOf } from "./values.ts";

/** A compiled boolean expression: SQL text plus the values its placeholders name. */
export interface CompiledCondition {
	/** SQL text with `:name` placeholders. Never empty. */
	readonly text: string;
	/** The values, keyed by placeholder name. */
	readonly parameters: Readonly<Record<string, unknown>>;
}

/**
 * Compiles a {@link QueryPlan} into a **total** boolean `Brackets`.
 *
 * ```ts
 * const plan = await permissions.plan({ scope, principal, action: "run:read", resourceType: "Run" });
 * const rows = await dataSource
 *   .createQueryBuilder(Run, "run")
 *   .andWhere(planToBrackets(plan, runResourceMapping))
 *   .getMany();
 * ```
 *
 * - `ALWAYS_ALLOW` → `1 = 1`
 * - `ALWAYS_DENY` → `1 = 0`
 * - `CONDITIONAL` → the compiled condition
 *
 * There is deliberately no API that can return "nothing" for a plan, because
 * "nothing" concatenated into a query is a `WHERE` clause that was omitted, which
 * is every row in the table.
 *
 * @throws {@link PlanCompilationError} for any node the mapping does not cover,
 * and for a plan carrying a permissive approximation the caller has not
 * explicitly accepted. It throws **here**, not when the query is built.
 */
export function planToBrackets<R extends string>(
	plan: QueryPlan<R>,
	mapping: TypeOrmResourceMapping<R>,
	options: PlanCompileOptions = {},
): Brackets {
	assertResourceType(plan, mapping);
	assertApproximations(plan, options);

	const node = planCondition(plan, mapping);
	return nodeToBrackets(node, mapping, options);
}

/**
 * Compiles a bare {@link PlanNode}.
 *
 * The primitive behind {@link planToBrackets}, for callers holding a condition
 * rather than a whole plan (a test, a hand-built filter). Prefer `planToBrackets`:
 * it also enforces the resource-type and approximation checks, which a bare node
 * cannot carry.
 */
export function planNodeToBrackets<R extends string>(
	node: PlanNode,
	mapping: TypeOrmResourceMapping<R>,
	options: PlanCompileOptions = {},
): Brackets {
	return nodeToBrackets(
		simplifyPlanNode(node, { resourceType: mapping.resourceType }),
		mapping,
		options,
	);
}

/**
 * Compiles a plan to raw SQL text and parameters, for a caller who is not using a
 * query builder at all (a golden-SQL test, a hand-written `manager.query`).
 *
 * The alias must be supplied or omitted deliberately: unlike {@link planToBrackets},
 * nothing here can discover it later.
 */
export function planToSql<R extends string>(
	plan: QueryPlan<R>,
	mapping: TypeOrmResourceMapping<R>,
	options: PlanCompileOptions = {},
): CompiledCondition {
	assertResourceType(plan, mapping);
	assertApproximations(plan, options);

	return compileCondition(planCondition(plan, mapping), mapping, {
		alias: options.alias,
		prefix: options.parameterPrefix ?? DEFAULT_PARAMETER_PREFIX,
		taken: [],
	});
}

/**
 * {@link planToSql} for a bare {@link PlanNode} — the counterpart of
 * `@nestm/permissions-drizzle`'s `planNodeToSql`.
 *
 * Prefer {@link planToSql}: a bare node carries neither the resource type nor the
 * approximations, so neither can be checked.
 */
export function planNodeToSql<R extends string>(
	node: PlanNode,
	mapping: TypeOrmResourceMapping<R>,
	options: PlanCompileOptions = {},
): CompiledCondition {
	return compileCondition(simplifyPlanNode(node, { resourceType: mapping.resourceType }), mapping, {
		alias: options.alias,
		prefix: options.parameterPrefix ?? DEFAULT_PARAMETER_PREFIX,
		taken: [],
	});
}

// ---------------------------------------------------------------------------
// The two-pass shell
// ---------------------------------------------------------------------------

/** The node a plan filters by, with `isType` folded against the planned type. */
function planCondition(plan: QueryPlan<string>, mapping: TypeOrmResourceMapping): PlanNode {
	if (plan.kind === "ALWAYS_ALLOW") {
		return { op: "true" };
	}
	if (plan.kind === "ALWAYS_DENY") {
		return { op: "false" };
	}
	// Folds `isType` against the planned type and normalises the junctions, so the
	// emitted SQL is the shape a reader expects and the golden tests are stable.
	return simplifyPlanNode(plan.condition, { resourceType: mapping.resourceType });
}

interface CompileRun {
	readonly alias: string | undefined;
	readonly prefix: string;
	readonly taken: Iterable<string>;
}

function compileCondition(
	node: PlanNode,
	mapping: TypeOrmResourceMapping,
	run: CompileRun,
): CompiledCondition {
	const parameters = new ParameterBag(run.prefix, run.taken);
	const context: CompileContext = {
		mapping,
		parameters,
		alias: run.alias,
		escape: (name) => mapping.dataSource.driver.escape(name),
	};

	return { text: compileNode(node, context), parameters: parameters.values };
}

function nodeToBrackets(
	node: PlanNode,
	mapping: TypeOrmResourceMapping,
	options: PlanCompileOptions,
): Brackets {
	const prefix = options.parameterPrefix ?? DEFAULT_PARAMETER_PREFIX;

	// Pass one: eager, discarded. Everything that can throw throws here, at the
	// call site, rather than inside TypeORM's `getQuery()`.
	compileCondition(node, mapping, {
		alias: options.alias ?? mapping.metadata.tableName,
		prefix,
		taken: [],
	});

	return new Brackets((qb) => {
		const builder = qb as BracketsBuilder;
		const expressionMap = builder.expressionMap;

		// TypeORM hands the factory a child builder whose `expressionMap.parameters`
		// is the *same object* as the parent's, so this sees every name already
		// bound — including those of an earlier `applyPlan` on the same builder.
		const taken = Object.keys(expressionMap?.parameters ?? {});
		const alias =
			options.alias ??
			(expressionMap?.aliasNamePrefixingEnabled === false
				? undefined
				: expressionMap?.mainAlias?.name);

		const compiled = compileCondition(node, mapping, { alias, prefix, taken });
		qb.where(compiled.text, { ...compiled.parameters });
	});
}

/** The parts of the builder TypeORM hands a `Brackets` factory that are not in its public type. */
interface BracketsBuilder extends WhereExpressionBuilder {
	readonly expressionMap?: {
		readonly parameters?: Record<string, unknown>;
		readonly mainAlias?: { readonly name?: string };
		readonly aliasNamePrefixingEnabled?: boolean;
	};
}

// ---------------------------------------------------------------------------
// Pre-flight
// ---------------------------------------------------------------------------

function assertResourceType(plan: QueryPlan<string>, mapping: TypeOrmResourceMapping): void {
	if (plan.resourceType !== mapping.resourceType) {
		throw new PlanCompilationError(
			"resource-type-mismatch",
			`The plan filters "${plan.resourceType}" but the mapping describes ` +
				`"${mapping.resourceType}". Compiling it would apply one type's policies to another ` +
				`type's rows.`,
			{ resourceType: plan.resourceType },
		);
	}
}

/**
 * A permissive approximation means the filter selects a **superset** of the
 * authorized rows. Compiling one silently is the vulnerability the whole
 * `approximations[]` mechanism exists to prevent, so both halves of the opt-in
 * are required: the flag *and* a `postFilter` to actually narrow the result.
 *
 * `ALWAYS_DENY` is exempt. It selects nothing, so no approximation it carries can
 * over-share; refusing it would only make the fail-closed answer unavailable.
 */
function assertApproximations(plan: QueryPlan<string>, options: PlanCompileOptions): void {
	if (plan.kind === "ALWAYS_DENY") {
		return;
	}

	const permissive = plan.approximations.filter(
		(approximation) => approximation.direction === "permissive",
	);
	if (permissive.length === 0) {
		return;
	}

	const postFilter = plan.kind === "CONDITIONAL" ? plan.postFilter : undefined;

	if (options.allowPermissiveApproximations !== true || postFilter === undefined) {
		const first = permissive[0];
		throw new PlanCompilationError(
			"permissive-approximation",
			`This plan carries ${String(permissive.length)} permissive approximation(s) — the filter ` +
				`selects more rows than check() would allow. First: policy "${first?.policyId ?? "?"}" ` +
				`(${first?.reason ?? "?"}) — ${first?.message ?? ""}. Compiling it requires BOTH ` +
				`allowPermissiveApproximations: true AND a plan.postFilter to re-check the rows; ` +
				`${options.allowPermissiveApproximations === true ? "the plan carries no postFilter" : "the flag was not set"}. ` +
				`Fix the policy, or plan with unsupportedResidual: "post-filter".`,
			{ resourceType: plan.resourceType },
		);
	}
}

// ---------------------------------------------------------------------------
// Nodes
// ---------------------------------------------------------------------------

function compileNode(node: PlanNode, context: CompileContext): string {
	switch (node.op) {
		case "true": {
			return sqlTrue();
		}
		case "false": {
			return sqlFalse();
		}
		case "and": {
			return allOf(node.nodes.map((child) => compileNode(child, context)));
		}
		case "or": {
			return anyOf(node.nodes.map((child) => compileNode(child, context)));
		}
		case "not": {
			return negate(compileNode(node.node, context));
		}
		case "cmp": {
			return compileCmp(node, context);
		}
		case "in": {
			return compileIn(node, context);
		}
		case "contains": {
			return compileContains(node, context);
		}
		case "like": {
			return compileLike(node, context);
		}
		case "exists": {
			return `${valueExpression(resolve(node.attr, context), context, node.attr)} is not null`;
		}
		case "isEmpty": {
			return compileIsEmpty(node, context);
		}
		case "isType": {
			// `simplifyPlanNode` folds this against the planned type, so it only
			// survives in a hand-built tree. Every row of a single-type query is that
			// type, which makes it a constant either way.
			return node.entityType === context.mapping.resourceType ? sqlTrue() : sqlFalse();
		}
		case "inHierarchy": {
			return compileInHierarchy(node, context);
		}
	}
}

const SQL_OPERATORS: Readonly<Record<"eq" | "ne" | "lt" | "lte" | "gt" | "gte", string>> = {
	eq: "=",
	ne: "<>",
	lt: "<",
	lte: "<=",
	gt: ">",
	gte: ">=",
};

function compileCmp(node: Extract<PlanNode, { op: "cmp" }>, context: CompileContext): string {
	const mapping = context.mapping;
	const attr = node.attr;
	const attribute = resolve(attr, context);
	const ordering = node.cmp !== "eq" && node.cmp !== "ne";

	if (ordering) {
		// Cedar has no ordering for strings, bools, entities, ipaddrs or sets; SQL
		// orders all of them, and does it under the column's collation. A plan that
		// reached here with one is a mapping bug, and emitting `<` would return rows
		// Cedar never authorized — locale-dependently.
		try {
			assertOrderable(node.value);
		} catch (cause) {
			throw new PlanCompilationError(
				"unorderable-comparison",
				`"${mapping.resourceType}.${pathOf(node.attr)}" is compared with "${node.cmp}" against a ` +
					`${node.value.kind}, which Cedar does not order. SQL would order it anyway — for a ` +
					`string, under the column's collation — and select rows check() would deny.`,
				{ resourceType: mapping.resourceType, attribute: pathOf(node.attr), cause },
			);
		}
	}

	if (node.value.kind === "entity") {
		return compileEntityCmp(node.cmp, attribute, node.value.value, node.attr, context);
	}

	if (node.value.kind === "set") {
		return compileSetCmp(node.cmp, attribute, node.value.value, node.attr, context);
	}

	const left = valueExpression(attribute, context, node.attr);
	const right = bindScalar(
		context.parameters,
		node.value,
		scalarKindOf(attribute, node.attr, context),
		{ resourceType: mapping.resourceType, attribute: pathOf(node.attr) },
	);

	return `${left} ${SQL_OPERATORS[node.cmp]} ${right}`;
}

function compileEntityCmp(
	cmp: Extract<PlanNode, { op: "cmp" }>["cmp"],
	attribute: ResolvedAttributeMapping,
	reference: { readonly type: string; readonly id: string },
	attr: AttrPath,
	context: CompileContext,
): string {
	const mapping = context.mapping;

	if (attribute.kind !== "entity") {
		throw new PlanCompilationError(
			"entity-column-mismatch",
			`The plan compares "${mapping.resourceType}.${pathOf(attr)}" against the entity ` +
				`${reference.type}::"${reference.id}", but the mapping declares it as ` +
				`"${attribute.kind}". Only an { kind: "entity" } mapping knows that its column holds ` +
				`ids of a particular type.`,
			{ resourceType: mapping.resourceType, attribute: pathOf(attr) },
		);
	}

	if (attribute.entityType !== reference.type) {
		// A column holding `User` ids can never equal a `Group` reference, whatever
		// the ids look like. Folding is exact here, not an approximation.
		return cmp === "eq" ? sqlFalse() : sqlTrue();
	}

	return `${columnRef(context, attribute.column)} ${SQL_OPERATORS[cmp]} ${bindEntityId(context.parameters, reference.id)}`;
}

/**
 * Cedar set equality is unordered and duplicate-insensitive — `[1,2,2] == [2,1]`
 * is `true` — which is *exactly* mutual containment, and exactly what Postgres's
 * `@>`/`<@` compute for arrays. Plain `=` on arrays is element-wise and ordered,
 * so it is the one spelling that must not be used here.
 */
function compileSetCmp(
	cmp: Extract<PlanNode, { op: "cmp" }>["cmp"],
	attribute: ResolvedAttributeMapping,
	elements: readonly PlanValue[],
	attr: AttrPath,
	context: CompileContext,
): string {
	const mapping = context.mapping;

	if (attribute.kind !== "array") {
		throw new PlanCompilationError(
			"contains-on-scalar",
			`The plan compares "${mapping.resourceType}.${pathOf(attr)}" against a Cedar set, but the ` +
				`mapping declares it as "${attribute.kind}". Map a set-valued attribute with ` +
				`{ kind: "array" }.`,
			{ resourceType: mapping.resourceType, attribute: pathOf(attr) },
		);
	}

	const literal = arrayLiteral(elements, attribute, attr, context);
	const column = columnRef(context, attribute.column);
	const equal = `(${column} @> ${literal} and ${column} <@ ${literal})`;
	return cmp === "eq" ? equal : negate(equal);
}

function compileIn(node: Extract<PlanNode, { op: "in" }>, context: CompileContext): string {
	const mapping = context.mapping;

	// Empty ⇒ `1 = 0`. `col IN ()` is a syntax error in Postgres, and TypeORM's
	// `:...name` spread produces exactly that for an empty array, so the list is
	// never handed over empty.
	if (node.values.length === 0) {
		return sqlFalse();
	}

	if (node.attr === null) {
		const ids: string[] = [];
		for (const value of node.values) {
			if (value.kind !== "entity") {
				throw new PlanCompilationError(
					"entity-column-mismatch",
					`The plan tests the ${mapping.resourceType} row identity against a ${value.kind} ` +
						"constant; row-identity membership accepts only entity references.",
					{ resourceType: mapping.resourceType },
				);
			}
			if (value.value.type === mapping.resourceType) {
				ids.push(bindEntityId(context.parameters, value.value.id));
			}
		}
		if (ids.length === 0) {
			return sqlFalse();
		}
		return `${columnRef(context, mapping.id)} in (${ids.join(", ")})`;
	}

	const attr = node.attr;
	const attribute = resolve(attr, context);

	if (attribute.kind === "entity") {
		const ids: string[] = [];
		for (const value of node.values) {
			if (value.kind !== "entity") {
				throw new PlanCompilationError(
					"entity-column-mismatch",
					`"${mapping.resourceType}.${pathOf(attr)}" is mapped as an entity column, but ` +
						`the plan tests it against a ${value.kind} constant.`,
					{ resourceType: mapping.resourceType, attribute: pathOf(attr) },
				);
			}
			// A constant of a different type can never equal an id in this column, so
			// it contributes nothing to the membership test rather than being an error.
			if (value.value.type === attribute.entityType) {
				ids.push(bindEntityId(context.parameters, value.value.id));
			}
		}
		if (ids.length === 0) {
			return sqlFalse();
		}
		return `${columnRef(context, attribute.column)} in (${ids.join(", ")})`;
	}

	const kind = scalarKindOf(attribute, attr, context);
	const binds = node.values.map((value) =>
		bindScalar(context.parameters, value, kind, {
			resourceType: mapping.resourceType,
			attribute: pathOf(attr),
		}),
	);

	return `${valueExpression(attribute, context, attr)} in (${binds.join(", ")})`;
}

function compileContains(
	node: Extract<PlanNode, { op: "contains" }>,
	context: CompileContext,
): string {
	const mapping = context.mapping;
	const attribute = resolve(node.attr, context);

	if (attribute.kind === "array") {
		const literal = arrayLiteral([node.value], attribute, node.attr, context);
		return `${columnRef(context, attribute.column)} @> ${literal}`;
	}

	if (attribute.kind === "jsonPath") {
		// `@>` on jsonb is containment, and a one-element array is contained by any
		// array holding that element — the same question `Set::contains` asks. The
		// document is *bound*, not interpolated: a string element containing `'` or
		// `:` must not reach the statement text.
		const element = jsonScalar(node.value, node.attr, context);
		const document = context.parameters.bind(JSON.stringify([element]));
		return `${jsonExpression(attribute, context)} @> ${document}::jsonb`;
	}

	throw new PlanCompilationError(
		"contains-on-scalar",
		`The plan calls contains() on "${mapping.resourceType}.${pathOf(node.attr)}", which the ` +
			`mapping declares as "${attribute.kind}". A scalar column holds one value; only an ` +
			`{ kind: "array" } or { kind: "jsonPath" } mapping can answer set membership.`,
		{ resourceType: mapping.resourceType, attribute: pathOf(node.attr) },
	);
}

function compileLike(node: Extract<PlanNode, { op: "like" }>, context: CompileContext): string {
	const mapping = context.mapping;
	const attribute = resolve(node.attr, context);

	if (mapping.text?.collation === "case-insensitive") {
		throw new PlanCompilationError(
			"case-insensitive-like",
			`"${mapping.resourceType}" declares a case-insensitive collation, and Cedar's "like" is ` +
				`case-sensitive. SQL LIKE under citext (or an ICU non-deterministic collation) would ` +
				`match strings Cedar does not, silently widening every pattern. Use an exact-collation ` +
				`column for attributes policies match with "like".`,
			{ resourceType: mapping.resourceType, attribute: pathOf(node.attr) },
		);
	}

	if (scalarKindOf(attribute, node.attr, context) !== "string") {
		throw new PlanCompilationError(
			"value-kind-mismatch",
			`The plan matches "${mapping.resourceType}.${pathOf(node.attr)}" with "like", but the ` +
				`mapping does not declare it as a string column.`,
			{ resourceType: mapping.resourceType, attribute: pathOf(node.attr) },
		);
	}

	const escapeChar = mapping.text?.escapeChar ?? DEFAULT_ESCAPE_CHAR;

	// The escaping lives in core (delta D5) and takes the **tokens**, never a
	// rendered string: `{ literal: "%" }` is a literal percent sign that must be
	// escaped for SQL, while `{ wildcard: true }` becomes `%`. Cedar has no `\%`
	// escape at all — `like "50\%*"` is a parse error — so every `%` and `_` in a
	// pattern reached the driver as ordinary text and would become a wildcard if
	// this step were skipped.
	const pattern = likeTokensToPattern(node.pattern, { escapeChar });

	// Both the pattern and the escape character are bound. `ESCAPE '\'` written
	// literally depends on `standard_conforming_strings`; a parameter does not.
	return (
		`${valueExpression(attribute, context, node.attr)} like ${context.parameters.bind(pattern)} ` +
		`escape ${context.parameters.bind(escapeChar)}`
	);
}

function compileIsEmpty(
	node: Extract<PlanNode, { op: "isEmpty" }>,
	context: CompileContext,
): string {
	const mapping = context.mapping;
	const attribute = resolve(node.attr, context);

	if (attribute.kind === "array") {
		// `cardinality(NULL)` is NULL, which is the answer an absent attribute needs.
		// The design's `coalesce(array_length(col,1),0) = 0` is two-valued and says
		// `true` for a NULL column, which would make a *negated* isEmpty drop rows the
		// interpreter keeps.
		return `cardinality(${columnRef(context, attribute.column)}) = 0`;
	}

	if (attribute.kind === "jsonPath") {
		return `jsonb_array_length(${jsonExpression(attribute, context)}) = 0`;
	}

	throw new PlanCompilationError(
		"contains-on-scalar",
		`The plan calls isEmpty() on "${mapping.resourceType}.${pathOf(node.attr)}", which the ` +
			`mapping declares as "${attribute.kind}". Only an array or jsonPath mapping has a length.`,
		{ resourceType: mapping.resourceType, attribute: pathOf(node.attr) },
	);
}

function compileInHierarchy(
	node: Extract<PlanNode, { op: "inHierarchy" }>,
	context: CompileContext,
): string {
	const mapping = context.mapping;

	if (node.attr === null) {
		const target: HierarchyTarget = {
			column: mapping.id,
			entityType: mapping.resourceType,
			mappings: [mapping.hierarchy],
			label: "resource",
			viaAttribute: false,
			resourceType: mapping.resourceType,
		};
		return compileHierarchy(context, target, node.parent);
	}

	const attribute = resolve(node.attr, context);
	if (attribute.kind !== "entity") {
		throw new PlanCompilationError(
			"entity-column-mismatch",
			`The plan filters on "resource.${pathOf(node.attr)} in ${node.parent.type}::…", so that ` +
				`attribute must hold entity ids — but the mapping declares it as "${attribute.kind}". ` +
				`Use { kind: "entity", column, entityType } for a reference column.`,
			{
				resourceType: mapping.resourceType,
				attribute: pathOf(node.attr),
				parentType: node.parent.type,
			},
		);
	}

	const target: HierarchyTarget = {
		column: attribute.column,
		entityType: attribute.entityType,
		// The attribute's own mappings win; the resource-level ones are consulted
		// only for the id-keyed strategies, which answer for any seed.
		mappings: [attribute.hierarchy, mapping.hierarchy],
		label: `resource.${pathOf(node.attr)}`,
		viaAttribute: true,
		resourceType: mapping.resourceType,
	};
	return compileHierarchy(context, target, node.parent);
}

// ---------------------------------------------------------------------------
// Attributes
// ---------------------------------------------------------------------------

function pathOf(attr: AttrPath): string {
	return attr.path.join(".");
}

function resolve(attr: AttrPath, context: CompileContext): ResolvedAttributeMapping {
	const mapping = context.mapping;

	if (attr.root !== "resource") {
		throw new UnmappedAttributeError(
			`The plan reads "${attr.root}.${pathOf(attr)}", but rows carry resource attributes only. ` +
				`A principal-rooted path means the plan was compiled for a different unknown than the ` +
				`rows being filtered.`,
			{ resourceType: mapping.resourceType, attribute: pathOf(attr) },
		);
	}
	if (attr.path.length !== 1) {
		throw new UnmappedAttributeError(
			`The plan reads "resource.${pathOf(attr)}", a depth-${String(attr.path.length)} path. ` +
				`Compiled plans are depth 1 — nested access needs a join the planner cannot know ` +
				`about and is rejected upstream as "nested-attribute".`,
			{ resourceType: mapping.resourceType, attribute: pathOf(attr) },
		);
	}

	const name = attr.path[0] as string;
	const attribute = mapping.attributes[name];

	if (attribute === undefined) {
		throw new UnmappedAttributeError(
			`The plan filters on "${mapping.resourceType}.${name}" and the mapping declares no column ` +
				`for it. Known attributes: ${describeKnown(mapping)}. This is not degraded to TRUE — ` +
				`a filter the driver cannot express is a filter it must refuse, not one it may drop.`,
			{ resourceType: mapping.resourceType, attribute: name },
		);
	}

	return attribute;
}

function describeKnown(mapping: TypeOrmResourceMapping): string {
	const names = Object.keys(mapping.attributes).toSorted();
	return names.length === 0 ? "(none)" : names.join(", ");
}

/** The SQL expression that reads the attribute's value. */
function valueExpression(
	attribute: ResolvedAttributeMapping,
	context: CompileContext,
	attr: AttrPath,
): string {
	switch (attribute.kind) {
		case "scalar":
		case "entity":
		case "array": {
			return columnRef(context, attribute.column);
		}
		case "jsonPath": {
			// `#>>` yields `text` and, crucially, yields SQL NULL for both a missing key
			// and a JSON `null` — which is what "absent" means to Cedar.
			const text = `(${columnRef(context, attribute.column)} #>> ${jsonPath(attribute, context)})`;
			return attribute.valueKind === "string"
				? text
				: `${text}::${JSON_CASTS[attribute.valueKind]}`;
		}
		default: {
			throw new PlanCompilationError(
				"invalid-mapping",
				`"${context.mapping.resourceType}.${pathOf(attr)}" has an unrecognised mapping kind.`,
				{ resourceType: context.mapping.resourceType, attribute: pathOf(attr) },
			);
		}
	}
}

const JSON_CASTS: Readonly<Record<TypeOrmScalarKind, string>> = {
	string: "text",
	long: "bigint",
	bool: "boolean",
	datetime: "timestamptz",
	duration: "bigint",
	decimal: "numeric",
	ipaddr: "inet",
};

/** The jsonb sub-document at the mapped path, for containment and length. */
function jsonExpression(
	attribute: Extract<ResolvedAttributeMapping, { kind: "jsonPath" }>,
	context: CompileContext,
): string {
	return `(${columnRef(context, attribute.column)} #> ${jsonPath(attribute, context)})`;
}

/**
 * The path operand, bound as a `text[]`.
 *
 * Bound rather than written as a literal because a JSON key is data — it can hold
 * a quote, and `'{a''b}'` is a quoting puzzle nobody should have to get right.
 * The explicit cast is what tells Postgres the parameter is an array rather than
 * an unknown-typed scalar.
 */
function jsonPath(
	attribute: Extract<ResolvedAttributeMapping, { kind: "jsonPath" }>,
	context: CompileContext,
): string {
	return `${context.parameters.bind([...attribute.path])}::text[]`;
}

function scalarKindOf(
	attribute: ResolvedAttributeMapping,
	attr: AttrPath,
	context: CompileContext,
): TypeOrmScalarKind {
	switch (attribute.kind) {
		case "scalar":
		case "jsonPath": {
			return attribute.valueKind;
		}
		case "array": {
			return attribute.elementKind;
		}
		case "entity": {
			throw new PlanCompilationError(
				"entity-column-mismatch",
				`"${context.mapping.resourceType}.${pathOf(attr)}" is mapped as an entity column, but ` +
					`the plan compares it against a scalar constant. Entity columns are only comparable ` +
					`to entity references.`,
				{ resourceType: context.mapping.resourceType, attribute: pathOf(attr) },
			);
		}
	}
}

/**
 * `ARRAY[…]::<column type>`.
 *
 * Cast to the column's own array type so containment compares like with like —
 * `text[]`, `bigint[]`, an enum array — rather than relying on Postgres to guess
 * the type of an `ARRAY[$1]` whose only element is an unknown-typed parameter.
 * The empty case needs the cast to be legal at all.
 */
function arrayLiteral(
	elements: readonly PlanValue[],
	attribute: Extract<ResolvedAttributeMapping, { kind: "array" }>,
	attr: AttrPath,
	context: CompileContext,
): string {
	const bindContext = {
		resourceType: context.mapping.resourceType,
		attribute: pathOf(attr),
	};
	const binds = elements.map((element) =>
		bindScalar(context.parameters, element, attribute.elementKind, bindContext),
	);
	const type = sqlTypeOf(context.mapping.dataSource, attribute.column);
	return `array[${binds.join(", ")}]::${type}`;
}

/** A `PlanValue` as the JSON scalar a `jsonb` document would hold. */
function jsonScalar(
	value: PlanValue,
	attr: AttrPath,
	context: CompileContext,
): string | number | boolean {
	switch (value.kind) {
		case "string":
		case "decimal":
		case "ipaddr": {
			return value.value;
		}
		case "bool": {
			return value.value;
		}
		case "long": {
			return Number(value.value);
		}
		case "duration": {
			return value.value;
		}
		case "datetime": {
			return value.value.toISOString();
		}
		default: {
			throw new PlanCompilationError(
				"value-kind-mismatch",
				`"${context.mapping.resourceType}.${pathOf(attr)}" is a jsonPath mapping, and a ` +
					`${value.kind} has no JSON scalar form to test containment with.`,
				{ resourceType: context.mapping.resourceType, attribute: pathOf(attr) },
			);
		}
	}
}
