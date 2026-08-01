// The mapping DSL: how a Cedar resource type binds to a Postgres table.
//
// A mapping is a *claim*, and every claim it makes is checked before any SQL is
// produced. `{ kind: 'scalar', valueKind: 'string' }` says "this column holds
// exactly the strings Cedar compares against this attribute" — so an ordering
// comparison over it is refused (Cedar has no string ordering; SQL happily
// invents one under the column's collation), and a `contains` over it is refused
// (a scalar is not a set). There is no `kind: 'unknown'` and no fallback: an
// attribute the mapping does not describe cannot be filtered, and the only sound
// answer to "filter by something I cannot express" is to refuse the query.

import type { PgColumn, PgTable } from "drizzle-orm/pg-core";

/**
 * Value kinds a single column can hold.
 *
 * `set` and `entity` are absent on purpose: a set is an `array` mapping and an
 * entity reference is an `entity` mapping, both of which carry extra information
 * the compiler needs (the element kind, the referenced type).
 */
export type DrizzleScalarKind =
	"string" | "long" | "bool" | "datetime" | "duration" | "decimal" | "ipaddr";

/** How one Cedar attribute reaches a column. */
export type DrizzleAttributeMapping =
	/** A plain column of the given kind. */
	| { readonly kind: "scalar"; readonly column: PgColumn; readonly valueKind: DrizzleScalarKind }
	/**
	 * A column holding the **id** of an entity of `entityType`.
	 *
	 * `hierarchy` answers `resource.<attr> in Parent::"p"` for parent types other
	 * than `entityType` itself. The self case (`parent.type === entityType`) needs
	 * no mapping at all: Cedar's `in` is reflexive, so it compiles to
	 * `column = $parentId`.
	 */
	| {
			readonly kind: "entity";
			readonly column: PgColumn;
			readonly entityType: string;
			readonly hierarchy?: Readonly<Record<string, DrizzleHierarchyMapping>>;
	  }
	/** A Postgres array column standing for a Cedar set. */
	| { readonly kind: "array"; readonly column: PgColumn; readonly elementKind: DrizzleScalarKind }
	/** A path inside a `json`/`jsonb` column. */
	| {
			readonly kind: "jsonPath";
			readonly column: PgColumn;
			readonly path: readonly string[];
			readonly valueKind: DrizzleScalarKind;
	  };

/**
 * How `resource in Parent::"p"` is answered for one parent entity type.
 *
 * - `self` — the parent type *is* the resource type. Cedar's `in` is
 *   descendant-**or-self**, so this compiles to `id = $p`, not to an ancestor
 *   lookup. Getting that wrong is a silent over-block on the one query a
 *   role-grant system cares about.
 * - `column` — a denormalised ancestor id on the row itself.
 * - `closure` — a transitive-closure table. Ids must be unique across entity
 *   types, since the table carries no type column.
 * - `recursive` — a self-referencing parent pointer, walked with `WITH
 *   RECURSIVE`. Same id-uniqueness requirement.
 */
export type DrizzleHierarchyMapping =
	| { readonly kind: "self" }
	| { readonly kind: "column"; readonly column: PgColumn }
	| {
			readonly kind: "closure";
			readonly table: PgTable;
			readonly ancestor: PgColumn;
			readonly descendant: PgColumn;
	  }
	| { readonly kind: "recursive"; readonly parentColumn: PgColumn; readonly idColumn: PgColumn };

/** Text-matching options for the mapped table. */
export interface DrizzleTextOptions {
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

/** Binds one Cedar resource type to one table. */
export interface DrizzleResourceMapping<R extends string = string> {
	/** Vocabulary-local resource type, unqualified — must equal `plan.resourceType`. */
	readonly resourceType: R;
	/** The table rows are selected from. */
	readonly table: PgTable;
	/** The column holding the row's Cedar entity id. */
	readonly id: PgColumn;
	/** Attribute name → column. Depth 1; a compiled plan never reads deeper. */
	readonly attributes: Readonly<Record<string, DrizzleAttributeMapping>>;
	/** Parent entity type → how to answer `resource in <that type>::"p"`. */
	readonly hierarchy?: Readonly<Record<string, DrizzleHierarchyMapping>>;
	/** Text-matching options. */
	readonly text?: DrizzleTextOptions;
}

/** Options accepted by `planToSql` / `applyPlan`. */
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
}

/** Default `LIKE … ESCAPE` character. */
export const DEFAULT_ESCAPE_CHAR = "\\";
