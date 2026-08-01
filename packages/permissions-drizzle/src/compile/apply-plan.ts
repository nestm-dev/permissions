// `applyPlan` — sugar over `planToSql`.
//
// Sugar, and nothing more: it exists so the common call site reads as one line
// and so `planToSql` stays the primitive that everything is tested against. It
// deliberately does *not* try to merge with an existing `WHERE` — drizzle's
// `.where()` replaces rather than appends, and a helper that silently discarded a
// tenant filter would be a spectacular way to leak rows. Compose explicitly:
//
// ```ts
// db.select().from(projects).where(sql`(${eq(projects.orgId, orgId)} and ${planToSql(plan, m)})`)
// ```

import type { QueryPlan } from "@nestm/permissions-core/plan";
import type { SQL } from "drizzle-orm";

import type { DrizzleResourceMapping, PlanCompileOptions } from "./mapping.ts";
import { planToSql } from "./plan-to-sql.ts";

/**
 * Anything with a `.where()` — `PgSelectBase`, `PgUpdateBase`, `PgDeleteBase`.
 *
 * Structural rather than the concrete drizzle classes because those carry six
 * type parameters that a caller would have to spell out at the call site to no
 * benefit.
 */
export interface PlanFilterable {
	where(condition: SQL): unknown;
}

/** What `.where()` gave back — the builder, so the call chain continues. */
export type PlanFiltered<Q extends PlanFilterable> = Q extends {
	where(condition: SQL): infer R;
}
	? R
	: never;

/**
 * Applies a compiled plan as the query's `WHERE` clause.
 *
 * ```ts
 * const rows = await applyPlan(db.select().from(runs), plan, runResourceMapping);
 * ```
 *
 * Every guarantee of {@link planToSql} holds: `ALWAYS_ALLOW` becomes `WHERE true`
 * rather than no clause at all, `ALWAYS_DENY` becomes `WHERE false`, and an
 * uncompilable node throws before the query is touched.
 *
 * **This replaces any `WHERE` already on the builder.** That is drizzle's
 * semantics for `.where()`, not something this function could soften; combine
 * conditions yourself before calling it.
 */
export function applyPlan<Q extends PlanFilterable, R extends string>(
	query: Q,
	plan: QueryPlan<R>,
	mapping: DrizzleResourceMapping<R>,
	options: PlanCompileOptions = {},
): PlanFiltered<Q> {
	return query.where(planToSql(plan, mapping, options)) as PlanFiltered<Q>;
}
