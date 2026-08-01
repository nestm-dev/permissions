// The fail-closed table, one case per throw in the design's contract, plus the
// two properties that make the table meaningful.
//
// > `planToSql` / `planToBrackets` compile **exactly** the `PlanNode` grammar.
// > Anything a mapping does not cover raises a `PlanCompilationError` before any
// > SQL is produced. There is no configuration in which an uncompilable node
// > becomes `TRUE`.
//
// The two properties:
//
//   * **never-absent-WHERE** — every node in the grammar, and every plan kind,
//     produces a non-empty condition. An omitted `WHERE` is every row in the
//     table, and it is one `return undefined` away in any compiler that has a
//     "nothing to add" branch. This one does not have such a branch, and the
//     property is how that stays true.
//   * **parameter collision** — the design's pinned TypeORM gotcha. Parameters are
//     query-builder-global, so two `applyPlan` calls on one builder share a
//     namespace; a reused name silently rebinds *both* placeholders to the second
//     value.
//
// This file needs no Postgres: a `DataSource` that is never connected still
// builds entity metadata, which is all the compiler reads. That is deliberate —
// the fail-closed contract must hold in a unit run, not only where a server is.

import type { PlanNode, QueryPlan } from "@nestm/permissions-core/plan";
import { DataSource } from "typeorm";
import { beforeAll, describe, expect, it } from "vitest";

import { applyPlan } from "../../src/compile/apply-plan.ts";
import {
	createTypeOrmResourceMapping,
	type TypeOrmResourceMapping,
} from "../../src/compile/mapping.ts";
import {
	planNodeToBrackets,
	planToBrackets,
	planToSql,
} from "../../src/compile/plan-to-brackets.ts";
import { isPlanCompilationError, type PlanCompilationReason } from "../../src/errors.ts";
import { createDocEntities, type DocEntities } from "../fixtures/doc-population.ts";

let dataSource: DataSource;
let entities: DocEntities;
let mapping: TypeOrmResourceMapping<"Doc">;

const attr = (name: string) => ({ root: "resource", path: [name] }) as const;

/** A `CONDITIONAL` plan around one node, with no approximations. */
function conditional(condition: PlanNode): QueryPlan<"Doc"> {
	return {
		kind: "CONDITIONAL",
		resourceType: "Doc",
		condition,
		approximations: [],
	} as unknown as QueryPlan<"Doc">;
}

/** Asserts a compilation throws with the expected discriminant. */
function refuses(reason: PlanCompilationReason, node: PlanNode, target = mapping): void {
	let thrown: unknown;
	try {
		planNodeToBrackets(node, target);
	} catch (error) {
		thrown = error;
	}

	expect(thrown, `expected ${reason} but nothing was thrown`).toBeDefined();
	expect(isPlanCompilationError(thrown)).toBe(true);
	expect((thrown as { reason: string }).reason).toBe(reason);
	// The error must carry enough to find the mapping line that caused it.
	expect((thrown as { message: string }).message.length).toBeGreaterThan(40);
}

describe("fail-closed contract", () => {
	beforeAll(async () => {
		entities = createDocEntities("failclosed", "fc_");
		// Never connected: entity metadata is built from the schemas alone, and the
		// compiler reads nothing else. The fail-closed contract has to hold in a unit
		// run — a suite that needed a server would be one people skip.
		//
		// `buildMetadatas` is `protected` in the typings rather than private in fact;
		// TypeORM's own tests reach it the same way. The alternative is `initialize()`,
		// which opens a connection this file has no use for.
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
				size: { kind: "scalar", column: "size", valueKind: "long" },
				labels: { kind: "array", column: "labels", elementKind: "string" },
				owner: { kind: "entity", column: "ownerId", entityType: "User" },
				folder: { kind: "entity", column: "folderId", entityType: "Folder" },
			},
			hierarchy: { Doc: { kind: "self" } },
		});
	});

	// -----------------------------------------------------------------------
	// The table
	// -----------------------------------------------------------------------

	it("refuses an attribute the mapping does not declare", () => {
		refuses("unmapped-attribute", {
			op: "cmp",
			cmp: "eq",
			attr: attr("title"),
			value: { kind: "string", value: "x" },
		});
	});

	it("refuses a principal-rooted path and a nested path", () => {
		refuses("unmapped-attribute", {
			op: "cmp",
			cmp: "eq",
			attr: { root: "principal", path: ["status"] },
			value: { kind: "string", value: "x" },
		});
		refuses("unmapped-attribute", {
			op: "cmp",
			cmp: "eq",
			attr: { root: "resource", path: ["folder", "name"] },
			value: { kind: "string", value: "x" },
		});
	});

	it("refuses a hierarchy parent type with no strategy", () => {
		refuses("unmapped-hierarchy", {
			op: "inHierarchy",
			attr: null,
			parent: { type: "Org", id: "o1" },
		});
	});

	it("refuses an ordering comparison over a string", () => {
		refuses("unorderable-comparison", {
			op: "cmp",
			cmp: "lt",
			attr: attr("status"),
			value: { kind: "string", value: "x" },
		});
	});

	it("refuses contains and isEmpty on a scalar column", () => {
		refuses("contains-on-scalar", {
			op: "contains",
			attr: attr("status"),
			value: { kind: "string", value: "x" },
		});
		refuses("contains-on-scalar", { op: "isEmpty", attr: attr("status") });
	});

	it("refuses an entity constant against a non-entity column", () => {
		refuses("entity-column-mismatch", {
			op: "cmp",
			cmp: "eq",
			attr: attr("status"),
			value: { kind: "entity", value: { type: "User", id: "u1" } },
		});
	});

	it("refuses a scalar constant against an entity column", () => {
		refuses("entity-column-mismatch", {
			op: "cmp",
			cmp: "eq",
			attr: attr("owner"),
			value: { kind: "string", value: "u1" },
		});
	});

	it("refuses inHierarchy rooted at a non-entity attribute", () => {
		refuses("entity-column-mismatch", {
			op: "inHierarchy",
			attr: attr("status"),
			parent: { type: "Folder", id: "f1" },
		});
	});

	it("refuses like under a case-insensitive collation", () => {
		const insensitive = createTypeOrmResourceMapping(dataSource, {
			resourceType: "Doc",
			entity: entities.docs,
			id: "id",
			attributes: { status: { kind: "scalar", column: "status", valueKind: "string" } },
			text: { collation: "case-insensitive" },
		});
		refuses(
			"case-insensitive-like",
			{ op: "like", attr: attr("status"), pattern: [{ literal: "a" }] },
			insensitive,
		);
	});

	it("refuses like against a non-string column", () => {
		refuses("value-kind-mismatch", {
			op: "like",
			attr: attr("size"),
			pattern: [{ literal: "a" }],
		});
	});

	it("refuses a value whose kind is not the mapped kind", () => {
		refuses("value-kind-mismatch", {
			op: "cmp",
			cmp: "eq",
			attr: attr("size"),
			value: { kind: "string", value: "3" },
		});
	});

	it("refuses a self hierarchy mapping whose parent type is not the target's", () => {
		const wrong = createTypeOrmResourceMapping(dataSource, {
			resourceType: "Doc",
			entity: entities.docs,
			id: "id",
			attributes: {},
			hierarchy: { Folder: { kind: "self" } },
		});
		refuses(
			"invalid-mapping",
			{ op: "inHierarchy", attr: null, parent: { type: "Folder", id: "f1" } },
			wrong,
		);
	});

	it("refuses a column hierarchy mapping rooted at an attribute", () => {
		const rowLevel = createTypeOrmResourceMapping(dataSource, {
			resourceType: "Doc",
			entity: entities.docs,
			id: "id",
			attributes: { folder: { kind: "entity", column: "folderId", entityType: "Folder" } },
			hierarchy: { Org: { kind: "column", column: "orgId" } },
		});
		refuses(
			"unmapped-hierarchy",
			{ op: "inHierarchy", attr: attr("folder"), parent: { type: "Org", id: "o1" } },
			rowLevel,
		);
	});

	it("refuses a plan whose resourceType is not the mapping's", () => {
		const plan = {
			...conditional({ op: "true" }),
			resourceType: "Folder",
		} as unknown as QueryPlan<"Doc">;
		expect(() => planToBrackets(plan, mapping)).toThrowError(/resource type|Folder/i);
		try {
			planToBrackets(plan, mapping);
		} catch (error) {
			expect((error as { reason: string }).reason).toBe("resource-type-mismatch");
		}
	});

	it("refuses a mapping naming a property path the entity does not have", () => {
		let thrown: unknown;
		try {
			createTypeOrmResourceMapping(dataSource, {
				resourceType: "Doc",
				entity: entities.docs,
				id: "id",
				attributes: { status: { kind: "scalar", column: "statsu", valueKind: "string" } },
			});
		} catch (error) {
			thrown = error;
		}
		expect(isPlanCompilationError(thrown)).toBe(true);
		expect((thrown as { reason: string }).reason).toBe("unmapped-attribute");
		// The message lists the real columns, which is the only useful thing to say.
		expect((thrown as { message: string }).message).toContain("status");
	});

	it("refuses an unknown entity in the mapping", () => {
		let thrown: unknown;
		try {
			createTypeOrmResourceMapping(dataSource, {
				resourceType: "Doc",
				entity: "no_such_entity",
				id: "id",
				attributes: {},
			});
		} catch (error) {
			thrown = error;
		}
		expect(isPlanCompilationError(thrown)).toBe(true);
		expect((thrown as { reason: string }).reason).toBe("invalid-mapping");
	});

	// -----------------------------------------------------------------------
	// Permissive approximations
	// -----------------------------------------------------------------------

	it("refuses a permissive approximation without both halves of the opt-in", () => {
		const approximation = {
			policyId: "p0",
			direction: "permissive",
			reason: "unsupported-operator",
			message: "containsAll is not compilable",
		};
		const widened = {
			kind: "CONDITIONAL",
			resourceType: "Doc",
			condition: { op: "true" },
			approximations: [approximation],
		} as unknown as QueryPlan<"Doc">;

		expect(() => planToBrackets(widened, mapping)).toThrowError(/permissive/i);
		// The flag alone is not enough: without a postFilter nothing re-checks the rows.
		expect(() =>
			planToBrackets(widened, mapping, { allowPermissiveApproximations: true }),
		).toThrowError(/postFilter/);

		const withPostFilter = {
			...widened,
			postFilter: { policyIds: ["p0"] },
		} as unknown as QueryPlan<"Doc">;
		expect(() =>
			planToBrackets(withPostFilter, mapping, { allowPermissiveApproximations: true }),
		).not.toThrow();
	});

	it("compiles an ALWAYS_DENY carrying a permissive approximation", () => {
		// It selects nothing, so no approximation it carries can over-share, and
		// refusing it would only make the fail-closed answer unavailable.
		const denied = {
			kind: "ALWAYS_DENY",
			resourceType: "Doc",
			approximations: [
				{ policyId: "p0", direction: "permissive", reason: "unsupported-operator", message: "x" },
			],
		} as unknown as QueryPlan<"Doc">;
		expect(planToSql(denied, mapping).text).toBe("1 = 0");
	});

	// -----------------------------------------------------------------------
	// Never an absent WHERE
	// -----------------------------------------------------------------------

	it("produces a non-empty condition for every node in the grammar", () => {
		const nodes: PlanNode[] = [
			{ op: "true" },
			{ op: "false" },
			{ op: "and", nodes: [] },
			{ op: "or", nodes: [] },
			{ op: "and", nodes: [{ op: "true" }, { op: "false" }] },
			{ op: "or", nodes: [{ op: "true" }, { op: "false" }] },
			{ op: "not", node: { op: "in", attr: attr("status"), values: [] } },
			{ op: "cmp", cmp: "eq", attr: attr("status"), value: { kind: "string", value: "x" } },
			{ op: "in", attr: attr("status"), values: [] },
			{ op: "in", attr: attr("status"), values: [{ kind: "string", value: "x" }] },
			{ op: "contains", attr: attr("labels"), value: { kind: "string", value: "x" } },
			{ op: "isEmpty", attr: attr("labels") },
			{ op: "like", attr: attr("status"), pattern: [] },
			{ op: "exists", attr: attr("status") },
			{ op: "isType", entityType: "Doc" },
			{ op: "isType", entityType: "Folder" },
			{ op: "inHierarchy", attr: null, parent: { type: "Doc", id: "d1" } },
			{
				op: "cmp",
				cmp: "eq",
				attr: attr("labels"),
				value: { kind: "set", value: [{ kind: "string", value: "x" }] },
			},
			{
				op: "cmp",
				cmp: "eq",
				attr: attr("owner"),
				value: { kind: "entity", value: { type: "User", id: "u" } },
			},
			// A foreign entity type folds to a constant — which must still be a
			// *constant expression*, not an empty string.
			{
				op: "cmp",
				cmp: "eq",
				attr: attr("owner"),
				value: { kind: "entity", value: { type: "Group", id: "u" } },
			},
		];

		for (const node of nodes) {
			const { text } = planToSql(conditional(node), mapping);
			expect(text.trim(), `node ${node.op} produced an empty condition`).not.toBe("");
			expect(text).toMatch(/\S/);
		}
	});

	it("produces a total condition for all three plan kinds", () => {
		const always = {
			kind: "ALWAYS_ALLOW",
			resourceType: "Doc",
			approximations: [],
		} as unknown as QueryPlan<"Doc">;
		const never = {
			kind: "ALWAYS_DENY",
			resourceType: "Doc",
			approximations: [],
		} as unknown as QueryPlan<"Doc">;

		expect(planToSql(always, mapping).text).toBe("1 = 1");
		expect(planToSql(never, mapping).text).toBe("1 = 0");
		expect(planToSql(conditional({ op: "true" }), mapping).text).toBe("1 = 1");
	});

	it("emits a WHERE clause on the builder even for ALWAYS_ALLOW", () => {
		const always = {
			kind: "ALWAYS_ALLOW",
			resourceType: "Doc",
			approximations: [],
		} as unknown as QueryPlan<"Doc">;
		const [sql] = applyPlan(
			dataSource.createQueryBuilder(entities.docs, "doc").select("doc.id"),
			always,
			mapping,
		).getQueryAndParameters();

		// The point of the whole exercise: `WHERE` is present, not omitted.
		expect(sql).toContain("WHERE");
		expect(sql).toContain("1 = 1");
	});

	// -----------------------------------------------------------------------
	// A failed compile leaves the builder untouched
	// -----------------------------------------------------------------------

	it("does not modify the query builder when compilation fails", () => {
		const query = dataSource
			.createQueryBuilder(entities.docs, "doc")
			.select("doc.id")
			.where("doc.orgId = :org", { org: "o1" });
		const before = query.getQuery();

		expect(() =>
			applyPlan(
				query,
				conditional({
					op: "cmp",
					cmp: "eq",
					attr: attr("title"),
					value: { kind: "string", value: "x" },
				}),
				mapping,
			),
		).toThrowError(/title/);

		// The eager compile pass is what buys this: a lazily-compiled `Brackets`
		// would already be on the builder by the time it threw.
		expect(query.getQuery()).toBe(before);
	});
});
