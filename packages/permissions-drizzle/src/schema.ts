// `@nestm/permissions-drizzle/schema` — the three tables, as a factory.
//
// A *factory* rather than three exported `pgTable`s because the single most
// important schema decision in the design is that the scope column belongs to
// the consumer: `text('scope')` for a greenfield app, `uuid('organization_id')
// NOT NULL REFERENCES organizations(id)` for a multi-tenant one already under
// row-level security. A fixed column would force every RLS-shaped deployment to
// keep a nullable tenant key next to its real one, which is precisely the
// "NULL-tenant escape hatch" those deployments exist to eliminate.
//
// **Read the `createPermissionsSchema` docs before wiring drizzle-kit.** The
// result must be destructured into top-level `export const`s; drizzle-kit only
// sees module exports that are themselves `PgTable`s, so nesting them in one
// object produces an *empty* migration with no error anywhere.

import type { PolicyJson } from "@nestm/permissions-core";
import { sql, type BuildColumns } from "drizzle-orm";
import {
	bigint,
	boolean,
	check,
	getTableConfig,
	index,
	jsonb,
	pgTable,
	primaryKey,
	text,
	timestamp,
	type PgColumn,
	type PgColumnBuilderBase,
	type PgTableExtraConfigValue,
	type PgTableWithColumns,
} from "drizzle-orm/pg-core";

/** Entry identity. Exported so the built entry has real runtime output. */
export const SCHEMA_ENTRY_NAME = "@nestm/permissions-drizzle/schema" as const;

/** Default table-name prefix. Every table is `${prefix}<name>`. */
export const DEFAULT_TABLE_PREFIX = "permission_";

// ---------------------------------------------------------------------------
// Scope column
// ---------------------------------------------------------------------------

/**
 * How the consumer's tenant column maps onto core's `PolicyScopeId`.
 *
 * `toScope`/`fromScope` are a *pair of inverses*, and both directions are used:
 * `fromScope` on every read and write, `toScope` in the invalidation poller,
 * which learns about scopes from the database rather than from the caller.
 *
 * @typeParam TValue Type stored in the column — `string` for `text`, `string`
 * for drizzle's `uuid`, a branded id for a custom type.
 */
export interface ScopeColumnOptions<TValue = string> {
	/** SQL name of the column. Must match the name the builder was given. */
	readonly name: string;
	/**
	 * Builds the column. Called **once per table**, so it must return a fresh
	 * builder each time — drizzle column builders carry per-table state and
	 * reusing one silently attaches the column to whichever table was built last.
	 */
	readonly column: () => PgColumnBuilderBase;
	/** Column value to core's scope id. `'org:8f3e…'` from a uuid, or identity. */
	readonly toScope: (value: TValue) => string;
	/**
	 * Core's scope id to a column value. The inverse of {@link toScope}.
	 *
	 * Must throw for the global scope (`''`) when {@link supportsGlobalScope} is
	 * `false` — a `NOT NULL uuid` column has no value that means "every tenant",
	 * and inventing one is how a global policy leaks into a tenant's bundle.
	 */
	readonly fromScope: (scope: string) => TValue;
	/**
	 * Whether the column can hold the global scope. Default `true`.
	 *
	 * `false` makes `DrizzlePolicyStore` reject writes to `''` and skip the global
	 * half of the `load()` union entirely (D2). Station's shape.
	 */
	readonly supportsGlobalScope?: boolean;
}

/** The default scope column: `text('scope')`, identity mapping, global supported. */
export function defaultScopeColumn(): ScopeColumnOptions<string> {
	return {
		name: "scope",
		// `''` is a legal `text` value and is exactly what the global scope is, so
		// the default column needs no sentinel and no NULL.
		column: () => text("scope").notNull(),
		toScope: (value) => value,
		fromScope: (scope) => scope,
		supportsGlobalScope: true,
	};
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/** Extra columns to graft onto one table, keyed by drizzle property name. */
export type ExtraColumnMap = Record<string, PgColumnBuilderBase>;

/**
 * The three tables' built columns, as `extraTableConfig` sees them.
 *
 * **All three keys are populated before `extraTableConfig` is ever called**, so
 * a `links` entry may reference `tables.policies` and vice versa — the composite
 * foreign key from `links` to `policies` needs exactly that. The factory reads
 * each table's columns off the built `PgTable` as soon as `pgTable()` returns,
 * rather than waiting for drizzle to invoke the per-table config callbacks.
 *
 * The keys stay **optional** for source compatibility with the guarded shape the
 * previous release forced on consumers (`tables.links === undefined ? [] : […]`);
 * that guard is now dead code, not a load-bearing one. A fresh implementation can
 * use `tables.policies!` — or the {@link PermissionsTablesReady} view returned by
 * {@link assertTablesReady} — without a runtime branch.
 */
export interface RawPermissionsTables {
	readonly policies?: Record<string, PgColumn>;
	readonly links?: Record<string, PgColumn>;
	readonly scopeVersions?: Record<string, PgColumn>;
}

/** {@link RawPermissionsTables} with the optionality dropped. */
export interface PermissionsTablesReady {
	readonly policies: Record<string, PgColumn>;
	readonly links: Record<string, PgColumn>;
	readonly scopeVersions: Record<string, PgColumn>;
}

/**
 * Narrows {@link RawPermissionsTables} to {@link PermissionsTablesReady}.
 *
 * Sugar for the one thing every `extraTableConfig` implementation wants and the
 * optional keys make verbose. Throws rather than returning `undefined`: a table
 * missing here means the factory could not read its columns, which would silently
 * drop the caller's foreign keys and RLS policies from the generated DDL.
 *
 * ```ts
 * extraTableConfig: (raw) => {
 *   const t = assertTablesReady(raw);
 *   return { links: [foreignKey({ columns: [t.links.scope], … })] };
 * }
 * ```
 */
export function assertTablesReady(tables: RawPermissionsTables): PermissionsTablesReady {
	const { policies, links, scopeVersions } = tables;
	if (policies === undefined || links === undefined || scopeVersions === undefined) {
		throw new TypeError(
			`createPermissionsSchema could not read the built columns of ` +
				`${[
					policies === undefined ? "policies" : undefined,
					links === undefined ? "links" : undefined,
					scopeVersions === undefined ? "scopeVersions" : undefined,
				]
					.filter((name) => name !== undefined)
					.join(", ")}. ` +
				`This means the installed drizzle-orm no longer exposes a table's extra-config ` +
				`columns where this package reads them; extraTableConfig entries for the missing ` +
				`tables would be dropped from the generated DDL.`,
		);
	}
	return { policies, links, scopeVersions };
}

/**
 * One table's extra `pgTable` config entries, or a thunk producing them.
 *
 * The thunk form exists for entries that must be built late — a `foreignKey`
 * pointing at a table declared *after* the schema factory runs, for instance.
 * It is invoked at most once, when the owning table's config is first extracted.
 */
export type ExtraTableConfigEntries =
	readonly PgTableExtraConfigValue[] | (() => readonly PgTableExtraConfigValue[] | undefined);

/**
 * What `extraTableConfig` returns: extra `pgTable` config entries per table.
 *
 * Every key is optional and an omitted, `undefined` or empty key contributes
 * nothing — returning `{ policies: [...] }` alone is a complete answer and the
 * other two tables build normally.
 */
export interface ExtraTableConfig {
	readonly policies?: ExtraTableConfigEntries;
	readonly links?: ExtraTableConfigEntries;
	readonly scopeVersions?: ExtraTableConfigEntries;
}

/** Options for {@link createPermissionsSchema}. */
export interface CreatePermissionsSchemaOptions<TScope = string> {
	/** Table-name prefix. Default `'permission_'`. */
	readonly tablePrefix?: string;
	/** The tenant column. Defaults to `text('scope')` with an identity mapping. */
	readonly scopeColumn?: ScopeColumnOptions<TScope>;
	/**
	 * Builds `${prefix}policy_links.link_id`. Defaults to `text('link_id').notNull()`.
	 *
	 * A link id is core's `TemplateLinkRecord['id']` — a `string` on the JavaScript
	 * side whatever the column's SQL type is — so this is purely a physical-schema
	 * choice, and the one that matters is the foreign key. A deployment that reuses
	 * its own grant table's `uuid` primary key as the link id needs a composite FK
	 * to `(tenant, id)`, and Postgres refuses one between `text` and `uuid`
	 * ("foreign key constraint cannot be implemented … incompatible types").
	 *
	 * ```ts
	 * createPermissionsSchema({
	 *   linkIdColumn: () => uuid("link_id").notNull(),
	 *   extraTableConfig: (raw) => {
	 *     const t = assertTablesReady(raw);
	 *     return {
	 *       links: [
	 *         foreignKey({ columns: [t.links.scope, t.links.linkId],
	 *                      foreignColumns: [roleGrants.organizationId, roleGrants.id] }),
	 *       ],
	 *     };
	 *   },
	 * });
	 * ```
	 *
	 * Like {@link ScopeColumnOptions.column} it is called **once per table it
	 * appears on** (only `links`), and must return a fresh builder each time — a
	 * drizzle column builder carries per-table state.
	 *
	 * The SQL name is yours too, but the store reads the column through the drizzle
	 * *property* name `linkId`, so keep the property meaning "the link id".
	 */
	readonly linkIdColumn?: () => PgColumnBuilderBase;
	/**
	 * Extra columns per table.
	 *
	 * Split per table rather than shared, because a column builder cannot be used
	 * twice: drizzle mutates it when the table is built.
	 */
	readonly extraColumns?: {
		readonly policies?: ExtraColumnMap;
		readonly links?: ExtraColumnMap;
		readonly scopeVersions?: ExtraColumnMap;
	};
	/**
	 * The RLS seam.
	 *
	 * Returns extra `pgTable` config entries — `pgPolicy(...)`, `foreignKey(...)`,
	 * `index(...)`, `check(...)` — so a tenant deployment gets tables
	 * indistinguishable from hand-written ones, isolation policies and all.
	 *
	 * **Called exactly once per schema**, with all three tables' columns already
	 * populated ({@link RawPermissionsTables}), and each key's entries are built at
	 * most once. The previous release called it once *per table* and indexed the
	 * single key it needed, which evaluated the whole returned object three times
	 * against a progressively-filled `tables` — so an entry dereferencing a table
	 * that had not been built yet threw `Cannot read properties of undefined`, from
	 * inside drizzle-kit, naming neither this option nor the table. Guarding the
	 * branches (`tables.links === undefined ? [] : […]`) traded that crash for the
	 * worse failure: drizzle extracts each table's config independently, so a
	 * `links` entry guarded on `tables.policies` was silently **omitted** whenever
	 * the links table happened to be serialised first — a foreign key and an
	 * isolation policy missing from the migration, with no error anywhere.
	 */
	readonly extraTableConfig?: (tables: RawPermissionsTables) => ExtraTableConfig | undefined;
}

// ---------------------------------------------------------------------------
// Column maps
// ---------------------------------------------------------------------------

// Written as generic functions purely so the table types below can be derived
// from them with `ReturnType<typeof …>` instead of being spelled twice. The
// property names (not the SQL names) are the stable public surface: a consumer
// writes `permissionPolicies.cedarJson` whatever the column is called in the
// database.

function policyColumnMap<TScope extends PgColumnBuilderBase, TExtra extends ExtraColumnMap>(
	scope: TScope,
	extra: TExtra,
) {
	return {
		scope,
		policyId: text("policy_id").notNull(),
		kind: text("kind").notNull(),
		// The canonical persisted form is JSON, never policy text: `jsonb` answers
		// "which policies mention Run?" with an index, and round-trips through
		// Cedar losslessly. `cedarText` beside it is for humans only.
		cedarJson: jsonb("cedar_json").$type<PolicyJson>().notNull(),
		cedarText: text("cedar_text"),
		description: text("description"),
		annotations: jsonb("annotations").$type<Record<string, string>>().notNull().default({}),
		enabled: boolean("enabled").notNull().default(true),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
		updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
		...extra,
	};
}

function linkColumnMap<
	TScope extends PgColumnBuilderBase,
	TExtra extends ExtraColumnMap,
	TLinkId extends PgColumnBuilderBase = PgColumnBuilderBase,
>(scope: TScope, linkId: TLinkId, extra: TExtra) {
	return {
		scope,
		linkId,
		templateId: text("template_id").notNull(),
		// Columns rather than a `values jsonb`: "revoke every grant for member X"
		// and "who holds this role?" become plain indexed statements, which is the
		// access pattern a role-grant table actually has.
		principalType: text("principal_type"),
		principalId: text("principal_id"),
		resourceType: text("resource_type"),
		resourceId: text("resource_id"),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
		updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
		...extra,
	};
}

function scopeVersionColumnMap<TScope extends PgColumnBuilderBase, TExtra extends ExtraColumnMap>(
	scope: TScope,
	extra: TExtra,
) {
	return {
		scope,
		// A counter, not a timestamp: monotonic and immune to clock skew between
		// the replicas that write it.
		version: bigint("version", { mode: "number" }).notNull().default(1),
		updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
		...extra,
	};
}

// ---------------------------------------------------------------------------
// Table types
// ---------------------------------------------------------------------------

/**
 * A built table, typed from its column map.
 *
 * The table *name* is typed as `string` on purpose: it is a runtime value
 * (`${prefix}policies`) and threading a template-literal type through three
 * tables buys nothing a consumer can use, while making every error message in
 * this file twice as long.
 */
type BuiltTable<TColumns extends ExtraColumnMap> = PgTableWithColumns<{
	name: string;
	schema: undefined;
	dialect: "pg";
	columns: BuildColumns<string, TColumns, "pg">;
}>;

/** The `${prefix}policies` table. */
export type PermissionPoliciesTable<
	TScope extends PgColumnBuilderBase = PgColumnBuilderBase,
	TExtra extends ExtraColumnMap = ExtraColumnMap,
> = BuiltTable<ReturnType<typeof policyColumnMap<TScope, TExtra>>>;

/** The `${prefix}policy_links` table. */
export type PermissionPolicyLinksTable<
	TScope extends PgColumnBuilderBase = PgColumnBuilderBase,
	TExtra extends ExtraColumnMap = ExtraColumnMap,
	TLinkId extends PgColumnBuilderBase = PgColumnBuilderBase,
> = BuiltTable<ReturnType<typeof linkColumnMap<TScope, TExtra, TLinkId>>>;

/** The `${prefix}scope_versions` table. */
export type PermissionScopeVersionsTable<
	TScope extends PgColumnBuilderBase = PgColumnBuilderBase,
	TExtra extends ExtraColumnMap = ExtraColumnMap,
> = BuiltTable<ReturnType<typeof scopeVersionColumnMap<TScope, TExtra>>>;

/**
 * What {@link createPermissionsSchema} returns.
 *
 * `DrizzlePolicyStore` accepts this object, or any object with these three keys
 * — which is what lets a consumer re-assemble it from the top-level consts
 * drizzle-kit requires.
 */
export interface PermissionsSchema {
	readonly permissionPolicies: PermissionPoliciesTable;
	readonly permissionPolicyLinks: PermissionPolicyLinksTable;
	readonly permissionScopeVersions: PermissionScopeVersionsTable;
}

/**
 * Metadata the store needs and the tables alone do not carry: the scope codec
 * and the prefix.
 *
 * Attached to each table under a **registered** symbol (`Symbol.for`), not held
 * in a module-level `WeakMap`: this package ships four entry points and a bundler
 * is free to give `./schema` and `.` separate copies of this module, at which
 * point a module-local map would be looking in the wrong one. A registered
 * symbol is process-global by construction.
 */
export interface PermissionsSchemaMeta {
	readonly tablePrefix: string;
	readonly scopeColumn: ScopeColumnOptions<unknown>;
}

const SCHEMA_META = Symbol.for("@nestm/permissions-drizzle:schema-meta");

/** Reads back the metadata {@link createPermissionsSchema} attached, if any. */
export function permissionsSchemaMetaOf(table: object): PermissionsSchemaMeta | undefined {
	return (table as Record<symbol, PermissionsSchemaMeta | undefined>)[SCHEMA_META];
}

function attachMeta(table: object, meta: PermissionsSchemaMeta): void {
	Object.defineProperty(table, SCHEMA_META, {
		value: meta,
		enumerable: false,
		configurable: true,
		writable: false,
	});
}

// ---------------------------------------------------------------------------
// The factory
// ---------------------------------------------------------------------------

/**
 * Builds the three policy-store tables.
 *
 * ```ts
 * // schema.ts — NOTE the destructuring, it is not stylistic
 * export const { permissionPolicies, permissionPolicyLinks, permissionScopeVersions } =
 *   createPermissionsSchema({
 *     scopeColumn: {
 *       name: "organization_id",
 *       column: () => uuid("organization_id").notNull(),
 *       toScope: (id) => `org:${id}`,
 *       fromScope: (scope) => scope.slice(4),
 *       supportsGlobalScope: false,
 *     },
 *   });
 * ```
 *
 * **The destructuring into top-level `export const`s is load-bearing.**
 * drizzle-kit's `prepareFromExports` walks `Object.values(module)` and keeps the
 * entries that pass `is(value, PgTable)`. An exported object *containing* the
 * tables passes nothing, so `drizzle-kit generate` emits an empty migration —
 * successfully, with no warning. `tests/integration/drizzle-kit-roundtrip.test.ts`
 * pins both halves of that behaviour.
 *
 * What the tables carry, and why:
 *
 * - `policies` holds static policies **and** templates, so "list everything in
 *   this scope" stays one query. `kind` is checked, not trusted.
 * - `links` stores slot values as columns. Both slot pairs are nullable with a
 *   pair check: a template that only declares `?principal` must be linkable
 *   without inventing a `?resource` (D6), and core's conformance suite requires a
 *   link with *no* slots at all to round-trip.
 * - `scope_versions` is the invalidation stamp — one `bigint` per scope, bumped
 *   in the same transaction as the write it describes.
 *
 * **No foreign key is emitted from `links.template_id` to `policies.policy_id`.**
 * The obvious `ON DELETE CASCADE` turns "an operator deleted a template" into
 * "every grant under it silently disappeared", and core's `PolicyStore`
 * conformance suite requires the opposite: an orphaned link must survive into the
 * bundle so `buildPolicySet` can refuse it loudly. Consumers who want the
 * constraint anyway (station does, pointing at its own `role_grants`) add it
 * through {@link CreatePermissionsSchemaOptions.extraTableConfig}, and accept
 * that trade knowingly.
 */
export function createPermissionsSchema<TScope = string>(
	options: CreatePermissionsSchemaOptions<TScope> = {},
): PermissionsSchema {
	const tablePrefix = options.tablePrefix ?? DEFAULT_TABLE_PREFIX;
	const scopeColumn =
		options.scopeColumn ?? (defaultScopeColumn() as unknown as ScopeColumnOptions<TScope>);

	assertIdentifier(tablePrefix, "tablePrefix", { allowEmpty: true });
	assertIdentifier(scopeColumn.name, "scopeColumn.name");

	const policiesName = `${tablePrefix}policies`;
	const linksName = `${tablePrefix}policy_links`;
	const scopeVersionsName = `${tablePrefix}scope_versions`;

	const tables: {
		policies?: Record<string, PgColumn>;
		links?: Record<string, PgColumn>;
		scopeVersions?: Record<string, PgColumn>;
	} = {};

	// Single evaluation, memoised per key.
	//
	// drizzle does not invoke a `pgTable` config callback at construction — it
	// stores it and runs it whenever someone extracts that *one* table's config,
	// which drizzle-kit does per table and in no guaranteed order. Calling the
	// consumer's `extraTableConfig` from inside each of those callbacks therefore
	// re-evaluated the whole returned object once per table, each time against a
	// different partially-filled `tables`. The three priming `getTableConfig()`
	// calls at the end of this function run every callback once with `priming` on,
	// which fills `tables` without asking the consumer for anything, so the single
	// real resolution below always sees all three tables.
	let priming = true;
	let resolved: ExtraTableConfig | undefined;
	const memoised = new Map<keyof ExtraTableConfig, readonly PgTableExtraConfigValue[]>();
	const ready = (): boolean =>
		tables.policies !== undefined &&
		tables.links !== undefined &&
		tables.scopeVersions !== undefined;

	const resolveConfig = (): ExtraTableConfig => {
		if (resolved !== undefined) {
			return resolved;
		}
		const produced = options.extraTableConfig?.(tables);
		const config: ExtraTableConfig =
			produced === null || typeof produced !== "object" ? {} : produced;
		if (ready()) {
			// Memoised only once every table is present. If a future drizzle stops
			// exposing a table's columns where `columnsOf` reads them, this degrades to
			// the old per-table evaluation rather than freezing a half-answer.
			resolved = config;
		}
		return config;
	};

	const extra = (key: keyof ExtraTableConfig): readonly PgTableExtraConfigValue[] => {
		if (priming) {
			return [];
		}
		const cached = memoised.get(key);
		if (cached !== undefined) {
			return cached;
		}
		const entries = resolveConfig()[key];
		const built = (typeof entries === "function" ? entries() : entries) ?? [];
		if (resolved !== undefined) {
			memoised.set(key, built);
		}
		return built;
	};

	const permissionPolicies = pgTable(
		policiesName,
		policyColumnMap(scopeColumn.column(), options.extraColumns?.policies ?? {}),
		(t) => {
			tables.policies = t as unknown as Record<string, PgColumn>;
			return [
				primaryKey({ name: `${policiesName}_pk`, columns: [t.scope, t.policyId] }),
				check(`${policiesName}_kind_check`, sql`${t.kind} in ('static', 'template')`),
				// The load path is "everything enabled in this scope", so the index is
				// partial on exactly that predicate.
				index(`${policiesName}_${scopeColumn.name}_enabled_index`)
					.on(t.scope)
					.where(sql`${t.enabled}`),
				// Answers the admin API's "which policies mention Run?" without a scan.
				index(`${policiesName}_cedar_json_index`).using("gin", t.cedarJson.op("jsonb_path_ops")),
				...extra("policies"),
			];
		},
	) as unknown as PermissionPoliciesTable;

	const permissionPolicyLinks = pgTable(
		linksName,
		linkColumnMap(
			scopeColumn.column(),
			options.linkIdColumn?.() ?? text("link_id").notNull(),
			options.extraColumns?.links ?? {},
		),
		(t) => {
			tables.links = t as unknown as Record<string, PgColumn>;
			return [
				primaryKey({ name: `${linksName}_pk`, columns: [t.scope, t.linkId] }),
				// A half-filled slot is a link Cedar will reject at build time; catching
				// it at write time keeps the failure next to the code that caused it.
				check(
					`${linksName}_principal_slot_check`,
					sql`(${t.principalType} is null) = (${t.principalId} is null)`,
				),
				check(
					`${linksName}_resource_slot_check`,
					sql`(${t.resourceType} is null) = (${t.resourceId} is null)`,
				),
				index(`${linksName}_principal_index`).on(t.scope, t.principalType, t.principalId),
				...extra("links"),
			];
		},
	) as unknown as PermissionPolicyLinksTable;

	const permissionScopeVersions = pgTable(
		scopeVersionsName,
		scopeVersionColumnMap(scopeColumn.column(), options.extraColumns?.scopeVersions ?? {}),
		(t) => {
			tables.scopeVersions = t as unknown as Record<string, PgColumn>;
			return [
				primaryKey({ name: `${scopeVersionsName}_pk`, columns: [t.scope] }),
				// The poller's only query is `updated_at > $since`.
				index(`${scopeVersionsName}_updated_at_index`).on(t.updatedAt),
				...extra("scopeVersions"),
			];
		},
	) as unknown as PermissionScopeVersionsTable;

	// Priming. `pgTable()` *stores* its config callback rather than calling it, and
	// drizzle-kit later calls each table's independently and in no guaranteed
	// order — so without this, `extraTableConfig` would be asked for the `links`
	// entries at a moment when `tables.policies` was still undefined. Running the
	// three callbacks here, with `priming` on, fills `tables` from drizzle's own
	// argument (the entries built and discarded are the factory's own primary key,
	// checks and indexes, which are pure constructions).
	getTableConfig(permissionPolicies);
	getTableConfig(permissionPolicyLinks);
	getTableConfig(permissionScopeVersions);
	priming = false;

	const meta: PermissionsSchemaMeta = {
		tablePrefix,
		scopeColumn: scopeColumn as unknown as ScopeColumnOptions<unknown>,
	};
	attachMeta(permissionPolicies, meta);
	attachMeta(permissionPolicyLinks, meta);
	attachMeta(permissionScopeVersions, meta);

	return { permissionPolicies, permissionPolicyLinks, permissionScopeVersions };
}

// ---------------------------------------------------------------------------
// GRANT / RLS statements
// ---------------------------------------------------------------------------

/** Options for {@link permissionsPostgresPolicyStatements}. */
export interface PermissionsPostgresPolicyOptions {
	/** Table-name prefix. Must match the schema's. Default `'permission_'`. */
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
 * The `GRANT`/`ROW LEVEL SECURITY` statements to hand-append to a generated
 * migration.
 *
 * drizzle-kit emits the tables, indexes and policies; it does not emit grants,
 * and `FORCE ROW LEVEL SECURITY` (the part that makes RLS apply to the table's
 * *owner* too) has no schema-level representation at all. Rather than leave that
 * as archaeology, this returns the statements verbatim:
 *
 * ```ts
 * // append to drizzle/0004_cedar-policy-store.sql
 * permissionsPostgresPolicyStatements({ role: "station_app" }).join(";\n") + ";";
 * ```
 *
 * Identifiers are validated, not escaped: everything here lands in DDL, where no
 * bind parameter exists, so a role name that is not a plain identifier is a
 * `TypeError` rather than a quoting puzzle.
 */
export function permissionsPostgresPolicyStatements(
	options: PermissionsPostgresPolicyOptions,
): readonly string[] {
	const prefix = options.tablePrefix ?? DEFAULT_TABLE_PREFIX;
	const schemaName = options.schemaName ?? "public";

	assertIdentifier(prefix, "tablePrefix", { allowEmpty: true });
	assertIdentifier(options.role, "role");
	assertIdentifier(schemaName, "schemaName");

	const qualify = (name: string): string => `"${schemaName}"."${prefix}${name}"`;
	const policies = qualify("policies");
	const links = qualify("policy_links");
	const scopeVersions = qualify("scope_versions");
	const role = `"${options.role}"`;

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
// Identifier validation
// ---------------------------------------------------------------------------

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_$]*$/;

/**
 * Rejects anything that is not a plain SQL identifier.
 *
 * These values are concatenated into DDL and into index names; DDL has no bind
 * parameters, so validation is the only defence. `tests/integration/injection.test.ts`
 * feeds this the corpus.
 */
function assertIdentifier(
	value: string,
	option: string,
	{ allowEmpty = false }: { allowEmpty?: boolean } = {},
): void {
	if (allowEmpty && value === "") {
		return;
	}
	if (typeof value !== "string" || !IDENTIFIER.test(value)) {
		throw new TypeError(
			`createPermissionsSchema's ${option} must be a plain SQL identifier ` +
				`(letters, digits, "_", "$"; not starting with a digit), received ${JSON.stringify(value)}. ` +
				`It is concatenated into DDL, where no bind parameter exists.`,
		);
	}
}
