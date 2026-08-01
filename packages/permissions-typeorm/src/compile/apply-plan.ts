// `applyPlan` — sugar over `planToBrackets`.
//
// Sugar, and nothing more: it exists so the common call site reads as one line
// and so `planToBrackets` stays the primitive that everything is tested against.
//
// One deliberate difference from the Drizzle driver's `applyPlan`, and it is an
// idiom difference rather than a semantic one: drizzle's `.where()` *replaces*
// any existing condition, so its helper documents that and leaves composition to
// the caller. TypeORM's `.andWhere()` *appends*, so this one appends — which is
// the safe direction. A tenant filter already on the builder survives:
//
// ```ts
// const rows = await applyPlan(
//   dataSource.createQueryBuilder(Run, "run").where("run.organizationId = :org", { org }),
//   plan,
//   runMapping,
// ).getMany();
// // WHERE run.organization_id = $1 AND ( <compiled> )
// ```
//
// Two `applyPlan` calls on one builder are also safe, and that is not an accident
// of TypeORM: the second compile seeds its parameter counter from the first's
// names (see parameters.ts). `tests/unit/parameter-collision.test.ts` pins it.

import type { QueryPlan } from "@nestm/permissions-core/plan";
import type { ObjectLiteral, SelectQueryBuilder, WhereExpressionBuilder } from "typeorm";

import type { PlanCompileOptions, TypeOrmResourceMapping } from "./mapping.ts";
import { planToBrackets } from "./plan-to-brackets.ts";

/**
 * Anything with `.andWhere()` — `SelectQueryBuilder`, `UpdateQueryBuilder`,
 * `DeleteQueryBuilder`, and the child builder inside a `Brackets` factory.
 *
 * Structural (TypeORM's own `WhereExpressionBuilder`) rather than the concrete
 * classes because those carry type parameters a caller would have to spell out at
 * the call site to no benefit.
 */
export type PlanFilterable = WhereExpressionBuilder;

/**
 * Applies a compiled plan as an additional `WHERE` term.
 *
 * ```ts
 * const rows = await applyPlan(dataSource.createQueryBuilder(Doc, "doc"), plan, docMapping).getMany();
 * ```
 *
 * Every guarantee of {@link planToBrackets} holds: `ALWAYS_ALLOW` becomes
 * `AND (1 = 1)` rather than no clause at all, `ALWAYS_DENY` becomes `AND (1 = 0)`,
 * and an uncompilable node throws **before** the builder is touched — the plan is
 * compiled eagerly, so a failed `applyPlan` leaves the query exactly as it was
 * rather than half-filtered.
 *
 * The column alias is taken from the builder's own main alias unless
 * `options.alias` says otherwise, so a builder created as
 * `createQueryBuilder(Doc, "doc")` yields `"doc"."status" = :nestmp_0`.
 */
export function applyPlan<Q extends PlanFilterable, R extends string>(
	query: Q,
	plan: QueryPlan<R>,
	mapping: TypeOrmResourceMapping<R>,
	options: PlanCompileOptions = {},
): Q {
	// Built before `andWhere` is called: `planToBrackets` does its eager compile
	// pass here, so a mapping error cannot leave a half-modified builder behind.
	const brackets = planToBrackets(plan, mapping, options);
	query.andWhere(brackets);
	return query;
}

/**
 * {@link applyPlan}, narrowed to a `SelectQueryBuilder` so the entity type flows
 * through to `.getMany()`.
 *
 * The general form loses it: `WhereExpressionBuilder` says nothing about what the
 * builder selects.
 */
export function applyPlanToSelect<Entity extends ObjectLiteral, R extends string>(
	query: SelectQueryBuilder<Entity>,
	plan: QueryPlan<R>,
	mapping: TypeOrmResourceMapping<R>,
	options: PlanCompileOptions = {},
): SelectQueryBuilder<Entity> {
	return applyPlan(query, plan, mapping, options);
}
