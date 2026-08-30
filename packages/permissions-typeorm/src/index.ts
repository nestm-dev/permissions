// Public barrel for `@nestm/permissions-typeorm`.
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
export const PACKAGE_NAME = "@nestm/permissions-typeorm" as const;

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------

export {
	DEFAULT_TABLE_PREFIX,
	createPermissionsEntities,
	defaultLinkIdColumn,
	defaultScopeColumn,
	permissionsEntitiesMetaOf,
	type CreatePermissionsEntitiesOptions,
	type ExtraColumnMap,
	type LinkIdColumnOptions,
	type PermissionsEntities,
	type PermissionsEntitiesMeta,
	type ScopeColumnOptions,
} from "./entities/create-entities.ts";

export type {
	LinkRow,
	LinkRowValues,
	PolicyRow,
	PolicyRowValues,
	ScopeVersionRow,
} from "./entities/rows.ts";

// ---------------------------------------------------------------------------
// Migrations
// ---------------------------------------------------------------------------

export {
	DEFAULT_MIGRATION_NAME,
	PermissionsInitialMigration,
	buildPermissionsMigration,
	permissionsPostgresIndexStatements,
	permissionsPostgresPolicyStatements,
	type BuildPermissionsMigrationOptions,
	type PermissionsInitialMigrationOptions,
	type PermissionsMigrationClass,
	type PermissionsMigrationDialect,
	type PermissionsMigrationStatements,
	type PermissionsPostgresIndexOptions,
	type PermissionsPostgresPolicyOptions,
} from "./entities/migration.ts";

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export {
	TypeOrmPolicyStore,
	TypeOrmPolicyStoreAccess,
	TypeOrmPolicyStoreIsolationLevel,
	type TypeOrmPolicyStoreCommitOwnership,
	type TypeOrmPolicyStoreExecution,
	type TypeOrmPolicyStoreExecutor,
	type TypeOrmPolicyStoreOperation,
	type TypeOrmPolicyStoreOptions,
} from "./store/typeorm-policy-store.ts";

export { defaultTypeOrmPolicyStoreExecutor } from "./store/executor.ts";

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
	DEFAULT_PARAMETER_PREFIX,
	createTypeOrmResourceMapping,
	type PlanCompileOptions,
	type ResolvedAttributeMapping,
	type ResolvedHierarchyMapping,
	type TypeOrmAttributeMapping,
	type TypeOrmHierarchyMapping,
	type TypeOrmResourceMapping,
	type TypeOrmResourceMappingDefinition,
	type TypeOrmScalarKind,
	type TypeOrmTextOptions,
} from "./compile/mapping.ts";

export {
	planNodeToBrackets,
	planNodeToSql,
	planToBrackets,
	planToSql,
	type CompiledCondition,
} from "./compile/plan-to-brackets.ts";

export { applyPlan, applyPlanToSelect, type PlanFilterable } from "./compile/apply-plan.ts";

export { ParameterBag } from "./compile/parameters.ts";

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
