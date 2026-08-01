import "reflect-metadata";
import { describe, expect, it } from "vitest";

import {
	ResourceParamError,
	RoutePermissionConfigurationError,
	inferResourceRef,
	parseRouteParam,
	resolveResourceRef,
	resolveScopeSource,
} from "../../src/index.ts";
import type {
	ResourceResolutionContext,
	RouteResolutionContext,
	StandardSchemaV1,
} from "../../src/index.ts";
import { IDS, testVocabulary } from "../shared/test-vocabulary.ts";

/** A Standard Schema v1 validator, hand-written — the spec is structural. */
function uuidSchema(): StandardSchemaV1<unknown, string> {
	return {
		"~standard": {
			version: 1,
			vendor: "test",
			validate: (value) =>
				typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}$/.test(value)
					? { value }
					: { issues: [{ message: "Expected a short uuid." }] },
		},
	};
}

/** A schema whose output is not a string, to prove the id conversion rule. */
function objectSchema(): StandardSchemaV1<unknown, { id: string }> {
	return {
		"~standard": {
			version: 1,
			vendor: "test",
			validate: () => ({ value: { id: "nope" } }),
		},
	};
}

function routeContext(params: Record<string, unknown> = {}): RouteResolutionContext {
	return {
		request: { params },
		contextKind: "http",
		params,
		route: "RunsController.find",
		action: "run:read",
		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the pure resolvers never touch it
		executionContext: {} as RouteResolutionContext["executionContext"],
	};
}

function resourceContext(params: Record<string, unknown> = {}): ResourceResolutionContext {
	return {
		...routeContext(params),
		action: "run:read",
		scope: "org:acme",
		principal: { ref: { type: "Member", id: IDS.member }, entities: [] },
	};
}

describe("parseRouteParam", () => {
	it("passes a raw string through when no schema is declared", async () => {
		await expect(parseRouteParam("runId", "run-1")).resolves.toBe("run-1");
	});

	it("stringifies a numeric parameter", async () => {
		await expect(parseRouteParam("runId", 42)).resolves.toBe("42");
	});

	it.each([undefined, null, ""])("rejects the missing value %s", async (value) => {
		await expect(parseRouteParam("runId", value)).rejects.toBeInstanceOf(ResourceParamError);
	});

	it("accepts a value its Standard Schema validates", async () => {
		await expect(parseRouteParam("orgId", "8f3e1a2b-4c5d", uuidSchema())).resolves.toBe(
			"8f3e1a2b-4c5d",
		);
	});

	it("rejects a value its Standard Schema refuses, carrying the issues", async () => {
		const error = await parseRouteParam("orgId", "../etc/passwd", uuidSchema()).catch(
			(caught: unknown) => caught,
		);

		expect(error).toBeInstanceOf(ResourceParamError);
		expect((error as ResourceParamError).param).toBe("orgId");
		expect((error as ResourceParamError).issues).toEqual(["Expected a short uuid."]);
	});

	it("refuses a schema output that is not usable as an entity id", async () => {
		// A configuration error, not a 400: the caller sent a fine value and the
		// declaration is what is wrong.
		await expect(parseRouteParam("orgId", "x", objectSchema())).rejects.toBeInstanceOf(
			RoutePermissionConfigurationError,
		);
	});
});

describe("resolveResourceRef", () => {
	it("resolves a literal", async () => {
		await expect(
			resolveResourceRef({ kind: "literal", type: "Run", id: IDS.run }, resourceContext()),
		).resolves.toEqual({ type: "Run", id: IDS.run });
	});

	it("resolves a param", async () => {
		await expect(
			resolveResourceRef(
				{ kind: "param", param: "runId", type: "Run" },
				resourceContext({ runId: IDS.run }),
			),
		).resolves.toEqual({ type: "Run", id: IDS.run });
	});

	it("resolves a resolver, which is told the principal and the scope", async () => {
		const seen: string[] = [];

		await expect(
			resolveResourceRef(
				{
					kind: "resolver",
					resolve: (context) => {
						seen.push(context.scope, context.principal.ref.id);
						return { type: "Run", id: IDS.run };
					},
				},
				resourceContext(),
			),
		).resolves.toEqual({ type: "Run", id: IDS.run });
		expect(seen).toEqual(["org:acme", IDS.member]);
	});

	it("refuses a resolver that returns something other than an entity reference", async () => {
		await expect(
			resolveResourceRef(
				// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- deliberately wrong
				{ kind: "resolver", resolve: () => ({ id: "run-1" }) as never },
				resourceContext(),
			),
		).rejects.toBeInstanceOf(RoutePermissionConfigurationError);
	});

	it("refuses a param reference on a transport with no route parameters", async () => {
		for (const contextKind of ["ws", "rpc"] as const) {
			await expect(
				resolveResourceRef(
					{ kind: "param", param: "runId", type: "Run" },
					{ ...resourceContext({ runId: IDS.run }), contextKind },
				),
			).rejects.toBeInstanceOf(RoutePermissionConfigurationError);
		}
	});

	it("refuses to resolve an unspecified reference as a concrete entity", async () => {
		await expect(
			resolveResourceRef({ kind: "unspecified", type: "Run" }, resourceContext()),
		).rejects.toBeInstanceOf(RoutePermissionConfigurationError);
	});
});

describe("resolveScopeSource", () => {
	it("returns undefined when the route declared no source", async () => {
		await expect(resolveScopeSource(undefined, routeContext())).resolves.toBeUndefined();
	});

	it("returns undefined for { kind: 'resolver' }, which defers to the module option", async () => {
		await expect(resolveScopeSource({ kind: "resolver" }, routeContext())).resolves.toBeUndefined();
	});

	it("returns a literal scope", async () => {
		await expect(
			resolveScopeSource({ kind: "literal", scope: "org:acme" }, routeContext()),
		).resolves.toBe("org:acme");
	});

	it("prefixes a route parameter — the station shape", async () => {
		await expect(
			resolveScopeSource(
				{ kind: "param", param: "organizationId", prefix: "org:" },
				routeContext({ organizationId: "acme" }),
			),
		).resolves.toBe("org:acme");
	});

	it("uses the bare parameter when no prefix is declared", async () => {
		await expect(
			resolveScopeSource({ kind: "param", param: "tenant" }, routeContext({ tenant: "acme" })),
		).resolves.toBe("acme");
	});

	it("rejects a missing scope parameter", async () => {
		await expect(
			resolveScopeSource({ kind: "param", param: "organizationId" }, routeContext()),
		).rejects.toBeInstanceOf(ResourceParamError);
	});

	it("rejects an empty or non-string scope parameter", async () => {
		// The three shapes the guard turns into an `invalid-scope` denial — a 400,
		// raised before the principal is resolved. An empty tenant segment is the one
		// that matters: `""` is a legal `PolicyScopeId` (it is the *global* scope), so
		// letting it through would silently widen a tenant request to every tenant's
		// policies rather than failing.
		for (const value of ["", 42, null]) {
			await expect(
				resolveScopeSource(
					{ kind: "param", param: "organizationId", prefix: "org:" },
					routeContext({ organizationId: value }),
				),
				JSON.stringify(value),
			).rejects.toBeInstanceOf(ResourceParamError);
		}
	});

	it("carries an issue message the denial hook can surface", async () => {
		const error = await resolveScopeSource(
			{ kind: "param", param: "organizationId" },
			routeContext(),
		).catch((caught: unknown) => caught);

		expect(error).toBeInstanceOf(ResourceParamError);
		expect((error as ResourceParamError).issues.length).toBeGreaterThan(0);
		expect((error as ResourceParamError).param).toBe("organizationId");
	});

	it("refuses a param source on a transport with no route parameters", async () => {
		await expect(
			resolveScopeSource(
				{ kind: "param", param: "organizationId" },
				{
					...routeContext({ organizationId: "acme" }),
					contextKind: "rpc",
				},
			),
		).rejects.toBeInstanceOf(RoutePermissionConfigurationError);
	});
});

describe("inferResourceRef", () => {
	it("infers the query-plan reference from an action's single resource type", () => {
		expect(inferResourceRef(testVocabulary, "run:read")).toEqual({
			kind: "unspecified",
			type: "Run",
		});
	});

	it("refuses to guess for an unknown action", () => {
		expect(() => inferResourceRef(testVocabulary, "nope:nope")).toThrowError(
			RoutePermissionConfigurationError,
		);
	});
});
