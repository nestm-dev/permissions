// `planToSql` — the whole point of this package.
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
// ## Totality
//
// `planToSql` returns an `SQL` for every input or throws. It never returns
// `undefined`, and it never calls drizzle's `and()`/`or()`, whose `SQL |
// undefined` return type is the same hazard wearing a type signature.

import {
	assertOrderable,
	likeTokensToPattern,
	simplifyPlanNode,
	type AttrPath,
	type PlanNode,
	type PlanValue,
	type QueryPlan,
} from "@nestm/permissions-core/plan";
import { sql, type SQL } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";

import { PlanCompilationError, UnmappedAttributeError } from "../errors.ts";
import { compileHierarchy, type HierarchyTarget } from "./hierarchy.ts";
import {
	DEFAULT_ESCAPE_CHAR,
	type DrizzleAttributeMapping,
	type DrizzleResourceMapping,
	type DrizzleScalarKind,
	type PlanCompileOptions,
} from "./mapping.ts";
import { allOf, anyOf, negate, sqlFalse, sqlTrue } from "./sql-helpers.ts";
import { bindEntityId, bindScalar, sqlTypeOf } from "./values.ts";

/**
 * Compiles a {@link QueryPlan} into a **total** boolean SQL expression.
 *
 * ```ts
 * const plan = await permissions.plan({ scope, principal, action: "run:read", resourceType: "Run" });
 * const rows = await db.select().from(runs).where(planToSql(plan, runResourceMapping));
 * ```
 *
 * - `ALWAYS_ALLOW` → `true`
 * - `ALWAYS_DENY` → `false`
 * - `CONDITIONAL` → the compiled condition
 *
 * There is deliberately no API that can return "nothing" for a plan, because
 * "nothing" concatenated into a query is a `WHERE` clause that was omitted, which
 * is every row in the table.
 *
 * @throws {@link PlanCompilationError} for any node the mapping does not cover,
 * and for a plan carrying a permissive approximation the caller has not
 * explicitly accepted.
 */
export function planToSql<R extends string>(
	plan: QueryPlan<R>,
	mapping: DrizzleResourceMapping<R>,
	options: PlanCompileOptions = {},
): SQL {
	assertResourceType(plan, mapping);
	assertApproximations(plan, options);

	if (plan.kind === "ALWAYS_ALLOW") {
		return sqlTrue();
	}
	if (plan.kind === "ALWAYS_DENY") {
		return sqlFalse();
	}

	// Folds `isType` against the planned type and normalises the junctions, so the
	// emitted SQL is the shape a reader expects and the golden tests are stable.
	const condition = simplifyPlanNode(plan.condition, { resourceType: mapping.resourceType });
	return compileNode(condition, mapping);
}

/**
 * Compiles a bare {@link PlanNode}.
 *
 * The primitive behind {@link planToSql}, for callers holding a condition rather
 * than a whole plan (a test, a hand-built filter). Prefer `planToSql`: it also
 * enforces the resource-type and approximation checks, which a bare node cannot
 * carry.
 */
export function planNodeToSql<R extends string>(
	node: PlanNode,
	mapping: DrizzleResourceMapping<R>,
): SQL {
	return compileNode(simplifyPlanNode(node, { resourceType: mapping.resourceType }), mapping);
}

// ---------------------------------------------------------------------------
// Pre-flight
// ---------------------------------------------------------------------------

function assertResourceType(plan: QueryPlan<string>, mapping: DrizzleResourceMapping): void {
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

function compileNode(node: PlanNode, mapping: DrizzleResourceMapping): SQL {
	switch (node.op) {
		case "true": {
			return sqlTrue();
		}
		case "false": {
			return sqlFalse();
		}
		case "and": {
			return allOf(node.nodes.map((child) => compileNode(child, mapping)));
		}
		case "or": {
			return anyOf(node.nodes.map((child) => compileNode(child, mapping)));
		}
		case "not": {
			return negate(compileNode(node.node, mapping));
		}
		case "cmp": {
			return compileCmp(node, mapping);
		}
		case "in": {
			return compileIn(node, mapping);
		}
		case "contains": {
			return compileContains(node, mapping);
		}
		case "like": {
			return compileLike(node, mapping);
		}
		case "exists": {
			return sql`${valueExpression(resolve(node.attr, mapping), mapping, node.attr)} is not null`;
		}
		case "isEmpty": {
			return compileIsEmpty(node, mapping);
		}
		case "isType": {
			// `simplifyPlanNode` folds this against the planned type, so it only
			// survives in a hand-built tree. Every row of a single-type query is that
			// type, which makes it a constant either way.
			return node.entityType === mapping.resourceType ? sqlTrue() : sqlFalse();
		}
		case "inHierarchy": {
			return compileInHierarchy(node, mapping);
		}
	}
}

function compileCmp(node: Extract<PlanNode, { op: "cmp" }>, mapping: DrizzleResourceMapping): SQL {
	const attr = node.attr;
	const attribute = resolve(attr, mapping);
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
		return compileEntityCmp(node.cmp, attribute, node.value.value, node.attr, mapping);
	}

	if (node.value.kind === "set") {
		return compileSetCmp(node.cmp, attribute, node.value.value, node.attr, mapping);
	}

	const left = valueExpression(attribute, mapping, node.attr);
	const right = bindScalar(node.value, scalarKindOf(attribute, node.attr, mapping), {
		resourceType: mapping.resourceType,
		attribute: pathOf(node.attr),
	});

	return sql`${left} ${sql.raw(SQL_OPERATORS[node.cmp])} ${right}`;
}

const SQL_OPERATORS: Readonly<Record<"eq" | "ne" | "lt" | "lte" | "gt" | "gte", string>> = {
	eq: "=",
	ne: "<>",
	lt: "<",
	lte: "<=",
	gt: ">",
	gte: ">=",
};

function compileEntityCmp(
	cmp: Extract<PlanNode, { op: "cmp" }>["cmp"],
	attribute: DrizzleAttributeMapping,
	reference: { readonly type: string; readonly id: string },
	attr: AttrPath,
	mapping: DrizzleResourceMapping,
): SQL {
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

	return sql`${attribute.column} ${sql.raw(SQL_OPERATORS[cmp])} ${bindEntityId(reference.id)}`;
}

/**
 * Cedar set equality is unordered and duplicate-insensitive — `[1,2,2] == [2,1]`
 * is `true` — which is *exactly* mutual containment, and exactly what Postgres's
 * `@>`/`<@` compute for arrays. Plain `=` on arrays is element-wise and ordered,
 * so it is the one spelling that must not be used here.
 */
function compileSetCmp(
	cmp: Extract<PlanNode, { op: "cmp" }>["cmp"],
	attribute: DrizzleAttributeMapping,
	elements: readonly PlanValue[],
	attr: AttrPath,
	mapping: DrizzleResourceMapping,
): SQL {
	if (attribute.kind !== "array") {
		throw new PlanCompilationError(
			"contains-on-scalar",
			`The plan compares "${mapping.resourceType}.${pathOf(attr)}" against a Cedar set, but the ` +
				`mapping declares it as "${attribute.kind}". Map a set-valued attribute with ` +
				`{ kind: "array" }.`,
			{ resourceType: mapping.resourceType, attribute: pathOf(attr) },
		);
	}

	const literal = arrayLiteral(elements, attribute.column, attribute.elementKind, attr, mapping);
	const equal = sql`(${attribute.column} @> ${literal} and ${attribute.column} <@ ${literal})`;
	return cmp === "eq" ? equal : negate(equal);
}

function compileIn(node: Extract<PlanNode, { op: "in" }>, mapping: DrizzleResourceMapping): SQL {
	// Empty ⇒ `false`. `col IN ()` is a syntax error in Postgres, and drizzle's
	// `inArray` produces it, so the list is never handed over empty.
	if (node.values.length === 0) {
		return sqlFalse();
	}

	if (node.attr === null) {
		const ids: SQL[] = [];
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
				ids.push(bindEntityId(value.value.id));
			}
		}
		return ids.length === 0 ? sqlFalse() : sql`${mapping.id} in (${sql.join(ids, sql`, `)})`;
	}

	const attr = node.attr;
	const attribute = resolve(attr, mapping);

	if (attribute.kind === "entity") {
		const ids: SQL[] = [];
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
				ids.push(bindEntityId(value.value.id));
			}
		}
		if (ids.length === 0) {
			return sqlFalse();
		}
		return sql`${attribute.column} in (${sql.join(ids, sql`, `)})`;
	}

	const kind = scalarKindOf(attribute, attr, mapping);
	const binds = node.values.map((value) =>
		bindScalar(value, kind, {
			resourceType: mapping.resourceType,
			attribute: pathOf(attr),
		}),
	);

	return sql`${valueExpression(attribute, mapping, attr)} in (${sql.join(binds, sql`, `)})`;
}

function compileContains(
	node: Extract<PlanNode, { op: "contains" }>,
	mapping: DrizzleResourceMapping,
): SQL {
	const attribute = resolve(node.attr, mapping);

	if (attribute.kind === "array") {
		const literal = arrayLiteral(
			[node.value],
			attribute.column,
			attribute.elementKind,
			node.attr,
			mapping,
		);
		return sql`${attribute.column} @> ${literal}`;
	}

	if (attribute.kind === "jsonPath") {
		// `@>` on jsonb is containment, and a one-element array is contained by any
		// array holding that element — the same question `Set::contains` asks.
		const element = jsonScalar(node.value, node.attr, mapping);
		return sql`${jsonExpression(attribute)} @> ${JSON.stringify([element])}::jsonb`;
	}

	throw new PlanCompilationError(
		"contains-on-scalar",
		`The plan calls contains() on "${mapping.resourceType}.${pathOf(node.attr)}", which the ` +
			`mapping declares as "${attribute.kind}". A scalar column holds one value; only an ` +
			`{ kind: "array" } or { kind: "jsonPath" } mapping can answer set membership.`,
		{ resourceType: mapping.resourceType, attribute: pathOf(node.attr) },
	);
}

function compileLike(
	node: Extract<PlanNode, { op: "like" }>,
	mapping: DrizzleResourceMapping,
): SQL {
	const attribute = resolve(node.attr, mapping);

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

	if (scalarKindOf(attribute, node.attr, mapping) !== "string") {
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
	return sql`${valueExpression(attribute, mapping, node.attr)} like ${pattern} escape ${escapeChar}`;
}

function compileIsEmpty(
	node: Extract<PlanNode, { op: "isEmpty" }>,
	mapping: DrizzleResourceMapping,
): SQL {
	const attribute = resolve(node.attr, mapping);

	if (attribute.kind === "array") {
		// `cardinality(NULL)` is NULL, which is the answer an absent attribute needs.
		// The design's `coalesce(array_length(col,1),0) = 0` is two-valued and says
		// `true` for a NULL column, which would make a *negated* isEmpty drop rows the
		// interpreter keeps.
		return sql`cardinality(${attribute.column}) = 0`;
	}

	if (attribute.kind === "jsonPath") {
		return sql`jsonb_array_length(${jsonExpression(attribute)}) = 0`;
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
	mapping: DrizzleResourceMapping,
): SQL {
	if (node.attr === null) {
		const target: HierarchyTarget = {
			column: mapping.id,
			entityType: mapping.resourceType,
			mappings: [mapping.hierarchy],
			label: "resource",
			viaAttribute: false,
			resourceType: mapping.resourceType,
		};
		return compileHierarchy(target, node.parent);
	}

	const attribute = resolve(node.attr, mapping);
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
	return compileHierarchy(target, node.parent);
}

// ---------------------------------------------------------------------------
// Attributes
// ---------------------------------------------------------------------------

function pathOf(attr: AttrPath): string {
	return attr.path.join(".");
}

function resolve(attr: AttrPath, mapping: DrizzleResourceMapping): DrizzleAttributeMapping {
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

function describeKnown(mapping: DrizzleResourceMapping): string {
	const names = Object.keys(mapping.attributes).toSorted();
	return names.length === 0 ? "(none)" : names.join(", ");
}

/** The SQL expression that reads the attribute's value. */
function valueExpression(
	attribute: DrizzleAttributeMapping,
	mapping: DrizzleResourceMapping,
	attr: AttrPath,
): SQL {
	switch (attribute.kind) {
		case "scalar":
		case "entity":
		case "array": {
			return sql`${attribute.column}`;
		}
		case "jsonPath": {
			// `#>>` yields `text` and, crucially, yields SQL NULL for both a missing key
			// and a JSON `null` — which is what "absent" means to Cedar.
			const text = sql`(${attribute.column} #>> ${jsonPathParam(attribute.path)})`;
			return attribute.valueKind === "string"
				? text
				: sql`${text}::${sql.raw(JSON_CASTS[attribute.valueKind])}`;
		}
		default: {
			throw new PlanCompilationError(
				"invalid-mapping",
				`"${mapping.resourceType}.${pathOf(attr)}" has an unrecognised mapping kind.`,
				{ resourceType: mapping.resourceType, attribute: pathOf(attr) },
			);
		}
	}
}

const JSON_CASTS: Readonly<Record<DrizzleScalarKind, string>> = {
	string: "text",
	long: "bigint",
	bool: "boolean",
	datetime: "timestamptz",
	duration: "bigint",
	decimal: "numeric",
	ipaddr: "inet",
};

/** The jsonb sub-document at the mapped path, for containment and length. */
function jsonExpression(attribute: Extract<DrizzleAttributeMapping, { kind: "jsonPath" }>): SQL {
	return sql`(${attribute.column} #> ${jsonPathParam(attribute.path)})`;
}

/**
 * The path as **one** `text[]` bind parameter.
 *
 * `sql.param` is load-bearing and not decoration: a bare array interpolated into
 * a `sql` template is spread by drizzle into one placeholder *per element*, so
 * `#>> ${['tier']}` renders `#>> ($1)` — which Postgres reads as a scalar and
 * rejects with `malformed array literal: "tier"` — and a depth-2 path renders
 * `#>> ($1, $2)`, a row constructor. Wrapping it keeps the whole path a single
 * parameter, which node-postgres serialises as the array literal `{tier}`.
 */
function jsonPathParam(path: readonly string[]): SQL {
	return sql`${sql.param([...path])}`;
}

function scalarKindOf(
	attribute: DrizzleAttributeMapping,
	attr: AttrPath,
	mapping: DrizzleResourceMapping,
): DrizzleScalarKind {
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
				`"${mapping.resourceType}.${pathOf(attr)}" is mapped as an entity column, but the plan ` +
					`compares it against a scalar constant. Entity columns are only comparable to entity ` +
					`references.`,
				{ resourceType: mapping.resourceType, attribute: pathOf(attr) },
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
	column: PgColumn,
	elementKind: DrizzleScalarKind,
	attr: AttrPath,
	mapping: DrizzleResourceMapping,
): SQL {
	const context = { resourceType: mapping.resourceType, attribute: pathOf(attr) };
	const binds = elements.map((element) => bindScalar(element, elementKind, context));
	const inner = binds.length === 0 ? sql`` : sql.join(binds, sql`, `);
	return sql`array[${inner}]::${sqlTypeOf(column)}`;
}

/** A `PlanValue` as the JSON scalar a `jsonb` document would hold. */
function jsonScalar(
	value: PlanValue,
	attr: AttrPath,
	mapping: DrizzleResourceMapping,
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
				`"${mapping.resourceType}.${pathOf(attr)}" is a jsonPath mapping, and a ${value.kind} ` +
					`has no JSON scalar form to test containment with.`,
				{ resourceType: mapping.resourceType, attribute: pathOf(attr) },
			);
		}
	}
}
