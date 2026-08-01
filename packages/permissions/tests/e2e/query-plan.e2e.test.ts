import "reflect-metadata";
import { Controller, Get } from "@nestjs/common";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import type { INestApplication } from "@nestjs/common";

import {
	CurrentAuthorization,
	QueryPlan,
	RequirePermission,
	type RequestAuthorization,
	type SeedPolicy,
} from "../../src/index.ts";
import { createTestApp } from "../shared/test-app.ts";
import { testHttpAdapter } from "../shared/http-adapter.ts";
import { HeaderPrincipalResolver, ROLE_HEADER, USER_HEADER } from "../shared/test-principal.ts";
import { IDS, TEST_SCOPE, testVocabulary } from "../shared/test-vocabulary.ts";

/**
 * One conditional policy and one that never applies to a non-admin.
 *
 * `run:read` is granted only for queued runs, which is what makes the plan
 * `CONDITIONAL` rather than `ALWAYS_ALLOW`: the condition reaches into the
 * resource, which is exactly the unknown the planner leaves open.
 */
const PLAN_POLICIES: readonly SeedPolicy[] = [
	{
		id: "members-may-read-queued-runs",
		scope: TEST_SCOPE,
		text: `permit(
			principal in Test::Organization::"${IDS.organization}",
			action == Test::Action::"run:read",
			resource
		) when { resource.status == "queued" };`,
	},
	{
		id: "admins-may-dispatch-runs",
		scope: TEST_SCOPE,
		text: `permit(
			principal in Test::Organization::"${IDS.organization}",
			action == Test::Action::"run:dispatch",
			resource
		) when { principal.role == "admin" };`,
	},
];

@Controller("runs")
class RunsController {
	/** The list shape: no resource is named, so the guard plans. */
	@Get()
	@RequirePermission("run:read", { kind: "unspecified", type: "Run" })
	list(@QueryPlan() plan: QueryPlan): { kind: string; condition: unknown; type: string } {
		return {
			kind: plan.kind,
			condition: plan.kind === "CONDITIONAL" ? plan.condition : undefined,
			type: plan.resourceType,
		};
	}

	/** Omitting the resource entirely means the same thing, inferred. */
	@Get("inferred")
	@RequirePermission("run:read")
	inferred(@QueryPlan() plan: QueryPlan): { kind: string; type: string } {
		return { kind: plan.kind, type: plan.resourceType };
	}

	/** A plan for an action the principal cannot hold at all. */
	@Get("dispatchable")
	@RequirePermission("run:dispatch", { kind: "unspecified", type: "Run" })
	dispatchable(@QueryPlan() plan: QueryPlan): { kind: string } {
		return { kind: plan.kind };
	}

	/** `planFor` — the imperative twin, for a handler that lists two things. */
	@Get("both")
	@RequirePermission("run:read", { kind: "unspecified", type: "Run" })
	async both(
		@CurrentAuthorization() authorization: RequestAuthorization,
	): Promise<{ runs: string; dispatch: string; can: boolean }> {
		const dispatch = await authorization.planFor("run:dispatch", "Run");
		return {
			runs: authorization.plan?.kind ?? "none",
			dispatch: dispatch.kind,
			can: await authorization.can("run:read", { type: "Run", id: IDS.run }),
		};
	}
}

let app: INestApplication | undefined;

afterEach(async () => {
	await app?.close();
	app = undefined;
});

async function createPlanApp(): Promise<INestApplication> {
	return createTestApp({
		forRoot: {
			vocabulary: testVocabulary,
			policies: PLAN_POLICIES,
			principalResolver: new HeaderPrincipalResolver(),
			scopeResolver: () => TEST_SCOPE,
		},
		metadata: { controllers: [RunsController] },
	});
}

describe(`query plans (${testHttpAdapter})`, () => {
	it("stashes a CONDITIONAL plan and delivers it through @QueryPlan()", async () => {
		app = await createPlanApp();

		const response = await request(app.getHttpServer())
			.get("/runs")
			.set(USER_HEADER, IDS.member)
			.expect(200);

		expect(response.body.kind).toBe("CONDITIONAL");
		expect(response.body.type).toBe("Run");
		// The condition is the neutral AST a driver compiles into SQL — no
		// rendered string, and the value is typed rather than interpolated.
		expect(response.body.condition).toEqual({
			op: "cmp",
			cmp: "eq",
			attr: { root: "resource", path: ["status"] },
			value: { kind: "string", value: "queued" },
		});
	});

	it("refuses the request with 403 when the plan is ALWAYS_DENY", async () => {
		app = await createPlanApp();

		// A non-admin can dispatch nothing, so there is no filter that would
		// return a row — the request is refused rather than answered with [].
		await request(app.getHttpServer())
			.get("/runs/dispatchable")
			.set(USER_HEADER, IDS.member)
			.set(ROLE_HEADER, "member")
			.expect(403);
	});

	it("allows and stashes an ALWAYS_ALLOW plan", async () => {
		app = await createPlanApp();

		await request(app.getHttpServer())
			.get("/runs/dispatchable")
			.set(USER_HEADER, IDS.member)
			.set(ROLE_HEADER, "admin")
			.expect(200, { kind: "ALWAYS_ALLOW" });
	});

	it("infers the plan's resource type from the action when none is declared", async () => {
		app = await createPlanApp();

		await request(app.getHttpServer())
			.get("/runs/inferred")
			.set(USER_HEADER, IDS.member)
			.expect(200, { kind: "CONDITIONAL", type: "Run" });
	});

	it("serves planFor() and can() from the request's own principal graph", async () => {
		app = await createPlanApp();

		const response = await request(app.getHttpServer())
			.get("/runs/both")
			.set(USER_HEADER, IDS.member)
			.set(ROLE_HEADER, "admin")
			.expect(200);

		expect(response.body).toEqual({
			runs: "CONDITIONAL",
			dispatch: "ALWAYS_ALLOW",
			// `can` asks about a concrete run that is not in the request's graph, so
			// Cedar sees it attribute-less and the conditional permit cannot hold.
			can: false,
		});
	});
});
