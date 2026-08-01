// Collision-proof parameter naming.
//
// This file exists because of one property of TypeORM that has no counterpart in
// drizzle: **parameters are query-builder-global**. A `Brackets` does not get its
// own namespace — `getWhereCondition` hands the factory a child builder whose
// `expressionMap.parameters` is *the same object* as the parent's, and
// `setParameter` walks up to the parent as well. So two compiled plans applied to
// one builder, or one compiled plan applied beside a hand-written
// `.andWhere("x = :p0")`, are writing into the same map.
//
// A name reused with a different value is not an error anywhere in TypeORM. The
// second write silently wins, and *both* placeholders resolve to the second
// value. For an authorization filter that is a row set nobody asked for.
//
// Two things prevent it:
//
//   1. The prefix. `nestmp` by default, and it is not a name a human writes.
//   2. The **seed**. The counter starts past every name already on the builder,
//      so a second `applyPlan` continues where the first stopped rather than
//      starting again at zero. That is the design's pinned gotcha, and
//      `tests/unit/parameter-collision.test.ts` is the assertion.
//
// Names are `${prefix}_${n}` — TypeORM restricts parameter keys to
// `[A-Za-z0-9_.]`, and `.` in a key is how you get a name that looks like an
// alias path to `replacePropertyNamesForTheWholeQuery`.

import { PlanCompilationError } from "../errors.ts";

const PARAMETER_PREFIX = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * A namespace of generated bind parameters.
 *
 * One per compiled expression. `bind` returns the `:placeholder` to paste into
 * the SQL text; `values` is the object to hand to `qb.where(text, values)`.
 */
export class ParameterBag {
	readonly #prefix: string;
	readonly #taken: ReadonlySet<string>;
	readonly #values: Record<string, unknown> = {};
	#counter = 0;
	#aliasCounter = 0;

	/**
	 * @param prefix Name prefix. Must be a plain identifier — it lands in the SQL
	 * text as `:${prefix}_0`, which no bind parameter can carry.
	 * @param taken Names already present on the query builder. The counter skips
	 * every one of them, which is what makes two `applyPlan` calls on one builder
	 * safe.
	 */
	constructor(prefix: string, taken: Iterable<string> = []) {
		if (!PARAMETER_PREFIX.test(prefix)) {
			throw new PlanCompilationError(
				"invalid-mapping",
				`parameterPrefix must be a plain identifier (letters, digits, "_"; not starting ` +
					`with a digit), received ${JSON.stringify(prefix)}. It is concatenated into the ` +
					`SQL text as a placeholder name, where no bind parameter exists.`,
			);
		}
		this.#prefix = prefix;
		this.#taken = taken instanceof Set ? taken : new Set(taken);
	}

	/** Binds one value and returns its `:placeholder`. */
	bind(value: unknown): string {
		const name = this.#nextName();
		this.#values[name] = value;
		return `:${name}`;
	}

	/**
	 * A fresh alias for a subquery's table.
	 *
	 * Shares the prefix with the parameters so everything this compiler emits is
	 * recognisably its own, and is unique per expression so two hierarchy
	 * subqueries in one condition cannot shadow each other.
	 */
	nextAlias(): string {
		const alias = `${this.#prefix}_h${String(this.#aliasCounter)}`;
		this.#aliasCounter += 1;
		return alias;
	}

	/** The bound values, for `qb.where(text, values)`. */
	get values(): Record<string, unknown> {
		return this.#values;
	}

	/** How many parameters have been bound. */
	get size(): number {
		return Object.keys(this.#values).length;
	}

	#nextName(): string {
		let name = `${this.#prefix}_${String(this.#counter)}`;
		// `taken` is the builder's existing parameters; `#values` is this bag's own.
		// Skipping both means a bag can be constructed from a builder that already
		// carries `nestmp_0` — which happens the moment a second plan is applied.
		while (this.#taken.has(name) || Object.hasOwn(this.#values, name)) {
			this.#counter += 1;
			name = `${this.#prefix}_${String(this.#counter)}`;
		}
		this.#counter += 1;
		return name;
	}
}
