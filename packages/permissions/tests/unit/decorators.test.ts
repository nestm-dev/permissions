/* oxlint-disable typescript/unbound-method -- reading metadata off a prototype method is exactly what a Reflector does */
import "reflect-metadata";
import { Controller, Get } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { describe, expect, it } from "vitest";

import {
	METADATA_KEY,
	Public,
	RequireAuthenticated,
	RequirePermission,
	type RoutePermission,
} from "../../src/index.ts";
import { IDS } from "../shared/test-vocabulary.ts";

const reflector = new Reflector();

function routePermissionOf(target: object | Function): RoutePermission | undefined {
	return reflector.get<RoutePermission | undefined>(
		METADATA_KEY.requirePermission,
		target as never,
	);
}

@Controller("runs")
@RequirePermission("run:read", { kind: "unspecified", type: "Run" })
class DecoratedController {
	@Get(":runId")
	@RequirePermission(
		"run:dispatch",
		{ kind: "param", param: "runId", type: "Run" },
		{
			onDeny: "not-found",
			scopeFrom: { kind: "param", param: "organizationId", prefix: "org:" },
			scope: {
				action: "run:read",
				resource: { kind: "literal", type: "Run", id: IDS.run },
			},
		},
	)
	dispatch(): void {}

	@Get("open")
	@Public()
	open(): void {}

	@Get("me")
	@RequireAuthenticated()
	me(): void {}

	@Get("inherited")
	inherited(): void {}
}

describe("@RequirePermission", () => {
	it("writes its metadata on the reserved key", () => {
		expect(RequirePermission.KEY).toBe(METADATA_KEY.requirePermission);
	});

	it("carries the action, the resource reference and the options", () => {
		const metadata = routePermissionOf(DecoratedController.prototype.dispatch);

		expect(metadata).toEqual({
			action: "run:dispatch",
			resource: { kind: "param", param: "runId", type: "Run" },
			options: {
				onDeny: "not-found",
				scopeFrom: { kind: "param", param: "organizationId", prefix: "org:" },
				scope: { action: "run:read", resource: { kind: "literal", type: "Run", id: IDS.run } },
			},
		});
	});

	it("applies to a whole controller, and the handler's own declaration wins", () => {
		expect(routePermissionOf(DecoratedController)?.action).toBe("run:read");
		expect(
			reflector.getAllAndOverride<RoutePermission>(METADATA_KEY.requirePermission, [
				DecoratedController.prototype.dispatch,
				DecoratedController,
			]).action,
		).toBe("run:dispatch");
		// A handler with no declaration of its own inherits the controller's.
		expect(
			reflector.getAllAndOverride<RoutePermission>(METADATA_KEY.requirePermission, [
				DecoratedController.prototype.inherited,
				DecoratedController,
			]).action,
		).toBe("run:read");
	});

	it("normalises an omitted options object", () => {
		class Bare {
			@RequirePermission("run:read")
			list(): void {}
		}

		expect(routePermissionOf(Bare.prototype.list)).toEqual({
			action: "run:read",
			resource: undefined,
			options: {},
		});
	});

	it.each([
		["an empty action", () => RequirePermission("")],
		[
			"a param reference with no param",
			() => RequirePermission("run:read", { kind: "param", param: "", type: "Run" }),
		],
		[
			"a literal reference with no id",
			() => RequirePermission("run:read", { kind: "literal", type: "Run", id: "" }),
		],
		[
			"a resolver reference with no resolve function",
			// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- deliberately wrong
			() => RequirePermission("run:read", { kind: "resolver" } as never),
		],
		[
			"a parseAs that is not a Standard Schema",
			() =>
				RequirePermission("run:read", {
					kind: "param",
					param: "runId",
					type: "Run",
					// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- deliberately wrong
					parseAs: { parse: () => "x" } as never,
				}),
		],
		[
			"a scope gate with no action",
			() =>
				RequirePermission(
					"run:read",
					{ kind: "literal", type: "Run", id: "r" },
					{
						scope: { action: "", resource: { kind: "literal", type: "Run", id: "r" } },
					},
				),
		],
	])("throws at decoration time for %s", (_name, build) => {
		expect(build).toThrowError(TypeError);
	});
});

describe("@Public / @RequireAuthenticated", () => {
	it("write their own reserved keys", () => {
		expect(reflector.get(Public, DecoratedController.prototype.open)).toBe(true);
		expect(reflector.get(RequireAuthenticated, DecoratedController.prototype.me)).toBe(true);
		expect(Reflect.getMetadata(METADATA_KEY.public, DecoratedController.prototype.open)).toBe(true);
		expect(
			Reflect.getMetadata(METADATA_KEY.requireAuthenticated, DecoratedController.prototype.me),
		).toBe(true);
	});
});
