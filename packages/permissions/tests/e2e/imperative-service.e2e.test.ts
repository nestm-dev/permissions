import "reflect-metadata";
import { afterEach, describe, expect, it } from "vitest";
import type { INestApplication } from "@nestjs/common";

import {
	PermissionsService,
	type PermissionsCheckRequest,
	type PermissionsPlanRequest,
	type SeedPolicy,
} from "../../src/index.ts";
import { createTestApp } from "../shared/test-app.ts";
import { testHttpAdapter } from "../shared/http-adapter.ts";
import {
	IDS,
	SEED_POLICIES,
	TEST_SCOPE,
	memberGraph,
	runGraph,
	testVocabulary,
} from "../shared/test-vocabulary.ts";

const CONDITIONAL_POLICIES: readonly SeedPolicy[] = [
	{
		id: "members-may-read-queued-runs",
		scope: TEST_SCOPE,
		text: `permit(
			principal in Test::Organization::"${IDS.organization}",
			action == Test::Action::"run:read",
			resource
		) when { resource.status == "queued" };`,
	},
];

const principalEntities = memberGraph(IDS.member, "member");
const entities = [...principalEntities, ...runGraph()];

const readRun = {
	scope: TEST_SCOPE,
	principal: { type: "Member", id: IDS.member },
	action: "run:read",
	resource: { type: "Run", id: IDS.run },
	entities,
} as PermissionsCheckRequest;

const planRuns = {
	scope: TEST_SCOPE,
	principal: { type: "Member", id: IDS.member },
	action: "run:read",
	resourceType: "Run",
	entities: principalEntities,
} as PermissionsPlanRequest;

let app: INestApplication | undefined;

afterEach(async () => {
	await app?.close();
	app = undefined;
});

describe(`PermissionsService (${testHttpAdapter})`, () => {
	it("checks, throws and batches without any route involved", async () => {
		app = await createTestApp({
			forRoot: { vocabulary: testVocabulary, policies: SEED_POLICIES },
		});
		const permissions = app.get(PermissionsService);

		await expect(permissions.check(readRun)).resolves.toMatchObject({ allowed: true });
		await expect(permissions.checkOrThrow(readRun)).resolves.toMatchObject({ allowed: true });
		await expect(
			permissions.checkOrThrow({ ...readRun, action: "run:dispatch" } as PermissionsCheckRequest),
		).rejects.toMatchObject({ status: 403 });
		await expect(
			permissions.checkMany([readRun, { ...readRun, action: "run:dispatch" }]),
		).resolves.toMatchObject([{ allowed: true }, { allowed: false }]);
	});

	it("plans over a type, returning the three-state plan uncollapsed", async () => {
		app = await createTestApp({
			forRoot: { vocabulary: testVocabulary, policies: CONDITIONAL_POLICIES },
		});
		const permissions = app.get(PermissionsService);

		const plan = await permissions.plan(planRuns);

		expect(plan.kind).toBe("CONDITIONAL");
		expect(plan.resourceType).toBe("Run");
		expect(plan.approximations).toEqual([]);
		expect(plan.kind === "CONDITIONAL" && plan.condition).toEqual({
			op: "cmp",
			cmp: "eq",
			attr: { root: "resource", path: ["status"] },
			value: { kind: "string", value: "queued" },
		});
	});

	it("plans ALWAYS_DENY for an action the principal cannot hold", async () => {
		app = await createTestApp({
			forRoot: { vocabulary: testVocabulary, policies: SEED_POLICIES },
		});

		await expect(
			app.get(PermissionsService).plan({
				...planRuns,
				action: "run:dispatch",
			} as PermissionsPlanRequest),
		).resolves.toMatchObject({ kind: "ALWAYS_DENY", resourceType: "Run" });
	});

	it("refuses to plan once the engine is disposed", async () => {
		const closing = await createTestApp({
			forRoot: { vocabulary: testVocabulary, policies: SEED_POLICIES },
		});
		const permissions = closing.get(PermissionsService);
		await closing.close();

		// 503, never a plan compiled from no policies.
		await expect(permissions.plan(planRuns)).rejects.toMatchObject({ status: 503 });
	});
});
