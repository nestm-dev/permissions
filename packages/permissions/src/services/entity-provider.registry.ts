import { Injectable } from "@nestjs/common";
import type { Type } from "@nestjs/common";
import { PermissionsError, entityGraph, fail, isPermissionsError } from "@nestm/permissions-core";
import type {
	AnyVocabulary,
	EntityGraph,
	EntityProvider as CoreEntityProvider,
	EntityRef,
	EntityResolutionRequest,
} from "@nestm/permissions-core";

import { EntityProvider } from "../decorators/entity-provider.decorator.ts";
import type { RegisteredVocabulary } from "../types/permissions-registry.types.ts";

/** One route decision, as the guard describes it to the registry. */
export interface RouteEntityRequest {
	readonly scope: string;
	readonly principal: EntityRef;
	readonly action: string;
	/** Absent on the query-plan path, where there is no single resource. */
	readonly resource?: EntityRef;
	/** Present on the query-plan path so providers know which row type is unresolved. */
	readonly resourceType?: string;
}

/**
 * What an `@EntityProvider()` class implements.
 *
 * Every method is optional — that is the whole point of splitting the graph
 * across features: a tenancy module contributes the principal's organisations, a
 * projects module contributes the resource, and neither needs to know about the
 * other. Methods may be synchronous; the registry awaits either way.
 */
export interface FeatureEntityProvider<V extends AnyVocabulary = RegisteredVocabulary> {
	resolvePrincipal?(request: EntityResolutionRequest<V>): EntityGraph | Promise<EntityGraph>;
	resolveResource?(request: EntityResolutionRequest<V>): EntityGraph | Promise<EntityGraph>;
	resolveAdditional?(request: EntityResolutionRequest<V>): EntityGraph | Promise<EntityGraph>;
}

/**
 * The registry's own view of a provider — **any** provider, whatever vocabulary
 * it was written against.
 *
 * `FeatureEntityProvider<A>` and `FeatureEntityProvider<B>` are genuinely
 * unrelated types: `EntityResolutionRequest<V>` mentions `ActionOf<V>`, which
 * resolves through the vocabulary's `namespace` literal, so neither assignment
 * direction holds and bivariance does not rescue it. That is invisible until an
 * application augments `PermissionsTypeRegistry` — at which point
 * `FeatureEntityProvider`'s default stops being `AnyVocabulary` and the registry
 * would refuse every provider in the application.
 *
 * The parameter is therefore `never`, in **property** position so the check stays
 * strictly contravariant: every concrete resolver is assignable, nothing else is,
 * and the registry casts once at the single point where it calls them.
 */
export interface AnyFeatureEntityProvider {
	readonly resolvePrincipal?: (request: never) => EntityGraph | Promise<EntityGraph>;
	readonly resolveResource?: (request: never) => EntityGraph | Promise<EntityGraph>;
	readonly resolveAdditional?: (request: never) => EntityGraph | Promise<EntityGraph>;
}

/** One registered contributor, as the registry sees it. */
export interface EntityProviderRegistration {
	/** Class name, for diagnostics and deterministic reporting. */
	readonly name: string;
	/** `@EntityProvider({ order })`; lower runs first. */
	readonly order: number;
	/** Registration sequence number — the tiebreaker that makes order total. */
	readonly sequence: number;
	/** The singleton instance discovery found. */
	readonly provider: AnyFeatureEntityProvider;
}

const RESOLVER_METHODS = ["resolvePrincipal", "resolveResource", "resolveAdditional"] as const;

/**
 * Rejects anything that is not a usable `@EntityProvider()` class.
 *
 * @throws `Error` when `candidate` is not a class, carries no `@EntityProvider()`
 * metadata, or implements none of the three resolver methods — the last check is
 * the one that catches a provider registered for its DI value and silently
 * contributing nothing to every decision.
 */
export function assertEntityProviderClass(candidate: Type<unknown>): void {
	if (typeof candidate !== "function" || candidate.prototype === undefined) {
		throw new Error(
			`PermissionsModule.forFeature: '${String(candidate)}' is not a class. Pass the ` +
				"@EntityProvider() class itself, not an instance or a provider definition.",
		);
	}

	if (Reflect.getMetadata(EntityProvider.KEY, candidate) === undefined) {
		throw new Error(
			`PermissionsModule.forFeature: '${candidate.name}' is not decorated with @EntityProvider().`,
		);
	}

	const prototype: unknown = candidate.prototype;
	const implemented = RESOLVER_METHODS.filter(
		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- probing an unknown prototype is the point
		(method) => typeof (prototype as Record<string, unknown>)[method] === "function",
	);
	if (implemented.length === 0) {
		throw new Error(
			`PermissionsModule.forFeature: '${candidate.name}' implements none of ` +
				`${RESOLVER_METHODS.join("/")}, so it can never contribute entities.`,
		);
	}
}

/**
 * Composes every discovered `@EntityProvider()` into the single
 * `EntityProvider` the engine consumes.
 *
 * Composition rules, all deliberate:
 * - **principal**: first non-empty graph wins. Concatenating principal graphs
 *   would let a feature module widen another's answer — the principal is one
 *   entity with one set of parents, and two providers disagreeing about it is a
 *   configuration error, not a merge.
 * - **resource / additional**: concatenated, then deduplicated by UID. These are
 *   genuinely additive: several features may each know part of the resource's
 *   ancestry.
 * - **order**: `@EntityProvider({ order })` ascending, ties broken by discovery
 *   order, which is stable for a given module graph.
 */
@Injectable()
export class EntityProviderRegistry {
	readonly #registrations: EntityProviderRegistration[] = [];
	readonly #instances = new Set<AnyFeatureEntityProvider>();
	#sequence = 0;

	/** Registers a provider instance. Registering the same instance twice is a no-op. */
	register(provider: AnyFeatureEntityProvider, source: { name: string; order?: number }): void {
		if (this.#instances.has(provider)) {
			return;
		}
		this.#instances.add(provider);
		this.#registrations.push({
			name: source.name,
			order: source.order ?? 0,
			sequence: this.#sequence++,
			provider,
		});
	}

	/** Registrations in composition order. */
	get registrations(): readonly EntityProviderRegistration[] {
		return this.#registrations.toSorted(
			(left, right) => left.order - right.order || left.sequence - right.sequence,
		);
	}

	/** How many providers are registered. */
	get size(): number {
		return this.#registrations.length;
	}

	/** Drops every registration. Used by tests and by module teardown. */
	clear(): void {
		this.#registrations.length = 0;
		this.#instances.clear();
		this.#sequence = 0;
	}

	/**
	 * The composed provider handed to `createEngine`.
	 *
	 * Reads the registration list on every call, so the engine can be constructed
	 * before discovery has run — which it always is, providers being instantiated
	 * before any `onModuleInit`.
	 */
	asEntityProvider(): CoreEntityProvider<AnyVocabulary> {
		return {
			resolvePrincipal: async (request) => this.#resolvePrincipal(request),
			resolveResource: async (request) => this.#concat("resolveResource", request),
			resolveAdditional: async (request) => this.#concat("resolveAdditional", request),
		};
	}

	/**
	 * The resource and additional contributions for one route decision.
	 *
	 * The guard's entry point, and deliberately *not* `resolvePrincipal`: the
	 * principal graph belongs to the principal resolver, which produced it once
	 * for the whole request. Returns `[]` when nothing is registered, because the
	 * guard always passes `entities` explicitly and "no contributions" is a
	 * legitimate answer there — unlike on the engine's own provider path, where
	 * an empty principal graph is the `ENTITY_RESOLUTION` failure above.
	 */
	async resolveRouteEntities(request: RouteEntityRequest): Promise<EntityGraph> {
		if (this.#registrations.length === 0) {
			return [];
		}
		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- `ActionOf<AnyVocabulary>` is `never`; the action is a checked string by the time it reaches here
		const coreRequest = request as unknown as EntityResolutionRequest<AnyVocabulary>;
		return entityGraph(
			...(await this.#concat("resolveResource", coreRequest)),
			...(await this.#concat("resolveAdditional", coreRequest)),
		);
	}

	async #resolvePrincipal(request: EntityResolutionRequest<AnyVocabulary>): Promise<EntityGraph> {
		if (this.#registrations.length === 0) {
			// The engine only reaches a provider when the caller passed no
			// `entities`, so an empty registry here is core's `ENTITY_RESOLUTION`
			// case and must throw rather than answer with an empty graph: Cedar
			// treats a missing principal as attribute-less and parent-less, which
			// denies what should be allowed and — via a `forbid` on an attribute —
			// allows what should be denied.
			fail(
				"ENTITY_RESOLUTION",
				`No entities were supplied for "${String(request.action)}" in scope "${request.scope}" ` +
					"and no @EntityProvider() class is registered. Pass `entities` on the request " +
					'(use [] to mean "this decision needs none") or register an entity provider.',
				{ scope: request.scope },
			);
		}

		for (const registration of this.registrations) {
			let graph: EntityGraph | undefined;
			try {
				graph = await registration.provider.resolvePrincipal?.(asProviderRequest(request));
			} catch (error) {
				throw entityProviderFailure(error, registration.name, "resolvePrincipal", request.scope);
			}
			if (graph !== undefined && graph.length > 0) {
				return entityGraph(...graph);
			}
		}
		return [];
	}

	async #concat(
		method: "resolveResource" | "resolveAdditional",
		request: EntityResolutionRequest<AnyVocabulary>,
	): Promise<EntityGraph> {
		const parts: EntityGraph[] = [];
		for (const { name, provider } of this.registrations) {
			// Optional-call rather than an extracted method reference, so `this`
			// stays bound to the provider instance.
			let graph: EntityGraph | undefined;
			try {
				graph =
					method === "resolveResource"
						? await provider.resolveResource?.(asProviderRequest(request))
						: await provider.resolveAdditional?.(asProviderRequest(request));
			} catch (error) {
				throw entityProviderFailure(error, name, method, request.scope);
			}
			if (graph !== undefined) {
				parts.push(graph);
			}
		}
		return entityGraph(...parts.flat());
	}
}

/**
 * The single cast in the composition path.
 *
 * `AnyFeatureEntityProvider` declares its parameter as `never` so that any
 * concrete resolver is assignable to it; calling one therefore needs the value
 * widened back. Every field the providers read (`scope`, `principal`, `action`,
 * `resource`) is present and correct — only the vocabulary generic, which exists
 * purely to type the *application's* implementation, is erased.
 */
function asProviderRequest(request: EntityResolutionRequest<AnyVocabulary>): never {
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see above
	return request as never;
}

function entityProviderFailure(
	error: unknown,
	provider: string,
	method: (typeof RESOLVER_METHODS)[number],
	scope: string,
): PermissionsError {
	if (isPermissionsError(error)) {
		return error;
	}
	return new PermissionsError(
		"ENTITY_RESOLUTION",
		`Entity provider '${provider}' failed in ${method}: ${
			error instanceof Error ? error.message : String(error)
		}`,
		{ cause: error, scope },
	);
}
