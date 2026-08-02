import { normalizeEntityUid } from "@nestm/permissions-core";
import { describe, expect, it, vi } from "vitest";
import type { CheckResult, EntityGraph, QueryPlan } from "@nestm/permissions-core";

import {
	RequestAuthorization,
	type AuthorizationEngine,
	type RequestAuthorizationEntityResolver,
} from "../../src/index.ts";
import { IDS, TEST_SCOPE, memberGraph, runGraph } from "../shared/test-vocabulary.ts";

const PLAN: QueryPlan = {
	kind: "ALWAYS_ALLOW",
	resourceType: "Run",
	approximations: [],
	diagnostics: {
		residualPolicyIds: [],
		erroredPolicyIds: [],
		policySetVersion: "g0:s0",
		cache: "miss",
		durationMs: 0,
		explain: () => "test plan",
	},
};
const ALLOW: CheckResult = {
	allowed: true,
	decision: "allow",
	determiningPolicyIds: [],
	policyErrors: [],
	scope: TEST_SCOPE,
	policySetVersion: "g0:s0",
	durationMs: 0,
	cache: "miss",
};

interface CapturedQuestion {
	readonly entities: EntityGraph;
}

function ids(graph: EntityGraph): readonly string[] {
	return graph.map((entity) => normalizeEntityUid(entity.uid).id);
}

function authorization(entityResolver?: RequestAuthorizationEntityResolver) {
	const planned: CapturedQuestion[] = [];
	const checked: CapturedQuestion[] = [];
	const plan = vi.fn(async (request: CapturedQuestion) => {
		planned.push(request);
		return PLAN;
	});
	const checkUnsafe = vi.fn(async (request: CapturedQuestion) => {
		checked.push(request);
		return ALLOW;
	});
	const engine = { plan, checkUnsafe } as unknown as AuthorizationEngine;
	const initialEntities = [...memberGraph(IDS.member, "member"), ...runGraph()];

	return {
		planned,
		checked,
		value: new RequestAuthorization({
			engine,
			...(entityResolver === undefined ? {} : { entityResolver }),
			principal: {
				ref: { type: "Member", id: IDS.member },
				entities: memberGraph(IDS.member, "member"),
			},
			scope: TEST_SCOPE,
			context: { source: "request" },
			entities: initialEntities,
			route: undefined,
			resource: undefined,
			result: undefined,
			plan: undefined,
		}),
	};
}

describe("RequestAuthorization imperative entity resolution", () => {
	it("keeps the original graph fallback for manually constructed instances", async () => {
		const { value, planned, checked } = authorization();

		await value.planFor("run:read", "Run");
		await value.can("run:read", { type: "Run", id: IDS.run });

		expect(planned[0]?.entities).toBe(value.entities);
		expect(checked[0]?.entities).toBe(value.entities);
	});

	it("re-resolves contributions for planFor and can with the requested question", async () => {
		const resolver = vi.fn<RequestAuthorizationEntityResolver>(async () => runGraph());
		const { value, planned, checked } = authorization(resolver);
		const alternateScope = "org:alternate";

		await value.planFor("run:dispatch", "Run", {
			scope: alternateScope,
			context: { source: "plan" },
		});
		await value.can(
			"run:read",
			{ type: "Run", id: IDS.run },
			{ scope: alternateScope, context: { source: "can" } },
		);

		expect(resolver).toHaveBeenNthCalledWith(1, {
			scope: alternateScope,
			principal: { type: "Member", id: IDS.member },
			action: "run:dispatch",
			resourceType: "Run",
		});
		expect(resolver).toHaveBeenNthCalledWith(2, {
			scope: alternateScope,
			principal: { type: "Member", id: IDS.member },
			action: "run:read",
			resourceType: "Run",
			resource: { type: "Run", id: IDS.run },
		});

		expect(ids(planned[0]?.entities ?? [])).toEqual([
			IDS.organization,
			IDS.member,
			IDS.project,
			IDS.run,
		]);
		expect(ids(checked[0]?.entities ?? [])).toEqual(ids(planned[0]?.entities ?? []));
	});

	it("uses explicit entities verbatim and skips re-resolution", async () => {
		const resolver = vi.fn<RequestAuthorizationEntityResolver>(async () => runGraph());
		const { value, planned, checked } = authorization(resolver);
		const explicit: EntityGraph = [];

		await value.planFor("run:read", "Run", { entities: explicit });
		await value.can("run:read", { type: "Run", id: IDS.run }, { entities: explicit });

		expect(resolver).not.toHaveBeenCalled();
		expect(planned[0]?.entities).toBe(explicit);
		expect(checked[0]?.entities).toBe(explicit);
	});
});
