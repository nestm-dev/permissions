import "reflect-metadata";
import { Controller, Get, HttpException, Injectable, Module } from "@nestjs/common";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import type { INestApplication } from "@nestjs/common";
import type { EntityGraph } from "@nestm/permissions-core";

import {
	EntityProvider,
	PermissionsModule,
	RequirePermission,
	type FeatureEntityProvider,
	type PermissionsDenial,
	type RouteDecisionRecord,
} from "../../src/index.ts";
import { createTestApp } from "../shared/test-app.ts";
import { testHttpAdapter } from "../shared/http-adapter.ts";
import {
	HeaderPrincipalResolver,
	OUTSIDER,
	ROLE_HEADER,
	USER_HEADER,
} from "../shared/test-principal.ts";
import {
	IDS,
	SEED_POLICIES,
	TEST_SCOPE,
	runGraph,
	testVocabulary,
} from "../shared/test-vocabulary.ts";

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
	/**
	 * The station shape: a membership gate first, then the action check. A
	 * non-member gets the not-found response; a member without the permission
	 * gets 403.
	 */
	@Get("gated")
	@RequirePermission(
		"run:dispatch",
		{ kind: "literal", type: "Run", id: IDS.run },
		{ scope: { action: "run:read", resource: { kind: "literal", type: "Run", id: IDS.run } } },
	)
	gated(): { ok: true } {
		return { ok: true };
	}

	/** Plain action check, no gate. */
	@Get("plain")
	@RequirePermission("run:dispatch", { kind: "literal", type: "Run", id: IDS.run })
	plain(): { ok: true } {
		return { ok: true };
	}

	/** Same check, but this route hides its existence from anyone refused. */
	@Get("hidden")
	@RequirePermission(
		"run:dispatch",
		{ kind: "literal", type: "Run", id: IDS.run },
		{ onDeny: "not-found" },
	)
	hidden(): { ok: true } {
		return { ok: true };
	}

	/** A gate on a route that also says `onDeny: "forbidden"` — the gate still wins. */
	@Get("gated-forbidden")
	@RequirePermission(
		"run:dispatch",
		{ kind: "literal", type: "Run", id: IDS.run },
		{
			onDeny: "forbidden",
			scope: { action: "run:read", resource: { kind: "literal", type: "Run", id: IDS.run } },
		},
	)
	gatedForbidden(): { ok: true } {
		return { ok: true };
	}

	@Get("undeclared")
	undeclared(): { ok: true } {
		return { ok: true };
	}
}

let app: INestApplication | undefined;

afterEach(async () => {
	await app?.close();
	app = undefined;
});

interface AppOverrides {
	denial?: Parameters<typeof PermissionsModule.forRoot>[0]["denial"];
	hooks?: Parameters<typeof PermissionsModule.forRoot>[0]["hooks"];
	/** Non-member policies: `run:read` is granted only to a different member. */
	restrictRead?: boolean;
}

async function createApp(overrides: AppOverrides = {}): Promise<INestApplication> {
	const policies = overrides.restrictRead
		? [
				{
					id: "only-member-1-may-read",
					scope: TEST_SCOPE,
					text: `permit(
						principal == Test::Member::"${IDS.member}",
						action == Test::Action::"run:read",
						resource
					);`,
				},
			]
		: SEED_POLICIES;

	return createTestApp({
		forRoot: {
			vocabulary: testVocabulary,
			policies,
			principalResolver: new HeaderPrincipalResolver(),
			scopeResolver: () => TEST_SCOPE,
			...(overrides.denial === undefined ? {} : { denial: overrides.denial }),
			...(overrides.hooks === undefined ? {} : { hooks: overrides.hooks }),
		},
		metadata: { imports: [RunModule], controllers: [RunsController] },
	});
}

describe(`denial strategy (${testHttpAdapter})`, () => {
	it("returns byte-identical bodies for an unknown scope and a non-member probe", async () => {
		// The property ADR-0014 exists for. Two *different* code paths reach the
		// not-found response — the principal resolver's NOT_IN_SCOPE arm and the
		// route's `scope` gate denying — and a caller must not be able to tell
		// them apart, byte for byte.
		app = await createApp({ restrictRead: true });

		const unknownScope = await request(app.getHttpServer())
			.get("/runs/gated")
			.set(USER_HEADER, OUTSIDER)
			.expect(404);

		const nonMemberProbe = await request(app.getHttpServer())
			.get("/runs/gated")
			.set(USER_HEADER, IDS.outsider)
			.expect(404);

		expect(nonMemberProbe.text).toBe(unknownScope.text);
		expect(nonMemberProbe.body).toEqual(unknownScope.body);
		expect(unknownScope.body).toMatchObject({ statusCode: 404, message: "Not Found" });
	});

	it("keeps 403 for a member who is simply not permitted", async () => {
		// The other half of the same rule: passing the gate and failing the action
		// is a 403, so the two are genuinely distinguishable *only* for members.
		app = await createApp();

		await request(app.getHttpServer())
			.get("/runs/gated")
			.set(USER_HEADER, IDS.member)
			.set(ROLE_HEADER, "member")
			.expect(403);
	});

	it("cannot be downgraded: the scope gate wins over onDeny: 'forbidden'", async () => {
		app = await createApp({ restrictRead: true });

		await request(app.getHttpServer())
			.get("/runs/gated-forbidden")
			.set(USER_HEADER, IDS.outsider)
			.expect(404);
	});

	it("applies a route-level onDeny: 'not-found'", async () => {
		app = await createApp();

		await request(app.getHttpServer())
			.get("/runs/plain")
			.set(USER_HEADER, IDS.member)
			.set(ROLE_HEADER, "member")
			.expect(403);

		await request(app.getHttpServer())
			.get("/runs/hidden")
			.set(USER_HEADER, IDS.member)
			.set(ROLE_HEADER, "member")
			.expect(404);
	});

	it("applies the module-level denial.default, and lets a route override it", async () => {
		app = await createApp({ denial: { default: "not-found" } });

		// Module default turns an ordinary denial into the not-found response…
		await request(app.getHttpServer())
			.get("/runs/plain")
			.set(USER_HEADER, IDS.member)
			.set(ROLE_HEADER, "member")
			.expect(404);
		// …and an undeclared route follows the same default.
		await request(app.getHttpServer())
			.get("/runs/undeclared")
			.set(USER_HEADER, IDS.member)
			.expect(404);

		await app.close();
		app = await createApp({ denial: { default: "forbidden" } });

		await request(app.getHttpServer())
			.get("/runs/hidden")
			.set(USER_HEADER, IDS.member)
			.set(ROLE_HEADER, "member")
			.expect(404);
	});

	it("uses denial.notFoundStatus for every not-found path", async () => {
		app = await createApp({ restrictRead: true, denial: { notFoundStatus: 410 } });

		const gone = await request(app.getHttpServer())
			.get("/runs/gated")
			.set(USER_HEADER, IDS.outsider)
			.expect(410);

		expect(gone.body).toEqual({ statusCode: 410, message: "Not Found", error: "Not Found" });
	});

	it("lets hooks.onDenied own the response entirely", async () => {
		const seen: PermissionsDenial[] = [];
		app = await createApp({
			hooks: {
				onDenied: (denial) => {
					seen.push(denial);
					// Station returns its RFC 9457 exception here.
					return new HttpException(
						{ type: "https://example.test/forbidden", title: "Nope", status: 418 },
						418,
					);
				},
			},
		});

		const response = await request(app.getHttpServer())
			.get("/runs/plain")
			.set(USER_HEADER, IDS.member)
			.set(ROLE_HEADER, "member")
			.expect(418);

		expect(response.body).toMatchObject({ title: "Nope" });
		expect(seen.map((denial) => denial.reason)).toEqual(["forbidden"]);
	});

	it("gives hooks.onDenied the denial reason for each path", async () => {
		const seen: string[] = [];
		app = await createApp({
			restrictRead: true,
			hooks: {
				onDenied: (denial) => {
					seen.push(denial.reason);
				},
			},
		});

		await request(app.getHttpServer()).get("/runs/plain").expect(401);
		await request(app.getHttpServer())
			.get("/runs/undeclared")
			.set(USER_HEADER, IDS.member)
			.expect(403);
		await request(app.getHttpServer()).get("/runs/gated").set(USER_HEADER, OUTSIDER).expect(404);
		await request(app.getHttpServer())
			.get("/runs/gated")
			.set(USER_HEADER, IDS.outsider)
			.expect(404);

		expect(seen).toEqual(["unauthenticated", "undeclared-route", "not-in-scope", "not-a-member"]);
	});

	it("lets denial.onUndeclaredRoute: 'allow' through", async () => {
		app = await createApp({ denial: { onUndeclaredRoute: "allow" } });

		await request(app.getHttpServer()).get("/runs/undeclared").expect(200, { ok: true });
		// Nothing else changes: a declared route is still enforced.
		await request(app.getHttpServer())
			.get("/runs/plain")
			.set(USER_HEADER, IDS.member)
			.set(ROLE_HEADER, "member")
			.expect(403);
	});

	it("records every decision through hooks.onDecision, allow and deny alike", async () => {
		const records: RouteDecisionRecord[] = [];
		app = await createApp({
			hooks: {
				onDecision: (record) => {
					records.push(record);
				},
			},
		});

		await request(app.getHttpServer())
			.get("/runs/plain")
			.set(USER_HEADER, IDS.member)
			.set(ROLE_HEADER, "admin")
			.expect(200);
		await request(app.getHttpServer())
			.get("/runs/plain")
			.set(USER_HEADER, IDS.member)
			.set(ROLE_HEADER, "member")
			.expect(403);

		expect(records).toHaveLength(2);
		expect(records[0]).toMatchObject({
			allowed: true,
			action: "run:dispatch",
			scope: TEST_SCOPE,
			route: "RunsController.plain",
			resource: { type: "Run", id: IDS.run },
			denial: undefined,
		});
		expect(records[0]?.result?.allowed).toBe(true);
		expect(records[1]).toMatchObject({ allowed: false, denial: { reason: "forbidden" } });
	});

	it("never lets a throwing hooks.onDecision fail the request", async () => {
		app = await createApp({
			hooks: {
				onDecision: () => {
					throw new Error("audit sink is down");
				},
			},
		});

		await request(app.getHttpServer())
			.get("/runs/plain")
			.set(USER_HEADER, IDS.member)
			.set(ROLE_HEADER, "admin")
			.expect(200, { ok: true });
	});
});
