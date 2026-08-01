import "reflect-metadata";
import { Controller, Get, Logger, Post, SetMetadata } from "@nestjs/common";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { INestApplication } from "@nestjs/common";

import {
	Public,
	RequireAuthenticated,
	RequirePermission,
	RouteAuthorizationAudit,
	type RouteAuditOptions,
} from "../../src/index.ts";
import { createTestApp } from "../shared/test-app.ts";
import { testHttpAdapter } from "../shared/http-adapter.ts";
import { HeaderPrincipalResolver } from "../shared/test-principal.ts";
import { IDS, SEED_POLICIES, TEST_SCOPE, testVocabulary } from "../shared/test-vocabulary.ts";

/** An application's own pre-existing route-authz decorator — the migration seam. */
const LEGACY_PERMISSION = "legacy:route_permission";
const LegacyPermission = (permission: string): MethodDecorator =>
	SetMetadata(LEGACY_PERMISSION, permission);

@Controller("declared")
class DeclaredController {
	@Get(":runId")
	@RequirePermission("run:read", { kind: "param", param: "runId", type: "Run" })
	find(): void {}

	@Get()
	@Public()
	list(): void {}

	@Post("me")
	@RequireAuthenticated()
	me(): void {}

	/** Not a route handler — no path metadata, so the audit ignores it. */
	helper(): void {}
}

@Controller("organizations")
class UndeclaredController {
	@Get(":id")
	find(): void {}

	@Post()
	create(): void {}
}

@Controller("legacy")
class LegacyController {
	@Get()
	@LegacyPermission("runs.read")
	list(): void {}
}

/** A whole controller declared at the class level covers its handlers. */
@Controller("class-level")
@RequirePermission("run:read", { kind: "unspecified", type: "Run" })
class ClassLevelController {
	@Get()
	list(): void {}

	@Get("other")
	other(): void {}
}

let app: INestApplication | undefined;

afterEach(async () => {
	await app?.close();
	app = undefined;
});

async function createAuditApp(
	routeAudit: RouteAuditOptions,
	controllers: readonly Function[],
): Promise<INestApplication> {
	return createTestApp({
		forRoot: {
			vocabulary: testVocabulary,
			policies: SEED_POLICIES,
			principalResolver: new HeaderPrincipalResolver(),
			scopeResolver: () => TEST_SCOPE,
			routeAudit,
		},
		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- controllers are classes
		metadata: { controllers: controllers as never[] },
	});
}

describe(`route authorization audit (${testHttpAdapter})`, () => {
	it("does nothing at all when the mode is off (the default)", async () => {
		app = await createAuditApp({}, [UndeclaredController]);

		// The app boots; the audit is opt-in, and its scan never ran.
		expect(app.get(RouteAuthorizationAudit).auditOptions.mode).toBeUndefined();
	});

	it("refuses to boot in error mode when a route declares nothing", async () => {
		await expect(
			createAuditApp({ mode: "error" }, [DeclaredController, UndeclaredController]),
		).rejects.toThrowError(/Undeclared:/);
	});

	it("names the endpoint, not just the method, in its report", async () => {
		app = await createAuditApp({}, [DeclaredController, UndeclaredController]);

		const undeclared = app.get(RouteAuthorizationAudit).findUndeclaredRoutes();

		expect(undeclared.map((route) => route.label).toSorted()).toEqual([
			"GET /organizations/:id → UndeclaredController.find",
			"POST /organizations → UndeclaredController.create",
		]);
		expect(undeclared[0]).toMatchObject({
			controller: "UndeclaredController",
			httpMethod: expect.stringMatching(/GET|POST/),
			path: expect.stringContaining("/organizations"),
		});
	});

	it("boots and logs in warn mode", async () => {
		// Nest's Logger writes through its own transport, not `console`, so the
		// spy goes on the logger itself.
		const warn = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);

		app = await createAuditApp({ mode: "warn" }, [DeclaredController, UndeclaredController]);

		expect(
			warn.mock.calls.some(([message]) => String(message).includes("UndeclaredController.find")),
		).toBe(true);
		warn.mockRestore();
	});

	it("counts every recognised declaration, class-level included", async () => {
		app = await createAuditApp({ mode: "error" }, [DeclaredController, ClassLevelController]);

		expect(app.get(RouteAuthorizationAudit).findUndeclaredRoutes()).toEqual([]);
	});

	it("accepts a foreign metadata key through additionalMetadataKeys", async () => {
		await expect(createAuditApp({ mode: "error" }, [LegacyController])).rejects.toThrowError(
			/LegacyController.list/,
		);

		app = await createAuditApp({ mode: "error", additionalMetadataKeys: [LEGACY_PERMISSION] }, [
			LegacyController,
		]);

		expect(app.get(RouteAuthorizationAudit).findUndeclaredRoutes()).toEqual([]);
	});

	it("skips controllers listed in ignoreControllers, by class, name and pattern", async () => {
		for (const ignoreControllers of [
			[UndeclaredController],
			["UndeclaredController"],
			[/^Undeclared/],
		] as RouteAuditOptions["ignoreControllers"][]) {
			const scoped = await createAuditApp({ mode: "error", ignoreControllers }, [
				DeclaredController,
				UndeclaredController,
			]);

			expect(scoped.get(RouteAuthorizationAudit).findUndeclaredRoutes()).toEqual([]);
			await scoped.close();
		}
	});

	it("skips routes matching ignoreRoutes", async () => {
		app = await createAuditApp({ mode: "error", ignoreRoutes: [/^UndeclaredController\./] }, [
			DeclaredController,
			UndeclaredController,
		]);

		expect(app.get(RouteAuthorizationAudit).findUndeclaredRoutes()).toEqual([]);
	});

	it("still guards an undeclared route at request time", async () => {
		// The audit is a boot-time coverage report, not the enforcement: a route
		// that slips past it is still refused.
		app = await createAuditApp({ mode: "warn" }, [UndeclaredController]);
		const { default: request } = await import("supertest");

		await request(app.getHttpServer()).get(`/organizations/${IDS.organization}`).expect(403);
	});
});
