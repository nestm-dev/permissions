// The mapping DSL: how a Cedar resource type binds to a TypeORM entity.
//
// A mapping is a *claim*, and every claim it makes is checked before any SQL is
// produced. `{ kind: 'scalar', valueKind: 'string' }` says "this column holds
// exactly the strings Cedar compares against this attribute" — so an ordering
// comparison over it is refused (Cedar has no string ordering; SQL happily
// invents one under the column's collation), and a `contains` over it is refused
// (a scalar is not a set). There is no `kind: 'unknown'` and no fallback: an
// attribute the mapping does not describe cannot be filtered, and the only sound
// answer to "filter by something I cannot express" is to refuse the query.
//
// ## Why property paths, and why they are resolved eagerly
//
// The Drizzle driver's mapping holds `PgColumn` objects, which carry their own
// name. TypeORM has no such value: a consumer holds an `EntitySchema` or a class,
// and a column is named by a **property path** string. So the mapping is written
// with strings and `createTypeOrmResourceMapping` resolves every one of them
// through `EntityMetadata.findColumnWithPropertyPathStrict` — the same lookup
// `@ucast/sql/typeorm` performs, studied and not depended upon (its AST has no
// tokenised `LIKE`, no `inHierarchy` and no three-state plan).
//
// Resolving eagerly is the whole point. A typo in `"publishedAt"` becomes a
// thrown `UnmappedAttributeError` when the mapping is built — at module load, or
// at worst at the first request — rather than a `column "publishedat" does not
// exist` from Postgres, or, far worse, a silently unfiltered query. And the
// emitted identifier is `qb.escape(column.databaseName)`, which comes from the
// metadata: **no string a caller supplied ever reaches the SQL text**.

import type { ColumnMetadata } from "typeorm/metadata/ColumnMetadata.js";
import type { DataSource, EntityMetadata, EntityTarget, ObjectLiteral } from "typeorm";

import { PlanCompilationError, UnmappedAttributeError } from "../errors.ts";

/**
 * Value kinds a single column can hold.
 *
 * `set` and `entity` are absent on purpose: a set is an `array` mapping and an
 * entity reference is an `entity` mapping, both of which carry extra information
 * the compiler needs (the element kind, the referenced type).
 */
export type TypeOrmScalarKind =
	"string" | "long" | "bool" | "datetime" | "duration" | "decimal" | "ipaddr";

/**
 * How `resource in Parent::"p"` is answered for one parent entity type, before
 * resolution.
 *
 * - `self` — the parent type *is* the resource type. Cedar's `in` is
 *   descendant-**or-self**, so this compiles to `id = $p`, not to an ancestor
 *   lookup. Getting that wrong is a silent over-block on the one query a
 *   role-grant system cares about.
 * - `column` — a denormalised ancestor id on the row itself.
 * - `closure` — a transitive-closure entity. Ids must be unique across entity
 *   types, since the table carries no type column.
 * - `recursive` — a self-referencing parent pointer, walked with `WITH
 *   RECURSIVE`. Same id-uniqueness requirement.
 *
 * `closure` and `recursive` name their own `entity`, because a property path is
 * meaningless without one — unlike drizzle, where the column object knows its
 * table.
 */
export type TypeOrmHierarchyMapping =
	| { readonly kind: "self" }
	| { readonly kind: "column"; readonly column: string }
	| {
			readonly kind: "closure";
			readonly entity: EntityTarget<ObjectLiteral>;
			readonly ancestor: string;
			readonly descendant: string;
	  }
	| {
			readonly kind: "recursive";
			readonly entity: EntityTarget<ObjectLiteral>;
			readonly parentColumn: string;
			readonly idColumn: string;
	  };

/** How one Cedar attribute reaches a column, before resolution. */
export type TypeOrmAttributeMapping =
	/** A plain column of the given kind. */
	| { readonly kind: "scalar"; readonly column: string; readonly valueKind: TypeOrmScalarKind }
	/**
	 * A column holding the **id** of an entity of `entityType`.
	 *
	 * `hierarchy` answers `resource.<attr> in Parent::"p"` for parent types other
	 * than `entityType` itself. The self case (`parent.type === entityType`) still
	 * needs a `{ kind: "self" }` entry: writing it is asserting "this type does not
	 * nest under itself", which the compiler has no other way to learn.
	 */
	| {
			readonly kind: "entity";
			readonly column: string;
			readonly entityType: string;
			readonly hierarchy?: Readonly<Record<string, TypeOrmHierarchyMapping>>;
	  }
	/** A Postgres array column standing for a Cedar set. */
	| { readonly kind: "array"; readonly column: string; readonly elementKind: TypeOrmScalarKind }
	/** A path inside a `json`/`jsonb` column. */
	| {
			readonly kind: "jsonPath";
			readonly column: string;
			readonly path: readonly string[];
			readonly valueKind: TypeOrmScalarKind;
	  };

/** Text-matching options for the mapped entity. */
export interface TypeOrmTextOptions {
	/**
	 * Escape character declared to `LIKE … ESCAPE`. Default `'\'`.
	 *
	 * Bound as a parameter, never inlined, so the choice is free of quoting
	 * concerns. It must not be `%` or `_`; core's `likeTokensToPattern` enforces
	 * that.
	 */
	readonly escapeChar?: string;
	/**
	 * Collation the text columns sit under. Default `'exact'`.
	 *
	 * `'case-insensitive'` (a `citext` column, or an ICU non-deterministic
	 * collation) makes SQL `LIKE` case-insensitive while Cedar's `like` is
	 * case-sensitive — a silent over-match. Declaring it makes `like` a hard
	 * compile error instead of a leak.
	 */
	readonly collation?: "exact" | "case-insensitive";
}

/** Binds one Cedar resource type to one entity. Property paths, not columns. */
export interface TypeOrmResourceMappingDefinition<R extends string = string> {
	/** Vocabulary-local resource type, unqualified — must equal `plan.resourceType`. */
	readonly resourceType: R;
	/** The entity rows are selected from: an `EntitySchema`, a class, or an entity name. */
	readonly entity: EntityTarget<ObjectLiteral>;
	/** Property path of the column holding the row's Cedar entity id. */
	readonly id: string;
	/** Attribute name → column. Depth 1; a compiled plan never reads deeper. */
	readonly attributes: Readonly<Record<string, TypeOrmAttributeMapping>>;
	/** Parent entity type → how to answer `resource in <that type>::"p"`. */
	readonly hierarchy?: Readonly<Record<string, TypeOrmHierarchyMapping>>;
	/** Text-matching options. */
	readonly text?: TypeOrmTextOptions;
}

// ---------------------------------------------------------------------------
// Resolved shapes
// ---------------------------------------------------------------------------

/** A {@link TypeOrmHierarchyMapping} with every property path resolved. */
export type ResolvedHierarchyMapping =
	| { readonly kind: "self" }
	| { readonly kind: "column"; readonly column: ColumnMetadata }
	| {
			readonly kind: "closure";
			readonly metadata: EntityMetadata;
			readonly ancestor: ColumnMetadata;
			readonly descendant: ColumnMetadata;
	  }
	| {
			readonly kind: "recursive";
			readonly metadata: EntityMetadata;
			readonly parentColumn: ColumnMetadata;
			readonly idColumn: ColumnMetadata;
	  };

/** A {@link TypeOrmAttributeMapping} with every property path resolved. */
export type ResolvedAttributeMapping =
	| {
			readonly kind: "scalar";
			readonly column: ColumnMetadata;
			readonly valueKind: TypeOrmScalarKind;
	  }
	| {
			readonly kind: "entity";
			readonly column: ColumnMetadata;
			readonly entityType: string;
			readonly hierarchy?: Readonly<Record<string, ResolvedHierarchyMapping>>;
	  }
	| {
			readonly kind: "array";
			readonly column: ColumnMetadata;
			readonly elementKind: TypeOrmScalarKind;
	  }
	| {
			readonly kind: "jsonPath";
			readonly column: ColumnMetadata;
			readonly path: readonly string[];
			readonly valueKind: TypeOrmScalarKind;
	  };

/**
 * A resolved mapping — what `planToBrackets` and `applyPlan` take.
 *
 * Produced by {@link createTypeOrmResourceMapping}. Every `ColumnMetadata` in it
 * came from the `DataSource`, which is what makes the emitted SQL free of
 * caller-supplied identifiers.
 */
export interface TypeOrmResourceMapping<R extends string = string> {
	/** Vocabulary-local resource type, unqualified — must equal `plan.resourceType`. */
	readonly resourceType: R;
	/** The `DataSource` the metadata came from; also the source of the escaper. */
	readonly dataSource: DataSource;
	/** Metadata of the entity rows are selected from. */
	readonly metadata: EntityMetadata;
	/** The column holding the row's Cedar entity id. */
	readonly id: ColumnMetadata;
	/** Attribute name → resolved column. */
	readonly attributes: Readonly<Record<string, ResolvedAttributeMapping>>;
	/** Parent entity type → resolved hierarchy strategy. */
	readonly hierarchy?: Readonly<Record<string, ResolvedHierarchyMapping>>;
	/** Text-matching options. */
	readonly text?: TypeOrmTextOptions;
}

/** Options accepted by `planToBrackets` / `applyPlan`. */
export interface PlanCompileOptions {
	/**
	 * Permits compiling a plan that carries a **permissive** approximation.
	 *
	 * A permissive approximation means the compiled filter selects a *superset* of
	 * the authorized rows. Compiling one without re-checking the result is a data
	 * leak, so this flag alone is not enough: the plan must also carry a
	 * `postFilter`, and the caller must run every returned row through it.
	 */
	readonly allowPermissiveApproximations?: boolean;
	/**
	 * Prefix for generated parameter names. Default {@link DEFAULT_PARAMETER_PREFIX}.
	 *
	 * TypeORM parameters are **query-builder-global**, not per-`Brackets`, so two
	 * compiled plans on one builder share a namespace. The counter is seeded from
	 * the builder's existing parameters, which makes collisions impossible without
	 * changing the prefix; the option exists for the caller who wants their own
	 * parameters to be visibly theirs.
	 */
	readonly parameterPrefix?: string;
	/**
	 * Table alias to qualify columns with.
	 *
	 * Defaults to the alias of the query builder the `Brackets` is applied to,
	 * read at build time — which is what a caller wants and never has to say.
	 * Override it only when composing a `Brackets` into a builder whose main alias
	 * is not the one the mapping's rows come from.
	 */
	readonly alias?: string;
}

/** Default `LIKE … ESCAPE` character. */
export const DEFAULT_ESCAPE_CHAR = "\\";

/** Default prefix for generated parameter names. */
export const DEFAULT_PARAMETER_PREFIX = "nestmp";

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/**
 * Resolves a mapping's property paths into `ColumnMetadata`, eagerly.
 *
 * ```ts
 * const runMapping = createTypeOrmResourceMapping(dataSource, {
 *   resourceType: "Run",
 *   entity: Run,
 *   id: "id",
 *   attributes: {
 *     status: { kind: "scalar", column: "status", valueKind: "string" },
 *     project: { kind: "entity", column: "projectId", entityType: "Project" },
 *   },
 *   hierarchy: {
 *     Run: { kind: "self" },
 *     Project: { kind: "column", column: "projectId" },
 *   },
 * });
 * ```
 *
 * Call it once, at startup, and reuse the result: it reads metadata and allocates
 * nothing per query.
 *
 * @throws {@link UnmappedAttributeError} for a property path the entity does not
 * have — with the entity's real property list in the message, because "did you
 * mean `publishedAt`?" is the only useful thing to say at that point.
 * @throws {@link PlanCompilationError} `invalid-mapping` when the entity itself
 * is unknown to the `DataSource` (usually: not registered, or the `DataSource` is
 * not initialised yet).
 */
export function createTypeOrmResourceMapping<R extends string>(
	dataSource: DataSource,
	definition: TypeOrmResourceMappingDefinition<R>,
): TypeOrmResourceMapping<R> {
	const metadata = metadataOf(dataSource, definition.entity, definition.resourceType);

	const attributes: Record<string, ResolvedAttributeMapping> = {};
	for (const [name, attribute] of Object.entries(definition.attributes)) {
		attributes[name] = resolveAttribute(
			dataSource,
			metadata,
			definition.resourceType,
			name,
			attribute,
		);
	}

	const mapping: {
		resourceType: R;
		dataSource: DataSource;
		metadata: EntityMetadata;
		id: ColumnMetadata;
		attributes: Readonly<Record<string, ResolvedAttributeMapping>>;
		hierarchy?: Readonly<Record<string, ResolvedHierarchyMapping>>;
		text?: TypeOrmTextOptions;
	} = {
		resourceType: definition.resourceType,
		dataSource,
		metadata,
		id: column(metadata, definition.id, definition.resourceType, "id"),
		attributes,
	};

	if (definition.hierarchy !== undefined) {
		mapping.hierarchy = resolveHierarchyMap(
			dataSource,
			metadata,
			definition.resourceType,
			"hierarchy",
			definition.hierarchy,
		);
	}
	if (definition.text !== undefined) {
		mapping.text = definition.text;
	}

	return mapping;
}

function resolveAttribute(
	dataSource: DataSource,
	metadata: EntityMetadata,
	resourceType: string,
	name: string,
	attribute: TypeOrmAttributeMapping,
): ResolvedAttributeMapping {
	const where = `attributes.${name}`;

	switch (attribute.kind) {
		case "scalar": {
			return {
				kind: "scalar",
				column: column(metadata, attribute.column, resourceType, where),
				valueKind: attribute.valueKind,
			};
		}
		case "array": {
			return {
				kind: "array",
				column: column(metadata, attribute.column, resourceType, where),
				elementKind: attribute.elementKind,
			};
		}
		case "jsonPath": {
			return {
				kind: "jsonPath",
				column: column(metadata, attribute.column, resourceType, where),
				path: [...attribute.path],
				valueKind: attribute.valueKind,
			};
		}
		case "entity": {
			const resolved: {
				kind: "entity";
				column: ColumnMetadata;
				entityType: string;
				hierarchy?: Readonly<Record<string, ResolvedHierarchyMapping>>;
			} = {
				kind: "entity",
				column: column(metadata, attribute.column, resourceType, where),
				entityType: attribute.entityType,
			};
			if (attribute.hierarchy !== undefined) {
				resolved.hierarchy = resolveHierarchyMap(
					dataSource,
					metadata,
					resourceType,
					`${where}.hierarchy`,
					attribute.hierarchy,
				);
			}
			return resolved;
		}
		default: {
			throw new PlanCompilationError(
				"invalid-mapping",
				`"${resourceType}.${name}" has an unrecognised mapping kind ` +
					`${JSON.stringify((attribute as { kind?: unknown }).kind)}.`,
				{ resourceType, attribute: name },
			);
		}
	}
}

function resolveHierarchyMap(
	dataSource: DataSource,
	metadata: EntityMetadata,
	resourceType: string,
	where: string,
	definitions: Readonly<Record<string, TypeOrmHierarchyMapping>>,
): Readonly<Record<string, ResolvedHierarchyMapping>> {
	const resolved: Record<string, ResolvedHierarchyMapping> = {};

	for (const [parentType, hierarchy] of Object.entries(definitions)) {
		const at = `${where}.${parentType}`;

		switch (hierarchy.kind) {
			case "self": {
				resolved[parentType] = { kind: "self" };
				break;
			}
			case "column": {
				resolved[parentType] = {
					kind: "column",
					column: column(metadata, hierarchy.column, resourceType, at),
				};
				break;
			}
			case "closure": {
				const closure = metadataOf(dataSource, hierarchy.entity, resourceType, at);
				resolved[parentType] = {
					kind: "closure",
					metadata: closure,
					ancestor: column(closure, hierarchy.ancestor, resourceType, `${at}.ancestor`),
					descendant: column(closure, hierarchy.descendant, resourceType, `${at}.descendant`),
				};
				break;
			}
			case "recursive": {
				const nodes = metadataOf(dataSource, hierarchy.entity, resourceType, at);
				resolved[parentType] = {
					kind: "recursive",
					metadata: nodes,
					parentColumn: column(nodes, hierarchy.parentColumn, resourceType, `${at}.parentColumn`),
					idColumn: column(nodes, hierarchy.idColumn, resourceType, `${at}.idColumn`),
				};
				break;
			}
			default: {
				throw new PlanCompilationError(
					"invalid-mapping",
					`"${resourceType}" declares an unrecognised hierarchy kind ` +
						`${JSON.stringify((hierarchy as { kind?: unknown }).kind)} at ${at}.`,
					{ resourceType, parentType },
				);
			}
		}
	}

	return resolved;
}

/**
 * `EntityMetadata.findColumnWithPropertyPathStrict` — the whole reason this
 * package resolves eagerly.
 *
 * "Strict" means it does *not* fall back to searching relations, which is the
 * behaviour we want: a relation would resolve to a join column whose name the
 * mapping author did not write, and quietly filtering on a different column than
 * the one named is exactly the class of bug this file exists to make impossible.
 */
function column(
	metadata: EntityMetadata,
	propertyPath: string,
	resourceType: string,
	where: string,
): ColumnMetadata {
	const found = metadata.findColumnWithPropertyPathStrict(propertyPath);
	if (found === undefined) {
		throw new UnmappedAttributeError(
			`The mapping for "${resourceType}" names the property path "${propertyPath}" at ` +
				`${where}, but the entity "${metadata.name}" has no such column. ` +
				`Known columns: ${describeColumns(metadata)}. ` +
				`Property paths are resolved when the mapping is built, precisely so a typo is ` +
				`this error rather than a query that filters on nothing.`,
			{ resourceType, attribute: propertyPath },
		);
	}
	return found;
}

function metadataOf(
	dataSource: DataSource,
	entity: EntityTarget<ObjectLiteral>,
	resourceType: string,
	where = "entity",
): EntityMetadata {
	try {
		return dataSource.getMetadata(entity);
	} catch (cause) {
		throw new PlanCompilationError(
			"invalid-mapping",
			`The mapping for "${resourceType}" names an entity at ${where} that this DataSource ` +
				`does not know. Register it in \`entities\`, and make sure the DataSource is ` +
				`initialised before building mappings.`,
			{ resourceType, cause },
		);
	}
}

function describeColumns(metadata: EntityMetadata): string {
	const names = metadata.columns.map((entry) => entry.propertyPath).toSorted();
	return names.length === 0 ? "(none)" : names.join(", ");
}
