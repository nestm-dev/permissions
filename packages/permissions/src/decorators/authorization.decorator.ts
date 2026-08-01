import { ForbiddenException, createParamDecorator } from "@nestjs/common";
import type { ExecutionContext } from "@nestjs/common";
import type { QueryPlan as CoreQueryPlan } from "@nestm/permissions-core";

import { AUTHORIZATION_STATE } from "../permissions.constants.ts";
import { RequestAuthorization } from "../services/request-authorization.ts";
import { getRequestFromContextSync } from "../utils/execution-context.util.ts";
import type { ResolvedPrincipal } from "../interfaces/principal-resolver.interface.ts";

/** Options accepted by `@CurrentAuthorization()` and `@CurrentPrincipal()`. */
export interface CurrentAuthorizationOptions {
	/** Return `null` instead of throwing when the guard did not decide. */
	readonly optional?: boolean;
}

/**
 * Reads what the guard stashed, or `undefined` when it never ran.
 *
 * Exported because a custom decorator or an interceptor occasionally needs the
 * same lookup, and re-deriving the symbol key by hand is how the two drift.
 */
export function readAuthorization(context: ExecutionContext): RequestAuthorization | undefined {
	const request: unknown = getRequestFromContextSync(context);
	if (typeof request !== "object" || request === null) {
		return undefined;
	}
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the guard is what writes this symbol
	const state = (request as Record<symbol, unknown>)[AUTHORIZATION_STATE];
	return state instanceof RequestAuthorization ? state : undefined;
}

function requireAuthorization(
	context: ExecutionContext,
	options: CurrentAuthorizationOptions | undefined,
) {
	const authorization = readAuthorization(context);
	if (authorization !== undefined) {
		return authorization;
	}
	if (options?.optional === true) {
		return null;
	}
	// Station's precedent: absent authorization is 403, not 500. Either the route
	// is `@Public()` (so nothing decided and the handler must not assume one) or
	// the guard was disabled — both are "you may not have this", not "we crashed".
	throw new ForbiddenException(
		"No authorization state on this request. @CurrentAuthorization() requires a route guarded " +
			"by PermissionsGuard — a @Public() route has none. Use { optional: true } to receive null.",
	);
}

/**
 * The principal the guard resolved.
 *
 * ```ts
 * @Get(":runId")
 * @RequirePermission("run:read", { kind: "param", param: "runId", type: "Run" })
 * find(@CurrentPrincipal() principal: ResolvedPrincipal) {}
 * ```
 */
export const CurrentPrincipal = createParamDecorator(
	(
		options: CurrentAuthorizationOptions | undefined,
		context: ExecutionContext,
	): ResolvedPrincipal | null => {
		const authorization = requireAuthorization(context, options);
		return authorization === null ? null : authorization.principal;
	},
);

/**
 * Everything the guard decided about this request.
 *
 * Throws `ForbiddenException` when the guard did not run;
 * `@CurrentAuthorization({ optional: true })` yields `null` instead.
 */
export const CurrentAuthorization = createParamDecorator(
	(
		options: CurrentAuthorizationOptions | undefined,
		context: ExecutionContext,
	): RequestAuthorization | null => requireAuthorization(context, options),
);

/**
 * The query plan the guard precomputed for a `{ kind: "unspecified" }` route.
 *
 * ```ts
 * @Get()
 * @RequirePermission("run:read", { kind: "unspecified", type: "Run" })
 * list(@QueryPlan() plan: QueryPlan) {
 *   if (plan.kind === "ALWAYS_DENY") return [];
 *   return this.runs.list(plan.kind === "CONDITIONAL" ? compilePlan(plan, mapping) : undefined);
 * }
 * ```
 *
 * `undefined` on a route that did not declare an unspecified resource — with
 * `{ optional: true }`, also on a route the guard never decided.
 */
export const QueryPlan = createParamDecorator(
	(
		options: CurrentAuthorizationOptions | undefined,
		context: ExecutionContext,
	): CoreQueryPlan | undefined => {
		const authorization = requireAuthorization(context, options);
		return authorization === null ? undefined : authorization.plan;
	},
);

/**
 * Core's three-state query plan.
 *
 * Re-exported from this module rather than the barrel's core block so that the
 * name carries **both** meanings: `QueryPlan` the parameter decorator and
 * `QueryPlan` the type a handler annotates with. One exported identifier, two
 * declaration spaces — two separate barrel re-exports of the same name would be
 * a duplicate export.
 */
export type QueryPlan<R extends string = string> = CoreQueryPlan<R>;
