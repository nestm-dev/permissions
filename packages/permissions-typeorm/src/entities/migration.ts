// The migrations story — three tiers, in order of preference.
//
//   1. **`typeorm migration:generate`.** Register `createPermissionsEntities()`
//      in `DataSource.entities` and let TypeORM diff the database. Zero code from
//      us, the standard flow, and the one the README recommends. Its single gap is
//      documented and closed by `permissionsPostgresIndexStatements` below:
//      `EntitySchemaIndexOptions` has no `using`, so TypeORM cannot emit
//      `CREATE INDEX … USING gin`.
//   2. **`buildPermissionsMigration()`** — raw statements, so a consumer can
//      hand-append `GRANT`/RLS (or their own foreign keys) before committing the
//      file. This is the tier station uses.
//   3. **`PermissionsInitialMigration()`** — a `MigrationInterface` class,
//      droppable straight into `migrations: [...]` for consumers who want it
//      managed.
//
// Tiers 2 and 3 emit *identical* SQL — tier 3 is tier 2 wrapped in a class — and
// both emit the same logical schema as `@nestm/permissions-drizzle`'s generated
// migration. Table names, column names, constraint names and index names match
// byte for byte, so the two drivers can read each other's tables and a project
// can migrate from one to the other without touching the database.

import type { ColumnType, MigrationInterface, QueryRunner } from "typeorm";

import {
	DEFAULT_TABLE_PREFIX,
	assertIdentifier,
	defaultLinkIdColumn,
	defaultScopeColumn,
	type CreatePermissionsEntitiesOptions,
	type LinkIdColumnOptions,
	type ScopeColumnOptions,
} from "./create-entities.ts";

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/** Dialects the statement generator knows about. */
export type PermissionsMigrationDialect = "postgres" | "mysql" | "sqlite";

/** Options for {@link buildPermissionsMigration}. */
export interface BuildPermissionsMigrationOptions<
	TScope = string,
> extends CreatePermissionsEntitiesOptions<TScope> {
	/**
	 * Target dialect. **Only `'postgres'` is implemented in v1** — the others throw
	 * a clear error rather than emitting statements nobody has run.
	 *
	 * The compiler (`planToBrackets`) is Postgres-only for the same reason: `@>`,
	 * `cardinality`, `inet` and `jsonb` have no portable spelling, and a migration
	 * generator that outran the compiler would create tables no plan could filter.
	 */
	readonly dialect: PermissionsMigrationDialect;
	/**
	 * Emit `CREATE TABLE IF NOT EXISTS` / `DROP TABLE IF EXISTS`. Default `false`.
	 *
	 * Off by default because a migration that silently does nothing against an
	 * existing table is how two deployments end up with different schemas and one
	 * confused operator. The test harness turns it on.
	 */
	readonly ifNotExists?: boolean;
	/**
	 * Append the `GRANT`/row-level-security statements for a tenant deployment.
	 *
	 * Exactly {@link permissionsPostgresPolicyStatements}, appended to `up`. Absent
	 * by default: a greenfield app connecting as the table owner needs none of it,
	 * and issuing a `GRANT` to a role that does not exist fails the migration.
	 */
	readonly postgresPolicies?: Omit<PermissionsPostgresPolicyOptions, "tablePrefix" | "schemaName">;
}

/** What {@link buildPermissionsMigration} returns: raw statements, no trailing semicolons. */
export interface PermissionsMigrationStatements {
	/** Forward statements, in execution order. */
	readonly up: readonly string[];
	/** Reverse statements, in execution order. */
	readonly down: readonly string[];
}

// ---------------------------------------------------------------------------
// Statement generation
// ---------------------------------------------------------------------------

/**
 * The `CREATE TABLE`/`CREATE INDEX` statements for the policy store.
 *
 * ```ts
 * const { up, down } = buildPermissionsMigration({ dialect: "postgres" });
 * // paste into a migration file, or run them:
 * for (const statement of up) await queryRunner.query(statement);
 * ```
 *
 * Statements are returned **without** trailing semicolons, because that is what
 * `QueryRunner.query` wants and adding one is a `join(";\n") + ";"` away.
 *
 * @throws {@link TypeError} for a dialect other than `'postgres'`, for a table
 * prefix or scope-column name that is not a plain SQL identifier, and for a scope
 * column whose `type` is not a string (a `ColumnType` may be a constructor, and
 * DDL needs a name).
 */
export function buildPermissionsMigration<TScope = string>(
	options: BuildPermissionsMigrationOptions<TScope>,
): PermissionsMigrationStatements {
	if (options.dialect !== "postgres") {
		throw new TypeError(
			`buildPermissionsMigration does not implement the "${options.dialect}" dialect yet. ` +
				`Only "postgres" is supported in v1 — the query compiler is Postgres-only ` +
				`(\`@>\`, \`cardinality\`, \`inet\`, \`jsonb\` have no portable spelling), and a ` +
				`migration generator that outran it would create tables no plan could filter. ` +
				`Use tier 1 (\`typeorm migration:generate\` with createPermissionsEntities()) for ` +
				`another dialect.`,
		);
	}

	const layout = resolveLayout(options);
	const exists = options.ifNotExists === true;
	const ifNotExists = exists ? "if not exists " : "";

	const scopeType = resolveSqlType(layout.scopeColumn.type, "scopeColumn.type");
	const scopeName = quote(layout.scopeColumn.name);
	const linkIdType = resolveSqlType(layout.linkIdColumn.type, "linkIdColumn.type");
	const linkIdName = quote(layout.linkIdColumn.name ?? "link_id");

	const up: string[] = [
		`create table ${ifNotExists}${layout.policy} (
	${scopeName} ${scopeType} not null,
	"policy_id" text not null,
	"kind" text not null,
	"cedar_json" jsonb not null,
	"cedar_text" text,
	"description" text,
	"annotations" jsonb default '{}'::jsonb not null,
	"enabled" boolean default true not null,
	"created_at" timestamptz default now() not null,
	"updated_at" timestamptz default now() not null,
	constraint ${quote(`${layout.names.policy}_pk`)} primary key (${scopeName}, "policy_id"),
	constraint ${quote(`${layout.names.policy}_kind_check`)} check ("kind" in ('static', 'template'))
)`,
		`create table ${ifNotExists}${layout.link} (
	${scopeName} ${scopeType} not null,
	${linkIdName} ${linkIdType} not null,
	"template_id" text not null,
	"principal_type" text,
	"principal_id" text,
	"resource_type" text,
	"resource_id" text,
	"created_at" timestamptz default now() not null,
	"updated_at" timestamptz default now() not null,
	constraint ${quote(`${layout.names.link}_pk`)} primary key (${scopeName}, ${linkIdName}),
	constraint ${quote(`${layout.names.link}_principal_slot_check`)} check (("principal_type" is null) = ("principal_id" is null)),
	constraint ${quote(`${layout.names.link}_resource_slot_check`)} check (("resource_type" is null) = ("resource_id" is null))
)`,
		`create table ${ifNotExists}${layout.scopeVersion} (
	${scopeName} ${scopeType} not null,
	"version" bigint default 1 not null,
	"updated_at" timestamptz default now() not null,
	constraint ${quote(`${layout.names.scopeVersion}_pk`)} primary key (${scopeName})
)`,
		// Partial on exactly the load path's predicate: "everything enabled in this scope".
		`create index ${ifNotExists}${quote(`${layout.names.policy}_${layout.scopeColumn.name}_enabled_index`)} on ${layout.policy} using btree (${scopeName}) where "enabled"`,
		...permissionsPostgresIndexStatements({
			tablePrefix: layout.tablePrefix,
			...(layout.schemaName === undefined ? {} : { schemaName: layout.schemaName }),
			ifNotExists: exists,
		}),
		`create index ${ifNotExists}${quote(`${layout.names.link}_principal_index`)} on ${layout.link} using btree (${scopeName}, "principal_type", "principal_id")`,
		// The poller's only query is `updated_at > $since`.
		`create index ${ifNotExists}${quote(`${layout.names.scopeVersion}_updated_at_index`)} on ${layout.scopeVersion} using btree ("updated_at")`,
	];

	if (options.postgresPolicies !== undefined) {
		up.push(
			...permissionsPostgresPolicyStatements({
				...options.postgresPolicies,
				tablePrefix: layout.tablePrefix,
				...(layout.schemaName === undefined ? {} : { schemaName: layout.schemaName }),
			}),
		);
	}

	// `cascade` because the indexes, constraints and any policies a consumer
	// hand-appended hang off the tables; dropping in reverse creation order keeps
	// the statement list readable even though `cascade` makes the order moot.
	const down: string[] = [
		`drop table if exists ${layout.scopeVersion} cascade`,
		`drop table if exists ${layout.link} cascade`,
		`drop table if exists ${layout.policy} cascade`,
	];

	return { up, down };
}

// ---------------------------------------------------------------------------
// The index TypeORM cannot express
// ---------------------------------------------------------------------------

/** Options for {@link permissionsPostgresIndexStatements}. */
export interface PermissionsPostgresIndexOptions {
	/** Table-name prefix. Must match the entities'. Default `'permission_'`. */
	readonly tablePrefix?: string;
	/** Schema to qualify the tables with. Default: unqualified (search path). */
	readonly schemaName?: string;
	/** Emit `IF NOT EXISTS`. Default `false`. */
	readonly ifNotExists?: boolean;
}

/**
 * Index DDL `EntitySchema` cannot express, for the `migration:generate` path.
 *
 * Exactly one statement today: the `GIN (cedar_json jsonb_path_ops)` index that
 * answers the admin API's "which policies mention `Run`?" without a scan.
 * `EntitySchemaIndexOptions` has no `using`, so a generated migration would
 * contain a **btree** index over a `jsonb` column — syntactically fine, useless
 * for `@>`, and silently so. Rather than ship an index that lies, the factory
 * omits it and this hands you the statement:
 *
 * ```ts
 * // append to the generated migration's up()
 * for (const statement of permissionsPostgresIndexStatements()) {
 *   await queryRunner.query(statement);
 * }
 * ```
 *
 * `buildPermissionsMigration` and `PermissionsInitialMigration` already include
 * it; this exists only for tier 1.
 */
export function permissionsPostgresIndexStatements(
	options: PermissionsPostgresIndexOptions = {},
): readonly string[] {
	const prefix = options.tablePrefix ?? DEFAULT_TABLE_PREFIX;
	assertIdentifier(prefix, "tablePrefix", { allowEmpty: true });
	if (options.schemaName !== undefined) {
		assertIdentifier(options.schemaName, "schemaName");
	}

	const policies = qualify(options.schemaName, `${prefix}policies`);
	const ifNotExists = options.ifNotExists === true ? "if not exists " : "";

	return [
		`create index ${ifNotExists}${quote(`${prefix}policies_cedar_json_index`)} on ${policies} using gin ("cedar_json" jsonb_path_ops)`,
	];
}

// ---------------------------------------------------------------------------
// GRANT / RLS statements
// ---------------------------------------------------------------------------

/** Options for {@link permissionsPostgresPolicyStatements}. */
export interface PermissionsPostgresPolicyOptions {
	/** Table-name prefix. Must match the entities'. Default `'permission_'`. */
	readonly tablePrefix?: string;
	/** Role the application connects as — station's `station_app`. */
	readonly role: string;
	/** Emit `FORCE ROW LEVEL SECURITY` for the two tenant tables. Default `true`. */
	readonly forceRowLevelSecurity?: boolean;
	/**
	 * Also enable RLS on `${prefix}scope_versions`. Default `false`.
	 *
	 * The default is the carve-out the design argues for and a security reviewer
	 * has to sign off on: the invalidation poller runs
	 * `SELECT scope, version … WHERE updated_at > $1` with **no** tenant context,
	 * so under RLS it returns zero rows and no cache ever invalidates. The table
	 * holds no tenant *data* — only a monotonic counter keyed by tenant id, a
	 * cache-coherence channel — so leaving it unprotected introduces no
	 * tenant-readable content. Set `true` only if you have also given the poller a
	 * context, or accepted that invalidation stops.
	 */
	readonly rowLevelSecurityOnScopeVersions?: boolean;
	/** Schema to qualify the tables with. Default `'public'`. */
	readonly schemaName?: string;
}

/**
 * The `GRANT`/`ROW LEVEL SECURITY` statements to append to a migration.
 *
 * Byte-identical to `@nestm/permissions-drizzle`'s `permissionsPostgresPolicyStatements`:
 * a deployment must not be able to tell which driver wrote its migration.
 *
 * TypeORM's schema builder emits tables, indexes and constraints; it does not
 * emit grants, and `FORCE ROW LEVEL SECURITY` (the part that makes RLS apply to
 * the table's *owner* too) has no `EntitySchema` representation at all. Rather
 * than leave that as archaeology, this returns the statements verbatim:
 *
 * ```ts
 * permissionsPostgresPolicyStatements({ role: "station_app" }).join(";\n") + ";";
 * ```
 *
 * Identifiers are validated, not escaped: everything here lands in DDL, where no
 * bind parameter exists, so a role name that is not a plain identifier is a
 * `TypeError` rather than a quoting puzzle. The isolation `CREATE POLICY` itself
 * is deliberately **not** generated — its `USING` clause is application-specific
 * (`current_setting('station.organization_id', true)`) and a guessed predicate is
 * worse than none.
 */
export function permissionsPostgresPolicyStatements(
	options: PermissionsPostgresPolicyOptions,
): readonly string[] {
	const prefix = options.tablePrefix ?? DEFAULT_TABLE_PREFIX;
	const schemaName = options.schemaName ?? "public";

	assertIdentifier(prefix, "tablePrefix", { allowEmpty: true });
	assertIdentifier(options.role, "role");
	assertIdentifier(schemaName, "schemaName");

	const policies = qualify(schemaName, `${prefix}policies`);
	const links = qualify(schemaName, `${prefix}policy_links`);
	const scopeVersions = qualify(schemaName, `${prefix}scope_versions`);
	const role = quote(options.role);

	const statements: string[] = [
		`ALTER TABLE ${policies} ENABLE ROW LEVEL SECURITY`,
		`ALTER TABLE ${links} ENABLE ROW LEVEL SECURITY`,
	];

	if (options.forceRowLevelSecurity !== false) {
		// Without FORCE, the table owner bypasses every policy — which is exactly
		// the role a migration runs as, and often the role an app connects as too.
		statements.push(
			`ALTER TABLE ${policies} FORCE ROW LEVEL SECURITY`,
			`ALTER TABLE ${links} FORCE ROW LEVEL SECURITY`,
		);
	}

	if (options.rowLevelSecurityOnScopeVersions === true) {
		statements.push(`ALTER TABLE ${scopeVersions} ENABLE ROW LEVEL SECURITY`);
		if (options.forceRowLevelSecurity !== false) {
			statements.push(`ALTER TABLE ${scopeVersions} FORCE ROW LEVEL SECURITY`);
		}
	}

	statements.push(
		`GRANT SELECT, INSERT, UPDATE, DELETE ON ${policies}, ${links} TO ${role}`,
		// No DELETE: a scope's version counter is never removed, and a role that
		// cannot delete it cannot reset an invalidation stamp backwards.
		`GRANT SELECT, INSERT, UPDATE ON ${scopeVersions} TO ${role}`,
	);

	return statements;
}

// ---------------------------------------------------------------------------
// Tier 3 — the MigrationInterface factory
// ---------------------------------------------------------------------------

/** Options for {@link PermissionsInitialMigration}. */
export interface PermissionsInitialMigrationOptions<TScope = string> extends Omit<
	BuildPermissionsMigrationOptions<TScope>,
	"dialect"
> {
	/** Dialect. Default `'postgres'`; anything else throws (see tier 2). */
	readonly dialect?: PermissionsMigrationDialect;
	/**
	 * Migration name. Must end in a 13-digit millisecond timestamp — TypeORM's
	 * `MigrationExecutor` parses the last 13 characters to order migrations and
	 * refuses a name it cannot parse.
	 *
	 * Default {@link DEFAULT_MIGRATION_NAME}. Override it to place this migration
	 * relative to your own: TypeORM sorts by that timestamp, not by array order.
	 */
	readonly name?: string;
}

/**
 * The default migration name.
 *
 * A **fixed** timestamp rather than `Date.now()`: a name that changed per process
 * would re-run the migration on every deploy, and TypeORM records the name it ran
 * under in `migrations`.
 */
export const DEFAULT_MIGRATION_NAME = "PermissionsInitial1753900000000";

/** A migration class, as `DataSource.migrations` wants it. */
export type PermissionsMigrationClass = new () => MigrationInterface;

/**
 * A `MigrationInterface` class for the policy-store tables.
 *
 * ```ts
 * export const dataSource = new DataSource({
 *   type: "postgres",
 *   entities: [entities.policy, entities.link, entities.scopeVersion],
 *   migrations: [PermissionsInitialMigration()],
 * });
 * ```
 *
 * Runs exactly {@link buildPermissionsMigration}'s statements, one
 * `queryRunner.query` each, in order. `down()` drops the three tables with
 * `CASCADE`, which is a clean reversal: nothing outside them is created here.
 *
 * @throws {@link TypeError} at *call* time — not at migration time — for a bad
 * dialect, identifier or name. A migration that only fails once the transaction
 * is open is a migration that fails in production.
 */
export function PermissionsInitialMigration<TScope = string>(
	options: PermissionsInitialMigrationOptions<TScope> = {},
): PermissionsMigrationClass {
	const { up, down } = buildPermissionsMigration({
		...options,
		dialect: options.dialect ?? "postgres",
	});

	const name = options.name ?? DEFAULT_MIGRATION_NAME;
	if (!/\d{13}$/.test(name)) {
		throw new TypeError(
			`PermissionsInitialMigration's name must end in a 13-digit millisecond timestamp ` +
				`(TypeORM's MigrationExecutor parses the last 13 characters to order migrations), ` +
				`received ${JSON.stringify(name)}.`,
		);
	}

	return class PermissionsInitial implements MigrationInterface {
		readonly name = name;

		async up(queryRunner: QueryRunner): Promise<void> {
			for (const statement of up) {
				await queryRunner.query(statement);
			}
		}

		async down(queryRunner: QueryRunner): Promise<void> {
			for (const statement of down) {
				await queryRunner.query(statement);
			}
		}
	};
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface Layout {
	readonly tablePrefix: string;
	readonly schemaName: string | undefined;
	readonly scopeColumn: ScopeColumnOptions<unknown>;
	readonly linkIdColumn: LinkIdColumnOptions;
	readonly names: { readonly policy: string; readonly link: string; readonly scopeVersion: string };
	readonly policy: string;
	readonly link: string;
	readonly scopeVersion: string;
}

function resolveLayout<TScope>(options: CreatePermissionsEntitiesOptions<TScope>): Layout {
	const tablePrefix = options.tablePrefix ?? DEFAULT_TABLE_PREFIX;
	const scopeColumn = (options.scopeColumn ??
		defaultScopeColumn()) as unknown as ScopeColumnOptions<unknown>;

	const linkIdColumn = options.linkIdColumn ?? defaultLinkIdColumn();

	assertIdentifier(tablePrefix, "tablePrefix", { allowEmpty: true });
	assertIdentifier(scopeColumn.name, "scopeColumn.name");
	assertIdentifier(linkIdColumn.name ?? "link_id", "linkIdColumn.name");
	if (options.schemaName !== undefined) {
		assertIdentifier(options.schemaName, "schemaName");
	}

	const names = {
		policy: `${tablePrefix}policies`,
		link: `${tablePrefix}policy_links`,
		scopeVersion: `${tablePrefix}scope_versions`,
	} as const;

	return {
		tablePrefix,
		schemaName: options.schemaName,
		scopeColumn,
		linkIdColumn,
		names,
		policy: qualify(options.schemaName, names.policy),
		link: qualify(options.schemaName, names.link),
		scopeVersion: qualify(options.schemaName, names.scopeVersion),
	};
}

/** Postgres type names: letters, digits, spaces, an optional precision, optional `[]`. */
const SQL_TYPE = /^[A-Za-z_][A-Za-z0-9_ ]*(\(\s*\d+(\s*,\s*\d+)?\s*\))?(\[\])*$/;

function resolveSqlType(type: ColumnType | undefined, option: string): string {
	const resolved: unknown = type ?? "text";
	if (typeof resolved !== "string") {
		throw new TypeError(
			`${option} must be a string for buildPermissionsMigration — DDL needs a type ` +
				`name and TypeORM's ColumnType also admits constructors. Received ` +
				`${typeof resolved === "function" ? resolved.name || "an anonymous function" : typeof resolved}.`,
		);
	}
	if (!SQL_TYPE.test(resolved)) {
		throw new TypeError(
			`${option} must be a plain SQL type name, received ${JSON.stringify(resolved)}. ` +
				`It is concatenated into DDL, where no bind parameter exists.`,
		);
	}
	return resolved;
}

function quote(identifier: string): string {
	return `"${identifier.replaceAll('"', '""')}"`;
}

function qualify(schemaName: string | undefined, table: string): string {
	return schemaName === undefined ? quote(table) : `${quote(schemaName)}.${quote(table)}`;
}
