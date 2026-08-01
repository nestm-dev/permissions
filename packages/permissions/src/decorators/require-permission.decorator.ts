import { Reflector } from "@nestjs/core";
import type { CustomDecorator } from "@nestjs/common";

import { METADATA_KEY } from "../permissions.constants.ts";
import { isStandardSchema } from "../types/standard-schema.types.ts";
import type {
	ResourceRef,
	RoutePermission,
	RoutePermissionOptions,
} from "../interfaces/route-permission.interface.ts";
import type { ActionName } from "../types/permissions-registry.types.ts";

/**
 * The reflectable decorator underneath `@RequirePermission()`.
 *
 * Built with `Reflector.createDecorator` so it owns a real `KEY` and behaves
 * like every other Nest metadata decorator; the exported function wraps it only
 * to give the three-argument call shape, which `createDecorator`'s single
 * `opts` parameter cannot express.
 */
const routePermission = Reflector.createDecorator<RoutePermission, RoutePermission>({
	key: METADATA_KEY.requirePermission,
	transform: (value) => value,
});

function assertResourceRef(action: string, resource: ResourceRef): void {
	switch (resource.kind) {
		case "param": {
			if (typeof resource.param !== "string" || resource.param === "") {
				throw new TypeError(
					`@RequirePermission("${action}"): a { kind: "param" } resource needs a non-empty \`param\`.`,
				);
			}
			if (resource.parseAs !== undefined && !isStandardSchema(resource.parseAs)) {
				throw new TypeError(
					`@RequirePermission("${action}"): \`parseAs\` must be a Standard Schema v1 validator ` +
						"(zod 3.24+, valibot, arktype, …) — an object with a `~standard.validate` function.",
				);
			}
			break;
		}
		case "literal": {
			if (typeof resource.id !== "string" || resource.id === "") {
				throw new TypeError(
					`@RequirePermission("${action}"): a { kind: "literal" } resource needs a non-empty \`id\`.`,
				);
			}
			break;
		}
		case "resolver": {
			if (typeof resource.resolve !== "function") {
				throw new TypeError(
					`@RequirePermission("${action}"): a { kind: "resolver" } resource needs a \`resolve\` function.`,
				);
			}
			break;
		}
		case "unspecified": {
			break;
		}
		default: {
			throw new TypeError(
				`@RequirePermission("${action}"): unknown resource kind ` +
					`"${String((resource as { kind?: unknown }).kind)}".`,
			);
		}
	}

	// Widened before comparing: once `PermissionsTypeRegistry` is augmented,
	// `ResourceTypeName` is a literal union and `x === ""` is a *compile* error
	// ("no overlap") rather than the runtime guard it has to stay.
	if (resource.kind !== "resolver" && !isNonEmptyString(resource.type)) {
		throw new TypeError(
			`@RequirePermission("${action}"): the resource needs a \`type\` naming a vocabulary entity.`,
		);
	}
}

/** Runtime string check that survives an augmented, literal-union parameter type. */
function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value !== "";
}

/**
 * Declares what a route enforces.
 *
 * ```ts
 * // one row, id from the URL, validated before any pipe runs
 * @RequirePermission("run:read", { kind: "param", param: "runId", type: "Run", parseAs: runId })
 *
 * // a list: no resource is named, so the guard compiles a query plan instead
 * @RequirePermission("run:read", { kind: "unspecified", type: "Run" })
 *
 * // …which is also what omitting the resource means, when the action declares
 * // exactly one resource type
 * @RequirePermission("run:read")
 *
 * // membership gate first: a non-member gets 404, a member without the
 * // permission gets 403
 * @RequirePermission("project:manage", { kind: "param", param: "projectId", type: "Project" }, {
 *   scope: { action: "org:read", resource: { kind: "param", param: "orgId", type: "Organization" } },
 *   scopeFrom: { kind: "param", param: "orgId", prefix: "org:" },
 * })
 * ```
 *
 * Applies to a method or a whole controller; the handler's own declaration wins
 * over the class's, and beats an inherited `@Public()`.
 *
 * @throws `TypeError` at decoration time for a malformed resource reference —
 * a mistake in an authorization declaration should fail at import, not at the
 * first request that happens to hit the route.
 */
export function RequirePermission(
	action: ActionName,
	resource?: ResourceRef,
	options: RoutePermissionOptions = {},
): CustomDecorator {
	if (!isNonEmptyString(action)) {
		throw new TypeError("@RequirePermission() needs a non-empty action name.");
	}
	if (resource !== undefined) {
		assertResourceRef(action, resource);
	}
	if (options.scope !== undefined) {
		if (!isNonEmptyString(options.scope.action)) {
			throw new TypeError(
				`@RequirePermission("${action}"): \`scope.action\` must be a non-empty action name.`,
			);
		}
		assertResourceRef(action, options.scope.resource);
	}
	if (options.context !== undefined && typeof options.context !== "function") {
		throw new TypeError(`@RequirePermission("${action}"): \`context\` must be a function.`);
	}

	return routePermission({ action, resource, options });
}

/** Metadata key the guard and the boot-time audit read. */
RequirePermission.KEY = routePermission.KEY;
