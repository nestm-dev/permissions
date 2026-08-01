/**
 * Injection token for the module options object (extras stripped), exactly as
 * resolved from `forRoot`/`forRootAsync`.
 */
export const PERMISSIONS_MODULE_OPTIONS = Symbol("PERMISSIONS_MODULE_OPTIONS");

/**
 * Injection token for the live `PermissionsEngine` created from the module
 * options.
 *
 * The engine is created once per module registration and disposed by
 * `PolicySetManager` on application shutdown. Injecting it directly is
 * supported; prefer `PermissionsService` unless you need `warm`/`invalidate`/
 * `validatePolicies`.
 */
export const AUTHORIZATION_ENGINE = Symbol("AUTHORIZATION_ENGINE");

/**
 * Injection token for the resolved `PolicyStore` — whichever arm of
 * `PermissionsModuleOptions.store` was configured, or the seeded
 * `MemoryPolicyStore` when it was omitted.
 */
export const POLICY_STORE = Symbol("POLICY_STORE");

/**
 * Injection token for the resolved `PrincipalResolver`, or `undefined` when the
 * module was configured without one.
 */
export const PRINCIPAL_RESOLVER = Symbol("PRINCIPAL_RESOLVER");
