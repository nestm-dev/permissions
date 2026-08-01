// Binding a `PlanValue` into a parameter.
//
// Every value in a compiled filter is a bind parameter. There is no path in this
// file that concatenates a value into SQL text, which is why the injection corpus
// is a round-trip test rather than an escaping test: a `'` in a policy is a `'`
// in the database, because it never touches the statement.
//
// The casts are the interesting part. Three of them are load-bearing:
//
//   * **`long` binds as text with an explicit `::bigint`.** `PlanValue.long` is a
//     `bigint`, which neither `JSON.stringify` nor node-postgres will serialise;
//     `Number(value)` would silently round past 2^53. `value.toString()` is exact
//     and the cast tells Postgres what the text means in the positions where no
//     column is there to infer it from (inside `ARRAY[…]`, inside a `UNION`).
//   * **`datetime` binds as an ISO-8601 string with `::timestamptz`.** A `Date`
//     handed to a driver is rendered in whatever timezone the driver feels like;
//     ISO-8601 with an explicit `Z` and an explicit cast is unambiguous.
//   * **`decimal` and `ipaddr` bind as their Cedar literal text** with `::numeric`
//     and `::inet`. Neither has a lossless JavaScript representation — that is
//     exactly why core carries them as text — and both Postgres types compare the
//     way Cedar does: `numeric` is exact decimal (`1.5 = 1.50`), and `inet`
//     equality compares the address *and* the prefix length, which is Cedar's
//     rule and neither text equality nor network containment.
//
// `string`, `bool` and entity ids bind **without** a cast: an explicit `::text`
// would break the moment the column is a `citext`, an enum or a `uuid`, and
// Postgres resolves an unknown-typed parameter from the column it is compared
// against anyway.

import { planValueKindOf, type PlanValue } from "@nestm/permissions-core/plan";
import { sql, type SQL } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";

import { PlanCompilationError } from "../errors.ts";
import type { DrizzleScalarKind } from "./mapping.ts";

/** Where a value is being bound, for error messages. */
export interface BindContext {
	readonly resourceType: string;
	readonly attribute: string;
}

/**
 * Binds one scalar `PlanValue` against a column of the declared kind.
 *
 * @throws {@link PlanCompilationError} `value-kind-mismatch` when the plan's kind
 * is not the kind the mapping declares. That mismatch can only come from a
 * mapping that does not describe the column it points at, and guessing which side
 * is right is how a `long` ends up compared as text.
 */
export function bindScalar(
	value: PlanValue,
	expected: DrizzleScalarKind,
	context: BindContext,
): SQL {
	const kind = planValueKindOf(value);

	if (kind !== expected) {
		throw new PlanCompilationError(
			"value-kind-mismatch",
			`"${context.resourceType}.${context.attribute}" is mapped as ${expected}, but the plan ` +
				`compares it against a ${kind}. The mapping and the vocabulary disagree about this ` +
				`column; one of them is wrong and the compiler cannot tell which.`,
			{ resourceType: context.resourceType, attribute: context.attribute },
		);
	}

	switch (value.kind) {
		case "string": {
			return sql`${value.value}`;
		}
		case "bool": {
			return sql`${value.value}`;
		}
		case "long": {
			return sql`${value.value.toString()}::bigint`;
		}
		case "duration": {
			// Cedar durations are signed millisecond counts; a driver stores them as a
			// plain integer, so the same binding as `long`.
			return sql`${String(value.value)}::bigint`;
		}
		case "datetime": {
			return sql`${value.value.toISOString()}::timestamptz`;
		}
		case "decimal": {
			return sql`${value.value}::numeric`;
		}
		case "ipaddr": {
			return sql`${value.value}::inet`;
		}
		default: {
			// `entity` and `set` are handled by their own mapping kinds; reaching here
			// means the kind check above let something through, which cannot happen.
			throw new PlanCompilationError(
				"value-kind-mismatch",
				`"${context.resourceType}.${context.attribute}" received a ${kind} value, which is not ` +
					`a scalar. Use an "entity" or "array" attribute mapping for those.`,
				{ resourceType: context.resourceType, attribute: context.attribute },
			);
		}
	}
}

/**
 * Binds an entity reference's **id** — untyped, so the column's own type resolves
 * it (`uuid`, `text`, a domain).
 *
 * The entity *type* is checked by the caller against the mapping's declared
 * `entityType`; it is never bound, because the column carries ids and nothing
 * else.
 */
export function bindEntityId(id: string): SQL {
	return sql`${id}`;
}

/**
 * The column's SQL type, validated.
 *
 * Used to cast a constructed `ARRAY[…]` to exactly the column's array type, so
 * containment compares like with like whether the column is `text[]`, `bigint[]`
 * or an enum array. It comes from drizzle's own column definition — the same
 * trust level as the column *name*, which is also interpolated — but it is
 * validated anyway, because a `customType` can return an arbitrary string and
 * "the schema is trusted" is exactly the assumption worth not making.
 */
const SQL_TYPE = /^[A-Za-z_][A-Za-z0-9_ ]*(\(\s*\d+(\s*,\s*\d+)?\s*\))?(\[\])*$/;

export function sqlTypeOf(column: PgColumn): SQL {
	const type = column.getSQLType();
	if (!SQL_TYPE.test(type)) {
		throw new PlanCompilationError(
			"invalid-mapping",
			`The column "${column.name}" reports the SQL type ${JSON.stringify(type)}, which is not a ` +
				`plain type name. The compiler interpolates it into an explicit cast and will not ` +
				`interpolate something it cannot recognise.`,
		);
	}
	return sql.raw(type);
}
