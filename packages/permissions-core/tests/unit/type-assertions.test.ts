import { describe, expectTypeOf, it } from "vitest";

import type { EntityRef } from "../../src/cedar/uid.ts";
import type { PlanRequest } from "../../src/engine.ts";
import type { PlanNode, QueryPlan } from "../../src/plan/plan.ts";
import { defineVocabulary } from "../../src/vocabulary/define-vocabulary.ts";
import type {
	ActionGroupOf,
	ActionOf,
	AttrsFor,
	ContextFor,
	EntityNameOf,
	PrincipalOf,
	PrincipalTypeFor,
	ResourceOf,
	ResourceTypeFor,
} from "../../src/vocabulary/types.ts";
import { stationVocabulary, type StationVocabulary } from "../fixtures/station-vocabulary.ts";

// A second vocabulary whose actions have several principal/resource types, so
// the narrowing helpers are pinned on unions and not only on singletons.
const multiVocabulary = defineVocabulary({
	namespace: "Multi",
	entities: { User: {}, Service: {}, Doc: {}, Folder: {} },
	actions: {
		"doc:*": {},
		"doc:read": {
			memberOf: ["doc:*"],
			principal: ["User", "Service"],
			resource: ["Doc", "Folder"],
		},
		"doc:write": { memberOf: ["doc:*"], principal: ["User"], resource: ["Doc"] },
	},
});
type MultiVocabulary = typeof multiVocabulary;

describe("EntityNameOf", () => {
	it("is the exact union of declared entity types", () => {
		expectTypeOf<EntityNameOf<StationVocabulary>>().toEqualTypeOf<
			"Organization" | "Role" | "Project" | "Member" | "Run"
		>();
	});
});

describe("ActionOf", () => {
	it("is the exact union of requestable action ids", () => {
		expectTypeOf<ActionOf<StationVocabulary>>().toEqualTypeOf<
			"run:dispatch" | "run:read" | "project:manage"
		>();
	});

	it("excludes action groups", () => {
		expectTypeOf<ActionOf<StationVocabulary>>().not.toEqualTypeOf<
			"run:*" | "run:dispatch" | "run:read" | "project:manage"
		>();
	});

	it("narrows the runtime action list to the same union", () => {
		expectTypeOf(stationVocabulary.actionNames).toEqualTypeOf<
			readonly ("run:dispatch" | "run:read" | "project:manage")[]
		>();
	});
});

describe("ActionGroupOf", () => {
	it("is the exact union of group ids", () => {
		expectTypeOf<ActionGroupOf<StationVocabulary>>().toEqualTypeOf<"run:*">();
		expectTypeOf<ActionGroupOf<MultiVocabulary>>().toEqualTypeOf<"doc:*">();
	});

	it("gates actionsInGroup", () => {
		expectTypeOf<Parameters<StationVocabulary["actionsInGroup"]>[0]>().toEqualTypeOf<"run:*">();
		expectTypeOf(stationVocabulary.actionsInGroup("run:*")).toEqualTypeOf<
			readonly ("run:dispatch" | "run:read" | "project:manage")[]
		>();
	});
});

describe("PrincipalTypeFor / ResourceTypeFor", () => {
	it("narrows to the action's own appliesTo", () => {
		expectTypeOf<PrincipalTypeFor<StationVocabulary, "run:dispatch">>().toEqualTypeOf<"Member">();
		expectTypeOf<ResourceTypeFor<StationVocabulary, "run:dispatch">>().toEqualTypeOf<"Run">();
		expectTypeOf<ResourceTypeFor<StationVocabulary, "project:manage">>().toEqualTypeOf<"Project">();
	});

	it("keeps multi-type appliesTo as a union", () => {
		expectTypeOf<PrincipalTypeFor<MultiVocabulary, "doc:read">>().toEqualTypeOf<
			"User" | "Service"
		>();
		expectTypeOf<ResourceTypeFor<MultiVocabulary, "doc:read">>().toEqualTypeOf<"Doc" | "Folder">();
		expectTypeOf<ResourceTypeFor<MultiVocabulary, "doc:write">>().toEqualTypeOf<"Doc">();
	});

	it("distributes over an action union", () => {
		expectTypeOf<ResourceTypeFor<MultiVocabulary, "doc:read" | "doc:write">>().toEqualTypeOf<
			"Doc" | "Folder"
		>();
	});
});

describe("ResourceOf / PrincipalOf", () => {
	it("collects every resource type reachable through some action", () => {
		expectTypeOf<ResourceOf<StationVocabulary>>().toEqualTypeOf<"Run" | "Project">();
		expectTypeOf<PrincipalOf<StationVocabulary>>().toEqualTypeOf<"Member">();
		expectTypeOf<ResourceOf<MultiVocabulary>>().toEqualTypeOf<"Doc" | "Folder">();
	});

	it("never leaks entity types no action touches", () => {
		expectTypeOf<ResourceOf<StationVocabulary>>().not.toEqualTypeOf<
			"Run" | "Project" | "Organization"
		>();
	});
});

describe("ContextFor", () => {
	it("maps declared context fields, honouring t.optional", () => {
		expectTypeOf<ContextFor<StationVocabulary, "run:dispatch">>().toEqualTypeOf<{
			readonly reason: string;
			readonly mfa?: boolean;
		}>();
	});

	it("is an empty record for an action with no declared context", () => {
		expectTypeOf<ContextFor<StationVocabulary, "run:read">>().toEqualTypeOf<
			Readonly<Record<string, never>>
		>();
	});
});

describe("AttrsFor", () => {
	it("maps every attribute kind to its authored TypeScript type", () => {
		expectTypeOf<AttrsFor<StationVocabulary, "Run">>().toEqualTypeOf<{
			readonly project: EntityRef<"Project">;
			readonly status: string;
			readonly createdBy: EntityRef<"Member">;
			readonly attempt: number;
			readonly labels: readonly string[];
			readonly startedAt?: Date;
			readonly trigger: { readonly kind: string; readonly actor?: string };
		}>();
	});

	it("is an empty record for an entity with no attributes", () => {
		expectTypeOf<AttrsFor<StationVocabulary, "Organization">>().toEqualTypeOf<
			Readonly<Record<string, never>>
		>();
	});
});

describe("compile-time rejections", () => {
	// A request shape mirroring `CheckRequest` from docs/design/core.md §1: this
	// is what the engine and `@RequirePermission` will type-check against.
	interface Request<A extends ActionOf<StationVocabulary>> {
		readonly action: A;
		readonly principal: EntityRef<PrincipalTypeFor<StationVocabulary, A>>;
		readonly resource: EntityRef<ResourceTypeFor<StationVocabulary, A>>;
		readonly context?: ContextFor<StationVocabulary, A>;
	}

	function check<A extends ActionOf<StationVocabulary>>(request: Request<A>): A {
		return request.action;
	}

	it("accepts a matching action/resource pair", () => {
		expectTypeOf(
			check({
				action: "run:dispatch",
				principal: { type: "Member", id: "m1" },
				resource: { type: "Run", id: "r1" },
				context: { reason: "manual" },
			}),
		).toEqualTypeOf<"run:dispatch">();
	});

	it("rejects a mismatched resource type", () => {
		check({
			action: "run:dispatch",
			principal: { type: "Member", id: "m1" },
			// @ts-expect-error -- run:dispatch applies to Run, not Project
			resource: { type: "Project", id: "p1" },
			context: { reason: "manual" },
		});
	});

	it("rejects a mismatched principal type", () => {
		check({
			action: "run:dispatch",
			// @ts-expect-error -- run:dispatch applies to Member, not Organization
			principal: { type: "Organization", id: "o1" },
			resource: { type: "Run", id: "r1" },
			context: { reason: "manual" },
		});
	});

	it("rejects an unknown action string", () => {
		check({
			// @ts-expect-error -- "run:delete" is not declared in the vocabulary
			action: "run:delete",
			principal: { type: "Member", id: "m1" },
			resource: { type: "Run", id: "r1" },
		});
	});

	it("rejects an action group used as an action", () => {
		check({
			// @ts-expect-error -- "run:*" is an action group and is never requestable
			action: "run:*",
			principal: { type: "Member", id: "m1" },
			resource: { type: "Run", id: "r1" },
		});
	});

	it("rejects an unknown context key", () => {
		check({
			action: "run:dispatch",
			principal: { type: "Member", id: "m1" },
			resource: { type: "Run", id: "r1" },
			// @ts-expect-error -- "mfaa" is not a declared context field
			context: { reason: "manual", mfaa: true },
		});
	});

	it("rejects a wrongly typed context value", () => {
		check({
			action: "run:dispatch",
			principal: { type: "Member", id: "m1" },
			resource: { type: "Run", id: "r1" },
			// @ts-expect-error -- mfa is declared as a boolean
			context: { reason: "manual", mfa: "yes" },
		});
	});

	it("rejects a group id passed to actionUid's requestable sibling", () => {
		// `actionUid` deliberately accepts groups: policies name them.
		expectTypeOf<Parameters<StationVocabulary["actionUid"]>[0]>().toEqualTypeOf<
			"run:*" | "run:dispatch" | "run:read" | "project:manage"
		>();
		// @ts-expect-error -- but `actionsInGroup` only accepts groups
		stationVocabulary.actionsInGroup("run:dispatch");
	});

	it("rejects an undeclared entity type in entityUid", () => {
		expectTypeOf(stationVocabulary.entityUid({ type: "Run", id: "r1" })).not.toBeNever();
		// @ts-expect-error -- "Widget" is not declared under entities
		stationVocabulary.entityUid({ type: "Widget", id: "w1" });
	});
});

describe("PlanRequest narrowing", () => {
	// `plan()` narrows `resourceType` through exactly the same union `check()`
	// narrows `resource.type` through, so a mismatched action/type pair is a
	// compile error rather than a plan that filters the wrong table.
	function plan<
		A extends ActionOf<StationVocabulary>,
		R extends ResourceTypeFor<StationVocabulary, A>,
	>(request: PlanRequest<StationVocabulary, A, R>): R {
		return request.resourceType;
	}

	it("carries the resource type through to the plan's own generic", () => {
		expectTypeOf(
			plan({
				scope: "org:1",
				principal: { type: "Member", id: "m1" },
				action: "run:read",
				resourceType: "Run",
			}),
		).toEqualTypeOf<"Run">();
	});

	it("rejects a resource type the action does not declare", () => {
		plan({
			scope: "org:1",
			principal: { type: "Member", id: "m1" },
			action: "run:read",
			// @ts-expect-error -- run:read applies to Run, not Project
			resourceType: "Project",
		});
	});

	it("rejects a mismatched principal type", () => {
		plan({
			scope: "org:1",
			// @ts-expect-error -- run:read applies to Member, not Organization
			principal: { type: "Organization", id: "o1" },
			action: "run:read",
			resourceType: "Run",
		});
	});

	it("rejects an undeclared context field", () => {
		plan({
			scope: "org:1",
			principal: { type: "Member", id: "m1" },
			action: "run:dispatch",
			resourceType: "Run",
			// @ts-expect-error -- "mfaa" is not a declared context field
			context: { reason: "manual", mfaa: true },
		});
	});

	it("narrows QueryPlan on `kind`", () => {
		const plan = {} as QueryPlan<"Run">;

		if (plan.kind === "CONDITIONAL") {
			expectTypeOf(plan.condition).toEqualTypeOf<PlanNode>();
		} else {
			// @ts-expect-error -- only the CONDITIONAL arm carries a condition
			expectTypeOf(plan.condition);
		}
		expectTypeOf(plan.resourceType).toEqualTypeOf<"Run">();
	});
});
