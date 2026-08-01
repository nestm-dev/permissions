// `inHierarchy` — Cedar's `in`, compiled four ways.
//
// Two properties decide every line here, and both are shared verbatim with the
// Drizzle driver because they are properties of *Cedar*, not of an ORM.
//
// **Cedar's `in` is reflexive.** `Project::"p" in Project::"p"` is `true`. A
// compiler that only walked strict ancestors would silently drop exactly the
// rows a project-scoped grant is *about*, which reads in production as "the grant
// does not work" rather than as a bug. So every strategy below starts with
// `seed = $parent` before consulting any ancestry, and neither the closure table
// nor the recursive walk has to store self-pairs for the result to be right.
//
// **A NULL reference column must stay NULL, not become FALSE.** `EXISTS (…)` is
// two-valued: it answers `false` for a NULL seed, and `NOT false` is `true`, so a
// row whose reference column is NULL would be *selected* by a negated hierarchy
// test. The reflexive disjunct is what rescues this: `NULL = $p` is NULL, and
// `NULL OR false` is NULL, so the whole expression propagates NULL exactly as the
// reference interpreter (and Cedar) do. That is not a lucky accident of the
// spelling — it is why the reflexive test is written as a disjunct rather than
// folded into the subquery.

import type { EntityRef } from "@nestm/permissions-core";
import type { ColumnMetadata } from "typeorm/metadata/ColumnMetadata.js";

import { PlanCompilationError, UnmappedHierarchyError } from "../errors.ts";
import { aliasedColumnRef, columnRef, tableRef, type CompileContext } from "./context.ts";
import type { ResolvedHierarchyMapping } from "./mapping.ts";
import { bindEntityId, sqlTypeOf } from "./values.ts";

/** What an `inHierarchy` node is being asked about. */
export interface HierarchyTarget {
	/** The column holding the child's id — the row's own id, or a reference column. */
	readonly column: ColumnMetadata;
	/** Entity type the ids in {@link column} belong to. */
	readonly entityType: string;
	/** Mappings to consult, most specific first. */
	readonly mappings: readonly (Readonly<Record<string, ResolvedHierarchyMapping>> | undefined)[];
	/** How to name the target in an error: `resource` or `resource.folder`. */
	readonly label: string;
	/** `true` when the target is an attribute rather than the row itself. */
	readonly viaAttribute: boolean;
	/** Resource type being compiled, for error context. */
	readonly resourceType: string;
}

/**
 * Compiles `<target> in Parent::"id"`.
 *
 * A mapping for `parent.type` is **required**, including when it equals the
 * target's own entity type. That looks pedantic — `Doc in Doc::"d3"` is obviously
 * `id = 'd3'` — right up until a vocabulary declares `Doc memberOf ['Doc']`, at
 * which point `id = 'd3'` silently stops finding the nested rows. Making the
 * author write `{ kind: 'self' }` is making them assert "this type does not nest
 * under itself", which is information the compiler has no other way to obtain.
 */
export function compileHierarchy(
	context: CompileContext,
	target: HierarchyTarget,
	parent: EntityRef<string>,
): string {
	const mapping = lookup(target, parent.type);
	// Bound once and referenced by name: TypeORM resolves a repeated `:name` to one
	// placeholder, so the reflexive disjunct and the subquery share a parameter.
	const parentId = bindEntityId(context.parameters, parent.id);
	const child = columnRef(context, target.column);

	switch (mapping.kind) {
		case "self": {
			if (parent.type !== target.entityType) {
				throw new PlanCompilationError(
					"invalid-mapping",
					`"${target.label}" holds ${target.entityType} ids, but its hierarchy mapping for ` +
						`"${parent.type}" is { kind: "self" }. A self mapping means "the parent type is this ` +
						`type"; for a different type use a column, closure or recursive mapping.`,
					{ resourceType: target.resourceType, parentType: parent.type },
				);
			}
			return `${child} = ${parentId}`;
		}

		case "column": {
			if (target.viaAttribute) {
				// The denormalised column describes the *row's* ancestry. Rooting it at an
				// attribute would answer a question about a different entity — sound only
				// by coincidence, on tables where every path to the ancestor happens to go
				// through that attribute.
				throw new UnmappedHierarchyError(
					`"${target.label} in ${parent.type}::…" cannot use the { kind: "column" } mapping ` +
						`declared for the row: a denormalised ancestor column describes the row, not the ` +
						`entity the attribute points at. Declare the mapping on the attribute itself ` +
						`(attributes["${attributeNameOf(target.label)}"].hierarchy["${parent.type}"]), or ` +
						`use a closure/recursive mapping, which are keyed by id and therefore answer for ` +
						`any seed.`,
					{ resourceType: target.resourceType, parentType: parent.type },
				);
			}
			return `${columnRef(context, mapping.column)} = ${parentId}`;
		}

		case "closure": {
			const alias = context.parameters.nextAlias();
			const table = tableRef(context, mapping.metadata);
			const descendant = aliasedColumnRef(context, alias, mapping.descendant);
			const ancestor = aliasedColumnRef(context, alias, mapping.ancestor);
			return (
				`(${child} = ${parentId} or exists (select 1 from ${table} ${context.escape(alias)} ` +
				`where ${descendant} = ${child} and ${ancestor} = ${parentId}))`
			);
		}

		case "recursive": {
			// Walks *down* from the constant parent rather than up from the row. Both
			// directions describe the same relation, but only this one keeps the
			// recursive CTE free of outer references: Postgres allows the sub-SELECT of
			// an EXISTS to reference the outer query, and does not allow a WITH inside
			// it to do the same. The single outer reference lives in the final SELECT,
			// where it is legal.
			const cte = context.escape(context.parameters.nextAlias());
			const walk = context.parameters.nextAlias();
			const node = `${cte}.${context.escape("node")}`;
			const idType = sqlTypeOf(context.mapping.dataSource, mapping.idColumn);
			const table = tableRef(context, mapping.metadata);
			const walkId = aliasedColumnRef(context, walk, mapping.idColumn);
			const walkParent = aliasedColumnRef(context, walk, mapping.parentColumn);

			// `UNION`, not `UNION ALL`: a cycle in the parent pointers would otherwise
			// recurse forever, and a cycle is a data bug, not a reason to hang.
			return (
				`(${child} = ${parentId} or exists (` +
				`with recursive ${cte}(${context.escape("node")}) as (` +
				`select ${parentId}::${idType} ` +
				`union ` +
				`select ${walkId} from ${table} ${context.escape(walk)} join ${cte} on ${walkParent} = ${node}` +
				`) select 1 from ${cte} where ${node} = ${child}))`
			);
		}
	}
}

/** Finds the mapping for `parentType`, or explains precisely what is missing. */
function lookup(target: HierarchyTarget, parentType: string): ResolvedHierarchyMapping {
	for (const [index, candidate] of target.mappings.entries()) {
		const found = candidate?.[parentType];
		if (found === undefined) {
			continue;
		}
		// The fallback level (index > 0) is the resource's own hierarchy. Only the
		// id-keyed strategies are meaningful there for an attribute-rooted question;
		// `self`/`column` describe the row and are rejected in `compileHierarchy`.
		if (
			index > 0 &&
			target.viaAttribute &&
			found.kind !== "closure" &&
			found.kind !== "recursive"
		) {
			continue;
		}
		return found;
	}

	throw new UnmappedHierarchyError(
		`The plan filters on "${target.label} in ${parentType}::…" and the mapping for ` +
			`"${target.resourceType}" declares no hierarchy strategy for "${parentType}". ` +
			`Add one — { kind: "self" } if ${parentType} is ${target.entityType} and never nests, ` +
			`{ kind: "column" } for a denormalised ancestor id, or a closure/recursive mapping. ` +
			`This is not degraded to TRUE: an unanswerable hierarchy question means the driver ` +
			`does not know which rows the grant covers, and guessing "all of them" is the leak ` +
			`this error exists to prevent.`,
		{ resourceType: target.resourceType, parentType },
	);
}

/** `resource.folder` → `folder`, for the "declare it here" half of an error message. */
function attributeNameOf(label: string): string {
	const dot = label.indexOf(".");
	return dot === -1 ? label : label.slice(dot + 1);
}
