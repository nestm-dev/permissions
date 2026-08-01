import type {
	PrincipalResolution,
	PrincipalResolutionContext,
	PrincipalResolver,
} from "../interfaces/principal-resolver.interface.ts";

/** Options for {@link RequestPrincipalResolver}. */
export interface RequestPrincipalResolverOptions<TSource = unknown> {
	/**
	 * Request property the auth layer wrote the identity to.
	 *
	 * `"session"` for `@nestm/better-auth`, `"user"` for a plain JWT guard,
	 * `"identity"` for station. Defaults to `"user"`.
	 */
	readonly property?: string;
	/**
	 * Turns that value into a principal.
	 *
	 * Return `null` for "not authenticated" (401) and `NOT_IN_SCOPE` for
	 * "authenticated but not a member of this scope" (404) — the distinction is
	 * the whole reason this returns a union instead of a nullable principal.
	 */
	map(source: TSource, context: PrincipalResolutionContext): PrincipalResolution;
}

/** Default {@link RequestPrincipalResolverOptions.property}. */
export const DEFAULT_PRINCIPAL_PROPERTY = "user";

/**
 * Reads the principal off a property of the request object.
 *
 * One class covers better-auth, a plain JWT guard and station, with zero imports
 * from any of them: it just reads `request[property]`, which is what every auth
 * guard in the ecosystem already writes. Guard **ordering** matters — the auth
 * guard must be registered as an `APP_GUARD` before this package's, since two
 * `APP_GUARD` providers execute in registration order.
 *
 * ```ts
 * new RequestPrincipalResolver<{ user: { id: string; orgId: string } }>({
 *   property: "session",
 *   map: (session, { scope }) =>
 *     session.user.orgId === scope
 *       ? { ref: { type: "Member", id: session.user.id }, entities: [] }
 *       : NOT_IN_SCOPE,
 * });
 * ```
 */
export class RequestPrincipalResolver<TSource = unknown> implements PrincipalResolver {
	readonly #property: string;
	// The options object is held whole rather than destructured: pulling `map` out
	// would unbind it from whatever closure or class the caller defined it on.
	readonly #options: RequestPrincipalResolverOptions<TSource>;

	constructor(options: RequestPrincipalResolverOptions<TSource>) {
		if (typeof options !== "object" || options === null || !("map" in options)) {
			throw new TypeError("RequestPrincipalResolver requires a `map` function.");
		}
		this.#options = options;
		this.#property = options.property ?? DEFAULT_PRINCIPAL_PROPERTY;
	}

	/** Request property this resolver reads. */
	get property(): string {
		return this.#property;
	}

	resolve(context: PrincipalResolutionContext): PrincipalResolution {
		const request = context.request;
		if (typeof request !== "object" || request === null) {
			return null;
		}

		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- reading an arbitrary property off an unknown request is the contract
		const source = (request as Record<string, unknown>)[this.#property];
		// Absent means the auth layer did not run (or deliberately let an anonymous
		// request through), which is unauthenticated — never "not in scope": only
		// the `map` callback has the knowledge to make that distinction.
		if (source === undefined || source === null) {
			return null;
		}

		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- `TSource` is the caller's own claim about `request[property]`
		return this.#options.map(source as TSource, context);
	}
}
