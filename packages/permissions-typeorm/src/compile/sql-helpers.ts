// Boolean combinators that cannot produce "nothing".
//
// The hazard drizzle has is `and()`/`or()` returning `SQL | undefined`. TypeORM's
// is the same shape wearing different clothes: `qb.where("")` and
// `qb.andWhere(new Brackets(() => {}))` are both accepted, and both emit a query
// with no restriction from that term. For an authorization filter that is the
// whole vulnerability in one empty string.
//
// So every function here returns a non-empty expression. `allOf([])` is `1 = 1`
// and `anyOf([])` is `1 = 0` — the identities of the respective operations, and
// the two answers that make an empty permit set deny and an empty forbid set
// permit, which is also what core's `simplifyPlanNode` folds them to.
//
// `1 = 1` / `1 = 0` rather than `true` / `false` because that is what the design
// pins for this driver, and because they are the one spelling every dialect
// TypeORM targets agrees on — a `WHERE true` is a syntax error in Oracle and in
// SQL Server. Postgres plans them identically.

/** `TRUE`. Matches every row. */
export function sqlTrue(): string {
	return "1 = 1";
}

/** `FALSE`. Matches no row. */
export function sqlFalse(): string {
	return "1 = 0";
}

/**
 * Conjunction. **Empty ⇒ `1 = 1`.**
 *
 * Parenthesised whenever there is more than one part, so the result can be
 * dropped into any position without depending on operator precedence.
 */
export function allOf(parts: readonly string[]): string {
	if (parts.length === 0) {
		return sqlTrue();
	}
	if (parts.length === 1) {
		return parts[0] as string;
	}
	return `(${parts.join(" and ")})`;
}

/** Disjunction. **Empty ⇒ `1 = 0`.** */
export function anyOf(parts: readonly string[]): string {
	if (parts.length === 0) {
		return sqlFalse();
	}
	if (parts.length === 1) {
		return parts[0] as string;
	}
	return `(${parts.join(" or ")})`;
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
export function negate(part: string): string {
	return `(not ${part})`;
}
