import { ForbiddenException, Inject, Injectable } from "@nestjs/common";
import type {
	CheckResult,
	EngineStats,
	PolicyScopeId,
	QueryPlan,
	UnsafeCheckRequest,
} from "@nestm/permissions-core";

import { AUTHORIZATION_ENGINE } from "../permissions.tokens.ts";
import { PolicySetManager } from "./policy-set.manager.ts";
import type { AuthorizationEngine } from "../providers/engine.provider.ts";
import type {
	ActionName,
	PermissionsCheckRequest,
	PermissionsPlanRequest,
} from "../types/permissions-registry.types.ts";

/**
 * The imperative authorization surface.
 *
 * A **singleton**, never `Scope.REQUEST`: a request-scoped provider forces Nest
 * to rebuild the injector subtree per request, which is measurable on Fastify
 * and buys nothing here — every request-specific value is an argument.
 *
 * Requests are typed against the vocabulary registered in
 * `PermissionsTypeRegistry`; unaugmented they degrade to core's
 * `UnsafeCheckRequest` shape (plain strings), which is exactly what an app that
 * has not opted into the registry should get.
 */
@Injectable()
export class PermissionsService {
	constructor(
		@Inject(AUTHORIZATION_ENGINE) private readonly engine: AuthorizationEngine,
		private readonly policySets: PolicySetManager,
	) {}

	/**
	 * Decides one request.
	 *
	 * Resolve the principal graph once per request and pass it as `entities` —
	 * that, not core's cross-request `entityCache`, is how a request that makes
	 * several checks avoids resolving the same principal several times.
	 */
	async check<A extends ActionName>(request: PermissionsCheckRequest<A>): Promise<CheckResult> {
		this.policySets.assertReady();
		return this.engine.checkUnsafe(widen(request));
	}

	/**
	 * {@link check}, throwing `ForbiddenException` on a deny.
	 *
	 * Returns the allowing {@link CheckResult} so a caller can still read the
	 * determining policy ids for logging.
	 */
	async checkOrThrow<A extends ActionName>(
		request: PermissionsCheckRequest<A>,
	): Promise<CheckResult> {
		const result = await this.check(request);
		if (!result.allowed) {
			const { action, resource } = widen(request);
			throw new ForbiddenException(
				`Not permitted: ${action} on ${resource.type}::"${resource.id}".`,
			);
		}
		return result;
	}

	/**
	 * Decides many requests, in order, sharing work across the batch: one policy
	 * set lookup per distinct scope and one principal resolution per distinct
	 * `(scope, principal)` pair.
	 */
	async checkMany(requests: readonly PermissionsCheckRequest[]): Promise<readonly CheckResult[]> {
		this.policySets.assertReady();
		return this.engine.checkMany(
			// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see `widen` below
			requests.map(widen) as unknown as Parameters<AuthorizationEngine["checkMany"]>[0],
		);
	}

	/**
	 * Compiles "which rows of this type may this principal act on" into a
	 * three-state {@link QueryPlan}.
	 *
	 * The imperative twin of `@RequirePermission(action, { kind: "unspecified" })`
	 * — use it in a service that lists rows without a guarded route in front of
	 * it. Same `entities` rule as {@link check}: pass the principal graph.
	 *
	 * The plan is never collapsed here. `ALWAYS_DENY` means "return no rows",
	 * `ALWAYS_ALLOW` means "no filter", and `CONDITIONAL` carries the condition a
	 * driver (`@nestm/permissions-drizzle`, `-typeorm`) compiles into SQL.
	 */
	async plan<A extends ActionName>(request: PermissionsPlanRequest<A>): Promise<QueryPlan> {
		this.policySets.assertReady();
		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see `widen` below; the narrowing happens at this method's own signature
		return this.engine.plan(request as unknown as Parameters<AuthorizationEngine["plan"]>[0]);
	}

	/** Counter snapshot across every cache the engine owns. Safe after shutdown. */
	stats(): EngineStats {
		return this.engine.stats();
	}

	/** Marks every cached scope stale; the next check reloads it. */
	async reload(): Promise<void> {
		await this.policySets.reload();
	}

	/**
	 * Marks **one** scope stale — or every scope with `'*'`, which is {@link reload}.
	 *
	 * ```ts
	 * await policyStore.linkTemplate(grant);
	 * await permissions.invalidate(scope); // this tenant only
	 * ```
	 *
	 * A store that implements `watch` emits that event itself and needs none of
	 * this. A store that does not — a projection of your own tables, a composite
	 * over a read-only source — leaves the code that wrote the grant holding the
	 * only knowledge that anything changed, and `reload()` was the only way to say
	 * so. Dropping every tenant's cache to publish one tenant's grant makes every
	 * other tenant pay a cold load, which on a busy instance is a thundering herd
	 * against the policy store.
	 *
	 * Compiled query plans for the scope are dropped outright rather than served
	 * stale (core's contract), so this is safe to call on the write path.
	 */
	// oxlint-disable-next-line typescript/no-redundant-type-constituents -- `PolicyScopeId` widens to `string`, but spelling the sentinel out is the contract
	async invalidate(scope: PolicyScopeId | "*"): Promise<void> {
		await this.policySets.invalidate(scope);
	}
}

/**
 * Erases the registry generics.
 *
 * `PermissionsEngine<AnyVocabulary>` types its `check` against
 * `ActionOf<AnyVocabulary>`, which is `never` — the open `VocabularyDef`
 * declares `principal`/`resource` optionally, so no action of it is requestable.
 * The narrowing that matters happens at this method's own signature, against the
 * *registered* vocabulary; from here on the request is a plain
 * `UnsafeCheckRequest`, which core normalises identically.
 */
function widen(request: unknown): UnsafeCheckRequest {
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see above
	return request as UnsafeCheckRequest;
}
