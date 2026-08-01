import type { PlanNode, PlanValue, QueryPlan } from "@nestm/permissions";

import type { Run } from "./runs.repository.ts";

/**
 * A **demonstration** evaluator for `plan.condition`, over in-memory rows.
 *
 * This is not how you should filter a database. `@nestm/permissions-drizzle` and
 * `@nestm/permissions-typeorm` compile the very same `PlanNode` into a `WHERE`
 * clause — parameter-bound, pushed down, paginated by the database. Evaluating
 * the condition in JavaScript means loading every row first, which is precisely
 * what the query plan exists to avoid.
 *
 * It is here because it makes the shape of the AST visible: thirteen ops, values
 * typed rather than stringly, and **no** node that a driver may quietly treat as
 * `TRUE`. Anything unmapped throws, because "I could not compile this filter" and
 * "this filter matches everything" must never be the same code path.
 */
export function evaluatePlanNode(node: PlanNode, run: Run): boolean {
	switch (node.op) {
		case "true": {
			return true;
		}
		case "false": {
			return false;
		}
		case "and": {
			return node.nodes.every((child) => evaluatePlanNode(child, run));
		}
		case "or": {
			return node.nodes.some((child) => evaluatePlanNode(child, run));
		}
		case "not": {
			return !evaluatePlanNode(node.node, run);
		}
		case "isType": {
			// The only row type this repository holds.
			return node.entityType === "Run";
		}
		case "cmp": {
			const left = attributeOf(node.attr.path, run);
			const right = literalOf(node.value);
			switch (node.cmp) {
				case "eq": {
					return left === right;
				}
				case "ne": {
					return left !== right;
				}
				default: {
					throw new Error(`No mapping for comparison "${node.cmp}" in this example.`);
				}
			}
		}
		case "inHierarchy": {
			// Cedar's `in` is reflexive and transitive. A Run's only parent is its
			// Project, so "the row itself is in P" is "the row's project is P".
			if (node.attr !== null) {
				throw new Error("No mapping for an attribute-rooted hierarchy test in this example.");
			}
			if (node.parent.type === "Project") {
				return run.projectId === node.parent.id;
			}
			// An Organization parent: every project here belongs to the one org.
			return node.parent.type === "Organization";
		}
		default: {
			// Fail closed. A driver that cannot map a node must throw, never widen.
			throw new Error(`No mapping for plan node "${node.op}" in this example.`);
		}
	}
}

function attributeOf(path: readonly string[], run: Run): unknown {
	if (path.length !== 1) {
		throw new Error("Nested attribute access needs a join, which a plan never encodes.");
	}
	switch (path[0]) {
		case "status": {
			return run.status;
		}
		case "project": {
			return run.projectId;
		}
		default: {
			throw new Error(`No column mapped for attribute "${String(path[0])}".`);
		}
	}
}

function literalOf(value: PlanValue): unknown {
	switch (value.kind) {
		case "string":
		case "bool":
		case "decimal":
		case "ipaddr": {
			return value.value;
		}
		case "long": {
			return Number(value.value);
		}
		case "entity": {
			return value.value.id;
		}
		default: {
			throw new Error(`No binding for plan value kind "${value.kind}" in this example.`);
		}
	}
}

/** Applies a three-state plan to the rows. */
export function applyPlan(plan: QueryPlan, rows: readonly Run[]): readonly Run[] {
	switch (plan.kind) {
		case "ALWAYS_DENY": {
			return [];
		}
		case "ALWAYS_ALLOW": {
			return rows;
		}
		case "CONDITIONAL": {
			return rows.filter((run) => evaluatePlanNode(plan.condition, run));
		}
	}
}
