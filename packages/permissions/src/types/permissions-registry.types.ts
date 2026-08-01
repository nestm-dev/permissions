import type {
	ActionOf,
	AnyVocabulary,
	CheckRequest,
	ContextFor,
	EntityGraph,
	EntityNameOf,
	EntityRef,
	PlanRequest,
	PolicyScopeId,
	ResourceTypeFor,
	UnsafeCheckRequest,
} from "@nestm/permissions-core";

/**
 * Application-level type registry. Augment it once in your app and every
 * default-generic type in this package (`ActionName`, `ResourceTypeName`,
 * `PermissionsCheckRequest`, and the route decorators landing next slice)
 * becomes vocabulary-aware without repeating generics:
 *
 * ```ts
 * declare module "@nestm/permissions" {
 *   interface PermissionsTypeRegistry {
 *     vocabulary: typeof stationVocabulary;
 *   }
 * }
 * ```
 */
// oxlint-disable-next-line typescript/no-empty-interface -- the declaration-merging seam
export interface PermissionsTypeRegistry {}

/**
 * The vocabulary registered via {@link PermissionsTypeRegistry}, falling back to
 * `AnyVocabulary` when the registry has not been augmented.
 */
export type RegisteredVocabulary = PermissionsTypeRegistry extends {
	vocabulary: infer V extends AnyVocabulary;
}
	? V
	: AnyVocabulary;

/**
 * Requestable action ids of the registered vocabulary.
 *
 * Unaugmented this is `string`: `ActionOf<AnyVocabulary>` is `never` (an
 * `ActionDef` declares `principal`/`resource` optionally, so no key of the open
 * definition is requestable), and a `never`-typed action would make every call
 * site uncompilable rather than merely unchecked.
 */
export type ActionName = [ActionOf<RegisteredVocabulary>] extends [never]
	? string
	: ActionOf<RegisteredVocabulary>;

/** Entity type names of the registered vocabulary. `string` when unaugmented. */
export type ResourceTypeName = [EntityNameOf<RegisteredVocabulary>] extends [never]
	? string
	: EntityNameOf<RegisteredVocabulary>;

/** The Cedar request context type action `A` accepts. */
export type PermissionsContext<A extends ActionName> =
	A extends ActionOf<RegisteredVocabulary>
		? ContextFor<RegisteredVocabulary, A>
		: Readonly<Record<string, unknown>>;

/**
 * A `check` request typed against the registered vocabulary.
 *
 * Unaugmented it degrades to core's `UnsafeCheckRequest` shape — plain strings
 * for the action and both entity types — which is exactly what an app that has
 * not opted into the registry should get.
 */
export type PermissionsCheckRequest<A extends ActionName = ActionName> =
	A extends ActionOf<RegisteredVocabulary>
		? CheckRequest<RegisteredVocabulary, A>
		: UnsafeCheckRequest;

/**
 * A `plan` request with every vocabulary-derived type widened to `string`.
 *
 * Core has no such shape — `plan()` is typed-only there — so this package
 * declares it, for the same reason core declares `UnsafeCheckRequest`: an
 * adapter that has lost `V` still has to be able to ask.
 */
export interface UnsafePlanRequest {
	readonly scope: PolicyScopeId;
	readonly principal: EntityRef;
	readonly action: string;
	readonly resourceType: string;
	readonly context?: Readonly<Record<string, unknown>>;
	readonly entities?: EntityGraph;
}

/**
 * A `plan` request typed against the registered vocabulary.
 *
 * Unaugmented it degrades to {@link UnsafePlanRequest} — plain strings for the
 * action and the resource type.
 */
export type PermissionsPlanRequest<A extends ActionName = ActionName> =
	A extends ActionOf<RegisteredVocabulary>
		? PlanRequest<RegisteredVocabulary, A, ResourceTypeFor<RegisteredVocabulary, A>>
		: UnsafePlanRequest;
