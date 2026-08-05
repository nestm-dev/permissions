import "reflect-metadata";
import { Controller, Get, Injectable, Module } from "@nestjs/common";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import type { INestApplication } from "@nestjs/common";
import type { EntityGraph } from "@nestm/permissions-core";

import {
	CurrentAuthorization,
	CurrentPrincipal,
	EntityProvider,
	Public,
	RequireAuthenticated,
	RequirePermission,
	type FeatureEntityProvider,
	type RequestAuthorization,
	type ResolvedPrincipal,
	type RouteContextBuilderContext,
	type SeedLink,
	type SeedPolicy,
	type StandardSchemaV1,
} from "../../src/index.ts";
import { createTestApp } from "../shared/test-app.ts";
import { testHttpAdapter } from "../shared/http-adapter.ts";
import { HeaderPrincipalResolver, ROLE_HEADER, USER_HEADER } from "../shared/test-principal.ts";
import {
	IDS,
	SEED_POLICIES,
	TEST_SCOPE,
	runGraph,
	testVocabulary,
} from "../shared/test-vocabulary.ts";

/**
 * A Standard Schema v1 validator with no dependency: the spec is structural, so
 * this is exactly what a Zod branded id schema looks like to the guard.
 */
const runIdSchema: StandardSchemaV1<unknown, string> = {
	"~standard": {
		version: 1,
		vendor: "test",
		validate: (value) =>
			typeof value === "string" && value.startsWith("run-")
				? { value }
				: { issues: [{ message: 'A run id must start with "run-".' }] },
	},
};

/** A template granting one member management of one project, applied by a link. */
const TEMPLATE_POLICIES: readonly SeedPolicy[] = [
	...SEED_POLICIES,
	{
		id: "project-grant",
		scope: TEST_SCOPE,
		text: `permit(
			principal == ?principal,
			action == Test::Action::"project:manage",
			resource == ?resource
		);`,
	},
];

const TEMPLATE_LINKS: readonly SeedLink[] = [
	{
		id: "project-grant:member-1",
		scope: TEST_SCOPE,
		templateId: "project-grant",
		values: {
			"?principal": { type: "Member", id: IDS.member },
			"?resource": { type: "Project", id: IDS.project },
		},
	},
];

@EntityProvider()
@Injectable()
class RunEntityProvider implements FeatureEntityProvider {
	resolveResource(): EntityGraph {
		return runGraph();
	}
}

@Module({ providers: [RunEntityProvider], exports: [RunEntityProvider] })
class RunModule {}

@Controller("runs")
class RunsController {
	/** Literal reference: the resource is fixed, nothing is read from the URL. */
	@Get("fixed")
	@RequirePermission("run:read", { kind: "literal", type: "Run", id: IDS.run })
	fixed(@CurrentPrincipal() principal: ResolvedPrincipal): { principal: string } {
		return { principal: principal.ref.id };
	}

	/** The same route for an action only admins hold. */
	@Get("fixed-dispatch")
	@RequirePermission("run:dispatch", { kind: "literal", type: "Run", id: IDS.run })
	dispatch(): { ok: true } {
		return { ok: true };
	}

	/** Param reference, validated in the guard because pipes have not run yet. */
	@Get("by-id/:runId")
	@RequirePermission("run:read", {
		kind: "param",
		param: "runId",
		type: "Run",
		parseAs: runIdSchema,
	})
	byId(@CurrentAuthorization() authorization: RequestAuthorization): {
		resource: string | undefined;
		scope: string;
	} {
		return { resource: authorization.resource?.id, scope: authorization.scope };
	}

	/** Resolver reference: anything the request carries. */
	@Get("resolved")
	@RequirePermission("run:read", {
		kind: "resolver",
		resolve: () => ({ type: "Run", id: IDS.run }),
	})
	resolved(): { ok: true } {
		return { ok: true };
	}

	/** Authenticated is enough — no Cedar decision at all. */
	@Get("me")
	@RequireAuthenticated()
	me(@CurrentAuthorization() authorization: RequestAuthorization): {
		principal: string;
		route: boolean;
	} {
		return { principal: authorization.principal.ref.id, route: authorization.route !== undefined };
	}

	@Get("open")
	@Public()
	open(): { ok: true } {
		return { ok: true };
	}

	/** No declaration at all. */
	@Get("undeclared")
	undeclared(): { ok: true } {
		return { ok: true };
	}
}

@Controller("projects")
@RequirePermission("project:manage", { kind: "literal", type: "Project", id: IDS.project })
class ProjectsController {
	@Get("managed")
	managed(): { ok: true } {
		return { ok: true };
	}
}

/**
 * A controller marked `@Public()` as a whole, with one handler that declares its
 * own requirement — the fail-closed override.
 */
@Controller("mixed")
@Public()
class MixedController {
	@Get("open")
	open(): { ok: true } {
		return { ok: true };
	}

	@Get("guarded")
	@RequirePermission("run:dispatch", { kind: "literal", type: "Run", id: IDS.run })
	guarded(): { ok: true } {
		return { ok: true };
	}
}

let app: INestApplication | undefined;

afterEach(async () => {
	await app?.close();
	app = undefined;
});

async function createGuardedApp(): Promise<INestApplication> {
	return createTestApp({
		forRoot: {
			vocabulary: testVocabulary,
			policies: TEMPLATE_POLICIES,
			links: TEMPLATE_LINKS,
			principalResolver: new HeaderPrincipalResolver(),
			scopeResolver: () => TEST_SCOPE,
		},
		metadata: {
			imports: [RunModule],
			controllers: [RunsController, ProjectsController, MixedController],
		},
	});
}

describe(`PermissionsGuard (${testHttpAdapter})`, () => {
	it("allows what the seeded policies permit and refuses what they do not", async () => {
		app = await createGuardedApp();

		// `members-may-read-runs` permits any member of the organisation.
		await request(app.getHttpServer())
			.get("/runs/fixed")
			.set(USER_HEADER, IDS.member)
			.set(ROLE_HEADER, "member")
			.expect(200, { principal: IDS.member });

		// `admins-may-dispatch-runs` additionally requires `principal.role`.
		await request(app.getHttpServer())
			.get("/runs/fixed-dispatch")
			.set(USER_HEADER, IDS.member)
			.set(ROLE_HEADER, "member")
			.expect(403);

		await request(app.getHttpServer())
			.get("/runs/fixed-dispatch")
			.set(USER_HEADER, IDS.member)
			.set(ROLE_HEADER, "admin")
			.expect(200, { ok: true });
	});

	it("honours a grant that exists only as a template link", async () => {
		app = await createGuardedApp();

		// The template itself grants nothing; the link is what names member-1.
		await request(app.getHttpServer())
			.get("/projects/managed")
			.set(USER_HEADER, IDS.member)
			.expect(200, { ok: true });

		await request(app.getHttpServer())
			.get("/projects/managed")
			.set(USER_HEADER, IDS.outsider)
			.expect(403);
	});

	it("resolves a param reference and validates it before any pipe runs", async () => {
		app = await createGuardedApp();

		await request(app.getHttpServer())
			.get(`/runs/by-id/${IDS.run}`)
			.set(USER_HEADER, IDS.member)
			.expect(200, { resource: IDS.run, scope: TEST_SCOPE });
	});

	it("answers 400 when a param reference fails its parseAs schema", async () => {
		app = await createGuardedApp();

		const response = await request(app.getHttpServer())
			.get("/runs/by-id/not-a-run")
			.set(USER_HEADER, IDS.member)
			.expect(400);

		expect(response.body).toMatchObject({ message: 'Invalid route parameter "runId".' });
	});

	it("resolves a resolver reference", async () => {
		app = await createGuardedApp();

		await request(app.getHttpServer())
			.get("/runs/resolved")
			.set(USER_HEADER, IDS.member)
			.expect(200, { ok: true });
	});

	it("passes the resolved authorization question to the module context builder", async () => {
		let rawRequest: unknown;
		let context: RouteContextBuilderContext | undefined;

		app = await createTestApp({
			forRoot: {
				vocabulary: testVocabulary,
				policies: TEMPLATE_POLICIES,
				links: TEMPLATE_LINKS,
				principalResolver: new HeaderPrincipalResolver(),
				scopeResolver: () => TEST_SCOPE,
				contextBuilder: (transportRequest, resolved) => {
					rawRequest = transportRequest;
					context = resolved;
					return {};
				},
			},
			metadata: {
				imports: [RunModule],
				controllers: [RunsController],
			},
		});

		await request(app.getHttpServer()).get("/runs/fixed").set(USER_HEADER, IDS.member).expect(200);

		expect(context).toMatchObject({
			action: "run:read",
			contextKind: "http",
			params: {},
			principal: { ref: { type: "Member", id: IDS.member } },
			route: expect.stringContaining("RunsController.fixed") as unknown,
			scope: TEST_SCOPE,
		});
		expect(context?.request).toBe(rawRequest);
	});

	it("serves a @RequireAuthenticated() route with no Cedar decision", async () => {
		app = await createGuardedApp();

		await request(app.getHttpServer())
			.get("/runs/me")
			.set(USER_HEADER, IDS.outsider)
			.expect(200, { principal: IDS.outsider, route: false });
	});

	it("answers 401 when no principal can be resolved", async () => {
		app = await createGuardedApp();

		await request(app.getHttpServer()).get("/runs/fixed").expect(401);
		await request(app.getHttpServer()).get("/runs/me").expect(401);
	});

	it("refuses an undeclared route with 403", async () => {
		app = await createGuardedApp();

		await request(app.getHttpServer())
			.get("/runs/undeclared")
			.set(USER_HEADER, IDS.member)
			.expect(403);
	});

	it("serves a @Public() route without touching the engine", async () => {
		app = await createGuardedApp();

		await request(app.getHttpServer()).get("/runs/open").expect(200, { ok: true });
		await request(app.getHttpServer()).get("/mixed/open").expect(200, { ok: true });
	});

	it("lets a handler-level @RequirePermission beat a class-level @Public", async () => {
		app = await createGuardedApp();

		// Same controller, same class-level @Public(): the declared handler is
		// still enforced, and still 401 without a principal.
		await request(app.getHttpServer()).get("/mixed/guarded").expect(401);
		await request(app.getHttpServer())
			.get("/mixed/guarded")
			.set(USER_HEADER, IDS.member)
			.set(ROLE_HEADER, "member")
			.expect(403);
		await request(app.getHttpServer())
			.get("/mixed/guarded")
			.set(USER_HEADER, IDS.member)
			.set(ROLE_HEADER, "admin")
			.expect(200, { ok: true });
	});

	it("answers 503 once the engine is disposed", async () => {
		app = await createGuardedApp();
		const server = app.getHttpServer();

		await request(server).get("/runs/fixed").set(USER_HEADER, IDS.member).expect(200);

		// `close()` disposes the engine through PolicySetManager's shutdown hook.
		// The HTTP server outlives it here only because the test holds the handle.
		await app.close();
		app = undefined;

		// A disposed engine must answer 503, never a silent deny and never a 200.
		await request(server).get("/runs/fixed").set(USER_HEADER, IDS.member).expect(503);
	});

	it("answers 500, not a DI crash, when no principal resolver is configured", async () => {
		app = await createTestApp({
			forRoot: { vocabulary: testVocabulary, policies: SEED_POLICIES },
			metadata: { controllers: [RunsController] },
		});

		const response = await request(app.getHttpServer())
			.get("/runs/fixed")
			.set(USER_HEADER, IDS.member)
			.expect(500);

		expect(String(response.body.message)).toContain("principalResolver");
	});
});
