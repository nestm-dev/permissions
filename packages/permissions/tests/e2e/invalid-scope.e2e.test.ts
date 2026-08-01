// A scope that cannot be derived is a 400, and it is a 400 *first*.
//
// The guard resolves the scope before the principal, because the principal
// resolver is told which scope it is being asked about. That ordering is what
// makes this a contract rather than an implementation detail: a request carrying
// both a malformed tenant parameter and an unusable credential is a 400, never a
// 401. If it were the other way round, a caller could tell "this tenant id is
// malformed" from "this tenant id is fine but you are not in it" by watching the
// status change with the credential — the oracle the not-found path exists to
// close.
//
// Before `denial.onInvalidScope`, a `scopeResolver` that wanted to reject a
// malformed tenant parameter could only throw and hope: an unrecognised throw
// escaped the guard as a 500.

import "reflect-metadata";
import { BadRequestException, Controller, Get, Injectable, Module } from "@nestjs/common";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import type { INestApplication } from "@nestjs/common";
import type { EntityGraph } from "@nestm/permissions-core";

import {
	EntityProvider,
	RequirePermission,
	type FeatureEntityProvider,
	type InvalidScopeContext,
	type PermissionsDenial,
	type PermissionsForRootOptions,
	type RouteDecisionRecord,
} from "../../src/index.ts";
import { testHttpAdapter } from "../shared/http-adapter.ts";
import { createTestApp } from "../shared/test-app.ts";
import { HeaderPrincipalResolver, ROLE_HEADER, USER_HEADER } from "../shared/test-principal.ts";
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

@Controller("orgs")
class OrgsController {
	/** `scopeFrom: { kind: "param" }` — the tenant id is in the URL. */
	@Get(":org/runs")
	@RequirePermission(
		"run:dispatch",
		{ kind: "literal", type: "Run", id: IDS.run },
		{
			scopeFrom: { kind: "param", param: "org", prefix: "org:" },
		},
	)
	listRuns(): { ok: true } {
		return { ok: true };
	}

	/** No `scopeFrom`, so the module-level `scopeResolver` answers. */
	@Get("runs")
	@RequirePermission("run:dispatch", { kind: "literal", type: "Run", id: IDS.run })
	resolverRuns(): { ok: true } {
		return { ok: true };
	}

	/**
	 * `scopeFrom` naming a parameter this route does not have.
	 *
	 * A misspelt param name is the realistic version of "the tenant parameter is
	 * missing", and unlike `/orgs//runs` it does not depend on how the router
	 * treats an empty path segment.
	 */
	@Get("typo")
	@RequirePermission(
		"run:dispatch",
		{ kind: "literal", type: "Run", id: IDS.run },
		{ scopeFrom: { kind: "param", param: "organization", prefix: "org:" } },
	)
	typo(): { ok: true } {
		return { ok: true };
	}

	/** `scopeFrom: { kind: "resolver" }` also defers to the module resolver. */
	@Get("deferred")
	@RequirePermission(
		"run:dispatch",
		{ kind: "literal", type: "Run", id: IDS.run },
		{
			scopeFrom: { kind: "resolver" },
		},
	)
	deferred(): { ok: true } {
		return { ok: true };
	}
}

let app: INestApplication | undefined;

afterEach(async () => {
	await app?.close();
	app = undefined;
});

interface Overrides {
	scopeResolver?: PermissionsForRootOptions["scopeResolver"];
	denial?: PermissionsForRootOptions["denial"];
	hooks?: PermissionsForRootOptions["hooks"];
}

async function createApp(overrides: Overrides = {}): Promise<INestApplication> {
	return createTestApp({
		forRoot: {
			vocabulary: testVocabulary,
			policies: SEED_POLICIES,
			principalResolver: new HeaderPrincipalResolver(),
			scopeResolver: overrides.scopeResolver ?? ((): string => TEST_SCOPE),
			...(overrides.denial === undefined ? {} : { denial: overrides.denial }),
			...(overrides.hooks === undefined ? {} : { hooks: overrides.hooks }),
		},
		metadata: { imports: [RunModule], controllers: [OrgsController] },
	});
}

const ADMIN = { user: IDS.member, role: "admin" } as const;

describe(`invalid scope (${testHttpAdapter})`, () => {
	it("allows the happy path, so the failures below are about the scope and nothing else", async () => {
		app = await createApp();

		await request(app.getHttpServer())
			.get(`/orgs/${IDS.organization}/runs`)
			.set(USER_HEADER, ADMIN.user)
			.set(ROLE_HEADER, ADMIN.role)
			.expect(200);
	});

	// -----------------------------------------------------------------------
	// scopeResolver
	// -----------------------------------------------------------------------

	it("turns a throwing scopeResolver into a 400, not a 500", async () => {
		app = await createApp({
			scopeResolver: () => {
				throw new TypeError("not an organization id");
			},
		});

		const response = await request(app.getHttpServer())
			.get("/orgs/runs")
			.set(USER_HEADER, ADMIN.user)
			.set(ROLE_HEADER, ADMIN.role)
			.expect(400);

		// The resolver's own message never reaches the body: a resolver throwing
		// "organization 8f3e… not found" would otherwise turn a 400 into an
		// existence oracle.
		expect(response.body).toMatchObject({ statusCode: 400 });
		expect(JSON.stringify(response.body)).not.toContain("not an organization id");
	});

	it("turns a rejecting async scopeResolver into a 400 too", async () => {
		app = await createApp({
			// eslint-disable-next-line @typescript-eslint/require-await
			scopeResolver: async () => {
				throw new Error("lookup failed");
			},
		});

		await request(app.getHttpServer())
			.get("/orgs/runs")
			.set(USER_HEADER, ADMIN.user)
			.set(ROLE_HEADER, ADMIN.role)
			.expect(400);
	});

	it("applies to scopeFrom: { kind: 'resolver' }, which defers to the same resolver", async () => {
		app = await createApp({
			scopeResolver: () => {
				throw new TypeError("nope");
			},
		});

		await request(app.getHttpServer())
			.get("/orgs/deferred")
			.set(USER_HEADER, ADMIN.user)
			.set(ROLE_HEADER, ADMIN.role)
			.expect(400);
	});

	// -----------------------------------------------------------------------
	// scopeFrom: { kind: "param" }
	// -----------------------------------------------------------------------

	it("is a 400 when the scope route parameter is missing", async () => {
		app = await createApp();

		await request(app.getHttpServer())
			.get("/orgs/typo")
			.set(USER_HEADER, ADMIN.user)
			.set(ROLE_HEADER, ADMIN.role)
			.expect(400);
	});

	// -----------------------------------------------------------------------
	// The ordering guarantee
	// -----------------------------------------------------------------------

	it("is a 400 even when the principal would ALSO be unresolvable", async () => {
		// The contract, and the reason it is one. No `x-test-user` header at all, so
		// the principal resolver returns `null` and would produce a 401 — but the
		// scope is resolved first, so the caller is told the request is malformed
		// rather than told anything about their credential.
		app = await createApp({
			scopeResolver: () => {
				throw new TypeError("malformed tenant");
			},
		});

		await request(app.getHttpServer()).get("/orgs/runs").expect(400);
	});

	it("is a 400 even when the principal would be NOT_IN_SCOPE", async () => {
		// The other unresolvable principal: the 404 path. A malformed scope still
		// wins, so the status cannot be used to probe membership.
		app = await createApp({
			scopeResolver: () => {
				throw new TypeError("malformed tenant");
			},
		});

		await request(app.getHttpServer()).get("/orgs/runs").set(USER_HEADER, "ghost").expect(400);
	});

	it("never calls the principal resolver at all", async () => {
		let resolverCalls = 0;
		const counting = new HeaderPrincipalResolver();
		const inner = counting.resolve.bind(counting);
		counting.resolve = (context): ReturnType<typeof inner> => {
			resolverCalls += 1;
			return inner(context);
		};

		app = await createTestApp({
			forRoot: {
				vocabulary: testVocabulary,
				policies: SEED_POLICIES,
				principalResolver: counting,
				scopeResolver: (): string => {
					throw new TypeError("malformed tenant");
				},
			},
			metadata: { imports: [RunModule], controllers: [OrgsController] },
		});

		await request(app.getHttpServer()).get("/orgs/runs").set(USER_HEADER, ADMIN.user).expect(400);

		expect(resolverCalls).toBe(0);
	});

	// -----------------------------------------------------------------------
	// denial.onInvalidScope
	// -----------------------------------------------------------------------

	it("lets denial.onInvalidScope own the response", async () => {
		const seen: { error: unknown; context: InvalidScopeContext }[] = [];

		app = await createApp({
			scopeResolver: () => {
				throw new TypeError("organization id must be a uuid");
			},
			denial: {
				onInvalidScope: (error, context) => {
					seen.push({ error, context });
					return new BadRequestException({
						type: "https://example.test/invalid-organization",
						title: "Invalid organization",
					});
				},
			},
		});

		const response = await request(app.getHttpServer())
			.get("/orgs/runs")
			.set(USER_HEADER, ADMIN.user)
			.expect(400);

		expect(response.body).toMatchObject({ title: "Invalid organization" });

		// The hook gets the raw throw — which is the whole point, since only the
		// application knows what its resolver throws.
		expect(seen).toHaveLength(1);
		const first = seen[0];
		expect(first).toBeDefined();
		expect(first?.error).toBeInstanceOf(TypeError);
		expect(String(first?.error)).toContain("organization id must be a uuid");
		expect(first?.context).toMatchObject({ source: "scopeResolver", param: undefined });
		expect(first?.context.route).toContain("OrgsController");
	});

	it("reports source: 'scopeFrom' and the parameter name for a route-derived scope", async () => {
		const seen: InvalidScopeContext[] = [];

		app = await createTestApp({
			forRoot: {
				vocabulary: testVocabulary,
				policies: SEED_POLICIES,
				principalResolver: new HeaderPrincipalResolver(),
				scopeResolver: (): string => TEST_SCOPE,
				denial: {
					onInvalidScope: (_error, context): void => {
						seen.push(context);
					},
				},
			},
			metadata: { imports: [RunModule], controllers: [OrgsController] },
		});

		await request(app.getHttpServer())
			.get("/orgs/typo")
			.set(USER_HEADER, ADMIN.user)
			.set(ROLE_HEADER, ADMIN.role)
			.expect(400);

		expect(seen).toHaveLength(1);
		expect(seen[0]).toMatchObject({ source: "scopeFrom", param: "organization" });
		expect(seen[0]?.issues.length).toBeGreaterThan(0);
		// The module-level `scopeResolver` is never consulted: the route declared a
		// `scopeFrom` and it failed, so falling through to the resolver would answer
		// a question the route had already answered badly.
		expect(seen[0]?.contextKind).toBe("http");
	});

	it("keeps the default 400 when the hook returns nothing", async () => {
		app = await createApp({
			scopeResolver: () => {
				throw new TypeError("nope");
			},
			denial: {
				onInvalidScope: (): void => undefined,
			},
		});

		await request(app.getHttpServer()).get("/orgs/runs").set(USER_HEADER, ADMIN.user).expect(400);
	});

	// -----------------------------------------------------------------------
	// The audit sink
	// -----------------------------------------------------------------------

	it("reaches hooks.onDenied and hooks.onDecision as `invalid-scope`", async () => {
		const denials: PermissionsDenial[] = [];
		const records: RouteDecisionRecord[] = [];

		app = await createApp({
			scopeResolver: () => {
				throw new TypeError("malformed tenant");
			},
			hooks: {
				onDenied: (denial): void => {
					denials.push(denial);
				},
				onDecision: (record): void => {
					records.push(record);
				},
			},
		});

		await request(app.getHttpServer()).get("/orgs/runs").set(USER_HEADER, ADMIN.user).expect(400);

		expect(denials).toHaveLength(1);
		expect(denials[0]).toMatchObject({ reason: "invalid-scope", source: "scopeResolver" });
		// The full error is on the denial — the audit sink is where the reason
		// belongs, precisely because the response is not.
		expect((denials[0] as { error: unknown }).error).toBeInstanceOf(TypeError);

		expect(records).toHaveLength(1);
		expect(records[0]).toMatchObject({ allowed: false });
		expect(records[0]?.denial).toMatchObject({ reason: "invalid-scope" });
		// No principal: the denial happened before one was resolved.
		expect(records[0]?.principal).toBeUndefined();
	});

	it("lets hooks.onDenied override even the hook-provided error", async () => {
		app = await createApp({
			scopeResolver: () => {
				throw new TypeError("nope");
			},
			denial: {
				onInvalidScope: (): Error => new BadRequestException("from onInvalidScope"),
			},
			hooks: {
				onDenied: (): Error => new BadRequestException("from onDenied"),
			},
		});

		const response = await request(app.getHttpServer())
			.get("/orgs/runs")
			.set(USER_HEADER, ADMIN.user)
			.expect(400);

		// `hooks.onDenied` is the outermost layer, as the denial-strategy docs say.
		expect(response.body).toMatchObject({ message: "from onDenied" });
	});
});
