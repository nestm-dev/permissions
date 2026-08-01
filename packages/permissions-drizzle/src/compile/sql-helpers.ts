// Boolean combinators that cannot produce "nothing".
//
// drizzle's `and()`/`or()` are typed `SQL | undefined` and return `undefined`
// for an empty list. That is a perfectly reasonable API for hand-written
// queries, and a trap for a compiler: `undefined` reaching `.where()` is not a
// type error and not a runtime error — it is a `WHERE` clause that was never
// emitted, which selects every row in the table. For an authorization filter
// that is the whole vulnerability in one missing character.
//
// So this package never calls them. `allOf([])` is `true` and `anyOf([])` is
// `false` — the identities of the respective operations, and the two answers
// that make an empty permit set deny and an empty forbid set permit, which is
// also what core's `simplifyPlanNode` folds them to.

import { sql, type SQL } from "drizzle-orm";

/** `TRUE`. Matches every row. */
export function sqlTrue(): SQL {
	return sql`true`;
}

/** `FALSE`. Matches no row. */
export function sqlFalse(): SQL {
	return sql`false`;
}

/**
 * Conjunction. **Empty ⇒ `true`.**
 *
 * Parenthesised whenever there is more than one part, so the result can be
 * dropped into any position without depending on operator precedence.
 */
export function allOf(parts: readonly SQL[]): SQL {
	if (parts.length === 0) {
		return sqlTrue();
	}
	if (parts.length === 1) {
		return parts[0] as SQL;
	}
	return sql`(${sql.join([...parts], sql` and `)})`;
}

/** Disjunction. **Empty ⇒ `false`.** */
export function anyOf(parts: readonly SQL[]): SQL {
	if (parts.length === 0) {
		return sqlFalse();
	}
	if (parts.length === 1) {
		return parts[0] as SQL;
	}
	return sql`(${sql.join([...parts], sql` or `)})`;
}

/**
 * Negation.
 *
 * Always parenthesised. `NOT` binds looser than every comparison in Postgres, so
 * the parentheses are not strictly required today — but they are the difference
 * between a correct expression and one that depends on a precedence table when
 * someone later composes it with `IS NULL` or `BETWEEN`.
 *
 * Note what is *not* here: no `COALESCE(…, false)` and no `IS NOT TRUE`. SQL's
 * `NOT NULL` is `NULL`, which drops the row, and that is exactly right — a
 * forbid that could not be evaluated must not stop being a forbid. Making the
 * negation two-valued would turn "this row's column is NULL" into "the forbid
 * does not apply".
 */
export function negate(part: SQL): SQL {
	return sql`(not ${part})`;
}
