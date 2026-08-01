// What every compile step is handed.
//
// Three things, and each of them is a defence:
//
//   * `escape` — the driver's own identifier quoter (`"` doubled, per
//     `PostgresDriver.escape`). Every identifier in the emitted text goes through
//     it, and every identifier comes from `EntityMetadata`, never from a string a
//     caller passed. That is the whole injection story for the SQL *text*; values
//     are a separate story and are always bound.
//   * `alias` — the query builder's main alias, read at build time. Unqualified
//     column names would be ambiguous the moment a hierarchy `EXISTS` subquery
//     joins another table with a column of the same name, and "ambiguous" in
//     Postgres is an error, not a wrong answer — but only until the day the two
//     tables' columns differ, at which point it silently resolves to the wrong one.
//   * `parameters` — the collision-proof name generator (see parameters.ts).
//
// Note that emitted identifiers are always **quoted**. That matters beyond
// aesthetics: TypeORM runs `replacePropertyNamesForTheWholeQuery` over the
// finished SQL, rewriting bare `alias.propertyName` tokens into database names.
// A quoted `"d"."title"` does not match its pattern and passes through untouched,
// which is exactly what a compiler that already resolved its own names wants.

import type { ColumnMetadata } from "typeorm/metadata/ColumnMetadata.js";
import type { EntityMetadata } from "typeorm";

import type { TypeOrmResourceMapping } from "./mapping.ts";
import type { ParameterBag } from "./parameters.ts";

/** Everything the node compilers need that is not the node itself. */
export interface CompileContext {
	/** The resolved mapping being compiled against. */
	readonly mapping: TypeOrmResourceMapping;
	/** Parameter namespace for this one expression. */
	readonly parameters: ParameterBag;
	/** Main table alias, or `undefined` to emit unqualified column names. */
	readonly alias: string | undefined;
	/** The driver's identifier quoter. */
	readonly escape: (name: string) => string;
}

/** `"alias"."column"`, or `"column"` when the query has no alias to prefix with. */
export function columnRef(context: CompileContext, column: ColumnMetadata): string {
	return qualify(context, context.alias, column);
}

/** `"someAlias"."column"` — for a table this compiler introduced in a subquery. */
export function aliasedColumnRef(
	context: CompileContext,
	alias: string,
	column: ColumnMetadata,
): string {
	return qualify(context, alias, column);
}

/** The escaped, schema-qualified table name of an entity. */
export function tableRef(context: CompileContext, metadata: EntityMetadata): string {
	return metadata.schema === undefined
		? context.escape(metadata.tableName)
		: `${context.escape(metadata.schema)}.${context.escape(metadata.tableName)}`;
}

function qualify(
	context: CompileContext,
	alias: string | undefined,
	column: ColumnMetadata,
): string {
	const name = context.escape(column.databaseName);
	return alias === undefined ? name : `${context.escape(alias)}.${name}`;
}
