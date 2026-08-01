// The design's pinned TypeORM gotcha, in one file.
//
// > TypeORM parameters are QueryBuilder-global — names are `${prefix}_${n}` with
// > `prefix` defaulting to `nestmp` and a counter seeded from
// > `qb.expressionMap.parameters` so two `applyPlan` calls on one builder cannot
// > collide.
//
// Why this is not a theoretical concern. TypeORM's `getWhereCondition` gives a
// `Brackets` factory a *child* query builder whose `expressionMap.parameters` is
// the same object as the parent's, and whose `setParameter` walks up to the
// parent as well. So there is exactly one namespace per query. `setParameter`
// does not complain about a name that already exists — it overwrites — and
// `escapeQueryWithParameters` then resolves *both* occurrences of `:nestmp_0` to
// the second value. The query is syntactically perfect and selects the wrong
// rows.
//
// Drizzle has no counterpart to any of this: its `sql` template carries its
// values inline, so two compiled filters cannot see each other. This is the one
// place the two drivers' implementations genuinely differ in kind rather than in
// spelling, which is why it gets its own suite.

import type { PlanNode, QueryPlan } from "@nestm/permissions-core/plan";
import { Brackets, DataSource } from "typeorm";
import { beforeAll, describe, expect, it } from "vitest";

import { applyPlan } from "../../src/compile/apply-plan.ts";
import {
	createTypeOrmResourceMapping,
	type TypeOrmResourceMapping,
} from "../../src/compile/mapping.ts";
import { planToBrackets } from "../../src/compile/plan-to-brackets.ts";
import { ParameterBag } from "../../src/compile/parameters.ts";
import { createDocEntities, type DocEntities } from "../fixtures/doc-population.ts";

let dataSource: DataSource;
let entities: DocEntities;
let mapping: TypeOrmResourceMapping<"Doc">;

const attr = (name: string) => ({ root: "resource", path: [name] }) as const;

function conditional(condition: PlanNode): QueryPlan<"Doc"> {
	return {
		kind: "CONDITIONAL",
		resourceType: "Doc",
		condition,
		approximations: [],
	} as unknown as QueryPlan<"Doc">;
}

/** `resource.status == <value>` — one parameter, whose value identifies the plan. */
function statusIs(value: string): QueryPlan<"Doc"> {
	return conditional({
		op: "cmp",
		cmp: "eq",
		attr: attr("status"),
		value: { kind: "string", value },
	});
}

function select() {
	return dataSource.createQueryBuilder(entities.docs, "doc").select("doc.id");
}

describe("parameter collision", () => {
	beforeAll(async () => {
		entities = createDocEntities("params", "pc_");
		dataSource = new DataSource({
			type: "postgres",
			entities: [entities.docs, entities.closure, entities.nodes],
		});
		await (dataSource as unknown as { buildMetadatas(): Promise<void> }).buildMetadatas();

		mapping = createTypeOrmResourceMapping(dataSource, {
			resourceType: "Doc",
			entity: entities.docs,
			id: "id",
			attributes: {
				status: { kind: "scalar", column: "status", valueKind: "string" },
				title: { kind: "scalar", column: "title", valueKind: "string" },
				size: { kind: "scalar", column: "size", valueKind: "long" },
				labels: { kind: "array", column: "labels", elementKind: "string" },
				folder: { kind: "entity", column: "folderId", entityType: "Folder" },
			},
			hierarchy: {
				Doc: { kind: "self" },
				Org: {
					kind: "recursive",
					entity: entities.nodes,
					parentColumn: "parentId",
					idColumn: "id",
				},
			},
		});
	});

	it("keeps both values when two plans are applied to one builder", () => {
		const query = select();
		applyPlan(query, statusIs("first"), mapping);
		applyPlan(query, statusIs("second"), mapping);

		const [sql, parameters] = query.getQueryAndParameters();

		// Two distinct placeholders, two distinct values, in order.
		expect(parameters).toEqual(["first", "second"]);
		expect(sql).toContain("$1");
		expect(sql).toContain("$2");
		// And both terms survive: `andWhere` appends, it does not replace.
		expect(sql.match(/"doc"\."status" = \$/g)).toHaveLength(2);
	});

	it("does not collide with parameters the caller bound first", () => {
		const query = select().where("doc.orgId = :nestmp_0", { nestmp_0: "caller-value" });
		applyPlan(query, statusIs("plan-value"), mapping);

		const [, parameters] = query.getQueryAndParameters();

		// The seed skipped `nestmp_0` rather than overwriting it. Without the seed
		// both placeholders would resolve to "plan-value" and the tenant filter would
		// silently become a status filter.
		expect(parameters).toEqual(["caller-value", "plan-value"]);
	});

	it("does not collide across ten applications on one builder", () => {
		const query = select();
		const values = Array.from({ length: 10 }, (_, index) => `v${String(index)}`);
		for (const value of values) {
			applyPlan(query, statusIs(value), mapping);
		}

		const [sql, parameters] = query.getQueryAndParameters();
		expect(parameters).toEqual(values);
		// Ten distinct positional parameters, no reuse.
		expect(new Set(sql.match(/\$\d+/g) ?? []).size).toBe(10);
	});

	it("survives nesting inside the caller's own Brackets", () => {
		const query = select();
		query.andWhere(
			new Brackets((outer) => {
				outer.where("doc.orgId = :org", { org: "o1" });
				outer.orWhere(planToBrackets(statusIs("nested"), mapping));
			}),
		);
		applyPlan(query, statusIs("outer"), mapping);

		const [, parameters] = query.getQueryAndParameters();
		expect(parameters).toEqual(["o1", "nested", "outer"]);
	});

	it("keeps a multi-parameter plan's values in order", () => {
		const query = select();
		applyPlan(
			query,
			conditional({
				op: "and",
				nodes: [
					{ op: "cmp", cmp: "eq", attr: attr("status"), value: { kind: "string", value: "a" } },
					{ op: "like", attr: attr("title"), pattern: [{ literal: "b" }] },
					{ op: "cmp", cmp: "gte", attr: attr("size"), value: { kind: "long", value: 3n } },
				],
			}),
			mapping,
		);
		applyPlan(query, statusIs("z"), mapping);

		const [, parameters] = query.getQueryAndParameters();
		// status, like-pattern, like-escape, size, then the second plan's status.
		expect(parameters).toEqual(["a", "b", "\\", "3", "z"]);
	});

	it("gives each hierarchy subquery its own alias", () => {
		const query = select();
		applyPlan(
			query,
			conditional({
				op: "or",
				nodes: [
					{ op: "inHierarchy", attr: null, parent: { type: "Org", id: "o1" } },
					{ op: "inHierarchy", attr: null, parent: { type: "Org", id: "o2" } },
				],
			}),
			mapping,
		);

		const [sql] = query.getQueryAndParameters();
		// Two recursive CTEs in one condition. Each needs its own name, or the second
		// would shadow the first if they ever ended up in one scope.
		const aliases = new Set(sql.match(/nestmp_h\d+/g) ?? []);
		expect(aliases.size).toBe(4);
	});

	it("honours a custom parameter prefix", () => {
		const query = select();
		applyPlan(query, statusIs("x"), mapping, { parameterPrefix: "acme" });
		// `getQuery()` keeps the named placeholder; `getQueryAndParameters()` is what
		// substitutes it for the driver's positional one.
		expect(query.getQuery()).toContain(":acme_0");
		expect(Object.keys(query.getParameters())).toEqual(["acme_0"]);
		expect(query.getQueryAndParameters()).toEqual([expect.stringContaining("$1"), ["x"]]);
	});

	it("rejects a prefix that is not a plain identifier", () => {
		expect(() => planToBrackets(statusIs("x"), mapping, { parameterPrefix: "a-b" })).toThrowError(
			/plain identifier/,
		);
		expect(() => planToBrackets(statusIs("x"), mapping, { parameterPrefix: "a.b" })).toThrowError(
			/plain identifier/,
		);
	});

	describe("ParameterBag", () => {
		it("skips names already taken", () => {
			const bag = new ParameterBag("p", ["p_0", "p_1", "p_3"]);
			expect(bag.bind("a")).toBe(":p_2");
			expect(bag.bind("b")).toBe(":p_4");
			expect(bag.values).toEqual({ p_2: "a", p_4: "b" });
		});

		it("never reuses one of its own names", () => {
			const bag = new ParameterBag("p");
			const names = Array.from({ length: 50 }, () => bag.bind("x"));
			expect(new Set(names).size).toBe(50);
			expect(bag.size).toBe(50);
		});

		it("issues distinct subquery aliases", () => {
			const bag = new ParameterBag("p");
			expect([bag.nextAlias(), bag.nextAlias(), bag.nextAlias()]).toEqual(["p_h0", "p_h1", "p_h2"]);
		});
	});
});
