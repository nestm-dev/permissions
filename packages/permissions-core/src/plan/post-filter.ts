// The post-filter escape hatch (core.md §5.5).
//
// When `unsupportedResidual` resolves to `'post-filter'`, the permits are
// widened to `true` and the plan carries this function. It is *correct* — every
// row goes back through Cedar — and it is `O(n)`, it breaks database-side
// pagination, and it turns one query into one query plus `n` authorizations.
// The README says it plainly: a migration aid, not a steady state.
//
// The cap is not a tuning knob, it is a circuit breaker. Without it, a caller
// who forgot to paginate hands 200 000 rows to a 0.136 ms/check loop and takes
// the process down; failing loudly at 500 is strictly better than that.
//
// The plan's only reference back to the engine is the `check` callback injected
// here. Nothing else on a `QueryPlan` closes over the engine, so a plan stays
// structurally cloneable once its functions are stripped.

import type { EntityRef } from "../cedar/uid.ts";
import { PostFilterOverflowError } from "../diagnostics/errors.ts";
import { fail } from "../util/assert.ts";
import type { PostFilter, PostFilterOptions } from "./plan.ts";

/** Default cap on rows one `postFilter` call will re-check. */
export const DEFAULT_MAX_POST_FILTER_ROWS = 500;

/** Batched authorization callback the engine injects. One answer per reference, in order. */
export type PostFilterCheck = (
	resources: readonly EntityRef<string>[],
) => Promise<readonly boolean[]>;

/** Construction options for {@link createPostFilter}. */
export interface CreatePostFilterOptions {
	/** Runs the batch. Supplied by the engine, bound to the planned request. */
	readonly check: PostFilterCheck;
	/** Cap on rows per call. */
	readonly maxRows: number;
	/** Resource type the plan is for; every mapped row must match it. */
	readonly resourceType: string;
	/** Action being planned for. Diagnostics only. */
	readonly action: string;
	/** Scope being planned in. Diagnostics only. */
	readonly scope: string;
}

/**
 * Builds the `postFilter` attached to a widened `CONDITIONAL` plan.
 *
 * ```ts
 * const rows = await db.select().from(runs).where(planToSql(plan, mapping)).limit(200);
 * const visible = plan.postFilter
 *   ? await plan.postFilter(rows, { rowToResource: (row) => ({ type: "Run", id: row.id }) })
 *   : rows;
 * ```
 *
 * Order is preserved and rows are dropped, never reordered or mutated.
 */
export function createPostFilter(options: CreatePostFilterOptions): PostFilter {
	return async function postFilter<Row>(
		rows: readonly Row[],
		filterOptions: PostFilterOptions<Row>,
	): Promise<Row[]> {
		const maxRows = filterOptions.maxRows ?? options.maxRows;

		if (rows.length > maxRows) {
			throw new PostFilterOverflowError(
				`This query plan for "${options.action}" over ${options.resourceType} in scope ` +
					`"${options.scope}" is only sound with a post-filter, which re-checks every row ` +
					`through Cedar. ${String(rows.length)} rows were passed and the cap is ` +
					`${String(maxRows)}. Paginate before filtering, raise maxPostFilterRows if you have ` +
					`measured the cost, or rewrite the policy so the plan does not need a post-filter.`,
				{ rows: rows.length, maxRows, scope: options.scope },
			);
		}

		if (rows.length === 0) {
			return [];
		}

		const resources = rows.map((row, index) => {
			const reference = filterOptions.rowToResource(row, index);

			if (
				typeof reference !== "object" ||
				reference === null ||
				typeof reference.id !== "string" ||
				typeof reference.type !== "string"
			) {
				fail(
					"ENTITY_RESOLUTION",
					`postFilter's rowToResource must return an EntityRef; row ${String(index)} produced ` +
						`${JSON.stringify(reference)}.`,
					{ scope: options.scope },
				);
			}
			if (reference.type !== options.resourceType) {
				// A mismatched type would ask Cedar about a different entity entirely,
				// and the answer would look perfectly plausible.
				fail(
					"ENTITY_RESOLUTION",
					`postFilter's rowToResource returned a "${reference.type}" for row ${String(index)}, ` +
						`but this plan is for "${options.resourceType}".`,
					{ scope: options.scope },
				);
			}

			return reference;
		});

		const allowed = await options.check(resources);

		if (allowed.length !== rows.length) {
			fail(
				"EVALUATION_FAILED",
				`postFilter expected ${String(rows.length)} decisions but received ` +
					`${String(allowed.length)}.`,
				{ scope: options.scope },
			);
		}

		return rows.filter((_row, index) => allowed[index] === true);
	};
}
