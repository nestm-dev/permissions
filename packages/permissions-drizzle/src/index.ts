// Public barrel for `@nestm/permissions-drizzle`.
//
// Two invariants this entry must never break, both asserted by
// `tests/unit/entry-points.test.ts`:
//
//   1. **No NestJS.** Every framework import lives behind the `./nestjs`
//      subpath, so the driver is usable from a plain script, a worker, or a
//      migration — none of which should have to install `@nestjs/common` to
//      compile a `WHERE` clause.
//   2. **No Cedar WASM.** The compiler imports `@nestm/permissions-core/plan`,
//      which is pure TypeScript. Importing this package must not instantiate the
//      4.1 MiB WASM module; the store reaches core's barrel for `PermissionsError`
//      and the store SPI, and core keeps `loadCedar()` lazy.

/** Package identity. Exported so the built barrel has real runtime output. */
export const PACKAGE_NAME = "@nestm/permissions-drizzle" as const;

// ---------------------------------------------------------------------------
// Schema (also on the `./schema` subpath)
// ---------------------------------------------------------------------------

// `SCHEMA_ENTRY_NAME` is deliberately **not** re-exported: it is the `./schema`
// entry's own identity marker, the counterpart of `NESTJS_ENTRY_NAME` and
// `TESTING_ENTRY_NAME`, neither of which the barrel carries either. This entry
// identifies itself with `PACKAGE_NAME`.
export {
	DEFAULT_TABLE_PREFIX,
	assertTablesReady,
	createPermissionsSchema,
	defaultScopeColumn,
	permissionsPostgresPolicyStatements,
	permissionsSchemaMetaOf,
	type CreatePermissionsSchemaOptions,
	type ExtraColumnMap,
	type ExtraTableConfig,
	type ExtraTableConfigEntries,
	type PermissionPoliciesTable,
	type PermissionPolicyLinksTable,
	type PermissionScopeVersionsTable,
	type PermissionsPostgresPolicyOptions,
	type PermissionsSchema,
	type PermissionsSchemaMeta,
	type PermissionsTablesReady,
	type RawPermissionsTables,
	type ScopeColumnOptions,
} from "./schema.ts";

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export {
	DrizzlePolicyStore,
	type DrizzlePolicyStoreAccess,
	type DrizzlePolicyStoreCommitOwnership,
	type DrizzlePolicyStoreDatabase,
	type DrizzlePolicyStoreExecution,
	type DrizzlePolicyStoreExecutor,
	type DrizzlePolicyStoreIsolationLevel,
	type DrizzlePolicyStoreOperation,
	type DrizzlePolicyStoreOptions,
} from "./store/drizzle-policy-store.ts";

export {
	DEFAULT_POLL_INTERVAL_MS,
	MAX_POLL_BACKOFF_MS,
	type PolicyNotifyClient,
	type PolicyNotifyMessage,
	type PolicyNotifyOptions,
	type PolicyStoreDriverOptions,
} from "./store/options.ts";

export {
	PolicyChangeWatcher,
	PolicyNotifyListener,
	type PolicyChangeWatcherOptions,
	type PolicyNotifyListenerOptions,
	type WatcherTimers,
} from "./store/watcher.ts";

// ---------------------------------------------------------------------------
// Compiler
// ---------------------------------------------------------------------------

export {
	DEFAULT_ESCAPE_CHAR,
	type DrizzleAttributeMapping,
	type DrizzleHierarchyMapping,
	type DrizzleResourceMapping,
	type DrizzleScalarKind,
	type DrizzleTextOptions,
	type PlanCompileOptions,
} from "./compile/mapping.ts";

export { planNodeToSql, planToSql } from "./compile/plan-to-sql.ts";
export { applyPlan, type PlanFilterable, type PlanFiltered } from "./compile/apply-plan.ts";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export {
	PlanCompilationError,
	UnmappedAttributeError,
	UnmappedHierarchyError,
	isPlanCompilationError,
	type PlanCompilationErrorOptions,
	type PlanCompilationReason,
} from "./errors.ts";
