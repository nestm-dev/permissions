import type { ExecutionContext } from "@nestjs/common";

import type { PrincipalContextKind } from "../interfaces/principal-resolver.interface.ts";

/**
 * Transport plumbing, adapted from `@nestm/better-auth`'s
 * `utils/execution-context.util.ts`.
 *
 * Copied rather than imported: the two packages must be installable
 * independently, and this is thirty lines of `context.getType()` narrowing that
 * would otherwise become a hard dependency between them.
 */

/**
 * Imports an optional peer at runtime without letting the compiler resolve the
 * specifier (the peer may not be installed).
 */
export async function loadOptionalModule(name: string): Promise<Record<string, unknown>> {
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- an unresolvable specifier has no type
	return import(/* @vite-ignore */ name) as Promise<Record<string, unknown>>;
}

interface GqlExecutionContextLike {
	create(context: ExecutionContext): {
		getContext(): { req?: unknown };
		getArgs(): Record<string, unknown>;
	};
}

let gqlExecutionContext: GqlExecutionContextLike | undefined;

/** Test seam: drops the memoised `@nestjs/graphql` handle. */
export function __resetGraphqlContext(): void {
	gqlExecutionContext = undefined;
}

/** Which transport the current execution context belongs to. */
export function resolveContextKind(context: ExecutionContext): PrincipalContextKind {
	return context.getType<PrincipalContextKind>();
}

async function ensureGqlExecutionContext(): Promise<GqlExecutionContextLike> {
	if (!gqlExecutionContext) {
		try {
			const module = await loadOptionalModule("@nestjs/graphql");
			// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- shape asserted by the interface above
			gqlExecutionContext = module.GqlExecutionContext as GqlExecutionContextLike;
		} catch {
			throw new Error(
				"@nestjs/graphql is required for GraphQL execution contexts. " +
					"Install it: npm install @nestjs/graphql graphql",
			);
		}
	}
	return gqlExecutionContext;
}

/**
 * The transport-level "request" object for the current execution context: the
 * HTTP request, the GraphQL context's `req`, or the WS client (whose
 * `handshake.headers` carry the auth headers).
 */
// oxlint-disable-next-line typescript/no-explicit-any -- adapter/transport request shapes are untyped by design
export async function getRequestFromContext(context: ExecutionContext): Promise<any> {
	const kind = resolveContextKind(context);
	if (kind === "graphql") {
		return (await ensureGqlExecutionContext()).create(context).getContext().req;
	}
	if (kind === "ws") {
		return context.switchToWs().getClient();
	}
	return context.switchToHttp().getRequest();
}

/**
 * The same lookup, synchronously.
 *
 * Used by the param decorators, which run *after* the guard — so the optional
 * `@nestjs/graphql` handle is already memoised by then and no dynamic import is
 * needed. Falls back to the HTTP request rather than throwing: a param decorator
 * that cannot find the request must return "absent", not blow up the response.
 */
// oxlint-disable-next-line typescript/no-explicit-any -- as above
export function getRequestFromContextSync(context: ExecutionContext): any {
	const kind = resolveContextKind(context);
	if (kind === "graphql" && gqlExecutionContext) {
		return gqlExecutionContext.create(context).getContext().req;
	}
	if (kind === "ws") {
		return context.switchToWs().getClient();
	}
	return context.switchToHttp().getRequest();
}

/**
 * The route parameters a `{ kind: "param" }` reference reads.
 *
 * HTTP gives `request.params`; GraphQL gives the field arguments, which are the
 * honest analogue (`@Args("runId")` is that transport's `:runId`). `ws`/`rpc`
 * have neither, and the guard refuses a `param` reference there rather than
 * silently reading an empty object.
 */
export async function getRouteParams(
	context: ExecutionContext,
	// oxlint-disable-next-line typescript/no-explicit-any -- as above
	request: any,
): Promise<Readonly<Record<string, unknown>>> {
	const kind = resolveContextKind(context);
	if (kind === "graphql") {
		return (await ensureGqlExecutionContext()).create(context).getArgs() ?? {};
	}
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- `params` is whatever the router put there
	const params = (request as { params?: unknown } | undefined)?.params;
	return typeof params === "object" && params !== null
		? (params as Readonly<Record<string, unknown>>)
		: {};
}

/** `Controller.handler`, the label every diagnostic in this package uses. */
export function routeLabel(context: ExecutionContext): string {
	return `${context.getClass().name}.${context.getHandler().name}`;
}
