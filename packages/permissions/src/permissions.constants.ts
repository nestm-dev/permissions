/**
 * Request-level marker holding the `RequestAuthorization` the guard stashed —
 * mirrors `@nestm/better-auth`'s `SESSION_RESOLVED`, so a param decorator can
 * tell "the guard decided nothing" apart from "the guard never ran".
 *
 * Written by `PermissionsGuard` and read by `@CurrentAuthorization()`,
 * `@CurrentPrincipal()` and `@QueryPlan()`. A `@Public()` route never gets one,
 * which is why those decorators refuse rather than invent an empty state.
 */
export const AUTHORIZATION_STATE = Symbol("permissions:authorization_state");

/**
 * Namespaced metadata keys used by the guard-facing decorators.
 *
 * Stable strings rather than generated ids, so the boot-time route audit, the
 * guard and a third-party test helper can all recognise a declaration without
 * importing the decorator that wrote it.
 */
export const METADATA_KEY = {
	requirePermission: "permissions:require_permission",
	public: "permissions:public",
	requireAuthenticated: "permissions:require_authenticated",
	entityProvider: "permissions:entity_provider",
} as const;

/** One of the {@link METADATA_KEY} values. */
export type PermissionsMetadataKey = (typeof METADATA_KEY)[keyof typeof METADATA_KEY];
