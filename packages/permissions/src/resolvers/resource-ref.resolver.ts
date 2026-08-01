import type { AnyVocabulary, EntityRef, PolicyScopeId } from "@nestm/permissions-core";

import type {
	ResourceRef,
	ResourceResolutionContext,
	RouteResolutionContext,
	ScopeSource,
} from "../interfaces/route-permission.interface.ts";
import type { ResourceTypeName } from "../types/permissions-registry.types.ts";
import type { StandardSchemaV1 } from "../types/standard-schema.types.ts";

/**
 * A route parameter that did not survive its `parseAs` schema.
 *
 * Separate from a configuration error because the two have opposite audiences:
 * this one is the caller's fault (400), the other is the developer's (500).
 */
export class ResourceParamError extends Error {
	readonly param: string;
	readonly value: unknown;
	readonly issues: readonly string[];

	constructor(param: string, value: unknown, issues: readonly string[]) {
		super(`Route parameter "${param}" is not a valid resource identifier.`);
		this.name = "ResourceParamError";
		this.param = param;
		this.value = value;
		this.issues = issues;
	}
}

/** A route whose authorization declaration cannot be satisfied as written. */
export class RoutePermissionConfigurationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "RoutePermissionConfigurationError";
	}
}

function issueMessages(issues: readonly { message: string }[]): readonly string[] {
	return issues.map((issue) => issue.message);
}

/**
 * Turns a validated Standard Schema output into a Cedar entity id.
 *
 * Strings pass through; numbers and bigints are stringified, because an integer
 * id schema is a perfectly ordinary thing to declare and Cedar ids are strings.
 * Anything else is a configuration error rather than a `String(value)`, which
 * is how `[object Object]` ends up as an entity id.
 */
function toEntityId(param: string, value: unknown): string {
	if (typeof value === "string") {
		return value;
	}
	if (typeof value === "number" || typeof value === "bigint") {
		return String(value);
	}
	throw new RoutePermissionConfigurationError(
		`Route parameter "${param}": \`parseAs\` produced a ${typeof value}, but a Cedar entity id ` +
			"must be a string (or a number/bigint this package stringifies). Map the schema output " +
			'to the id yourself, or use { kind: "resolver" }.',
	);
}

/**
 * Validates one raw route parameter.
 *
 * Guards run **before pipes**, so this is the only place the value is checked
 * before it becomes an entity id. Without `parseAs` the raw string is used
 * as-is; the guard warns about that once per route.
 */
export async function parseRouteParam(
	param: string,
	value: unknown,
	parseAs?: StandardSchemaV1,
): Promise<string> {
	if (value === undefined || value === null || value === "") {
		throw new ResourceParamError(param, value, ["Required route parameter is missing."]);
	}

	if (parseAs === undefined) {
		if (typeof value === "string") {
			return value;
		}
		if (typeof value === "number" || typeof value === "bigint") {
			return String(value);
		}
		throw new ResourceParamError(param, value, [
			`Expected a string route parameter, received ${typeof value}.`,
		]);
	}

	const result = await parseAs["~standard"].validate(value);
	if (result.issues !== undefined) {
		throw new ResourceParamError(param, value, issueMessages(result.issues));
	}
	return toEntityId(param, result.value);
}

/**
 * Resolves a {@link ResourceRef} to the entity the check is about.
 *
 * `{ kind: "unspecified" }` never reaches here — it is the *absence* of a
 * resource and is handled by the guard's plan path.
 */
export async function resolveResourceRef(
	ref: ResourceRef,
	context: ResourceResolutionContext,
): Promise<EntityRef> {
	switch (ref.kind) {
		case "literal": {
			return { type: ref.type, id: ref.id };
		}
		case "param": {
			if (context.contextKind === "ws" || context.contextKind === "rpc") {
				throw new RoutePermissionConfigurationError(
					`${context.route}: a { kind: "param" } resource cannot be resolved on a ` +
						`${context.contextKind} transport — there are no route parameters there. ` +
						'Use { kind: "literal" } or { kind: "resolver" }.',
				);
			}
			const id = await parseRouteParam(ref.param, context.params[ref.param], ref.parseAs);
			return { type: ref.type, id };
		}
		case "resolver": {
			const resolved = await ref.resolve(context);
			if (
				typeof resolved !== "object" ||
				resolved === null ||
				typeof resolved.type !== "string" ||
				typeof resolved.id !== "string"
			) {
				throw new RoutePermissionConfigurationError(
					`${context.route}: the { kind: "resolver" } resource returned ` +
						`${JSON.stringify(resolved)}, expected { type, id }.`,
				);
			}
			return resolved;
		}
		case "unspecified": {
			throw new RoutePermissionConfigurationError(
				`${context.route}: { kind: "unspecified" } has no entity to resolve — it selects the ` +
					"query-plan path and must not be resolved as a concrete resource.",
			);
		}
	}
}

/**
 * Derives the scope a route declared, or `undefined` when it declared none.
 *
 * `{ kind: "resolver" }` returns `undefined` here on purpose: it means "ask the
 * module-level `scopeResolver`", and the guard owns that call so the resolver
 * runs exactly once whether or not a route opted into it explicitly.
 */
export async function resolveScopeSource(
	source: ScopeSource | undefined,
	context: RouteResolutionContext,
): Promise<PolicyScopeId | undefined> {
	if (source === undefined || source.kind === "resolver") {
		return undefined;
	}
	if (source.kind === "literal") {
		return source.scope;
	}

	if (context.contextKind === "ws" || context.contextKind === "rpc") {
		throw new RoutePermissionConfigurationError(
			`${context.route}: \`scopeFrom: { kind: "param" }\` cannot be resolved on a ` +
				`${context.contextKind} transport. Use { kind: "literal" } or the module-level ` +
				"`scopeResolver`.",
		);
	}

	const raw = context.params[source.param];
	if (typeof raw !== "string" || raw === "") {
		throw new ResourceParamError(source.param, raw, ["Required scope route parameter is missing."]);
	}
	return `${source.prefix ?? ""}${raw}`;
}

/**
 * The resource reference a bare `@RequirePermission("action")` means.
 *
 * An action declares which resource types it applies to, so when exactly one is
 * declared the intent is unambiguous: plan over that type. Zero or several is a
 * configuration error naming both the action and the fix — guessing there would
 * pick a type the policies never mention and quietly allow everything the
 * planner cannot constrain.
 */
export function inferResourceRef(vocabulary: AnyVocabulary, action: string): ResourceRef {
	const declared = vocabulary.def.actions[action]?.resource;
	const types = declared === undefined ? [] : [...declared];

	if (types.length !== 1) {
		throw new RoutePermissionConfigurationError(
			`@RequirePermission("${action}") named no resource, and the action declares ` +
				`${types.length === 0 ? "no resource type" : `${String(types.length)} resource types (${types.join(", ")})`}` +
				", so there is nothing to infer. Pass a resource reference explicitly.",
		);
	}

	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- `ResourceTypeName` is `string` unless the registry is augmented, and then this name is one of its members by construction
	return { kind: "unspecified", type: types[0] as ResourceTypeName };
}
