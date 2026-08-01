// The three tables, as a factory returning `EntitySchema`s.
//
// **`EntitySchema`, not decorated classes.** Consumers are not forced to enable
// `experimentalDecorators`/`emitDecoratorMetadata`, the tables stay renameable at
// runtime (the whole point of the scope-column seam), and the family's
// `design:paramtypes` fragility never touches this package. The DX cost is one
// factory call: `dataSource.getRepository(entities.policy)` is fully typed.
//
// A *factory* rather than three module-level schemas because the single most
// important schema decision in the design is that the scope column belongs to
// the consumer: `text('scope')` for a greenfield app, `uuid('organization_id')
// NOT NULL REFERENCES organizations(id)` for a multi-tenant one already under
// row-level security. A fixed column would force every RLS-shaped deployment to
// keep a nullable tenant key next to its real one, which is precisely the
// "NULL-tenant escape hatch" those deployments exist to eliminate.
//
// The logical model — columns, primary keys, checks, indexes — is **identical**
// to `@nestm/permissions-drizzle`'s, because the two drivers have to be able to
// read each other's tables. Where TypeORM cannot express something drizzle can
// (`CREATE INDEX … USING gin`, which `EntitySchemaIndexOptions` has no `using`
// for), the statement lives in `migration.ts` instead and the gap is documented
// rather than papered over.

import { EntitySchema, type EntitySchemaColumnOptions } from "typeorm";
import type { ColumnType } from "typeorm";

import type { LinkRow, PolicyRow, ScopeVersionRow } from "./rows.ts";

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
 * @typeParam TValue Type stored in the column — `string` for `text` and for
 * Postgres `uuid`, a branded id for a custom type.
 */
export interface ScopeColumnOptions<TValue = string> {
	/** SQL name of the column. `'scope'`, `'organization_id'`, … */
	readonly name: string;
	/**
	 * Column type. Default `'text'`.
	 *
	 * Anything TypeORM accepts as a `ColumnType` for the target driver: `'uuid'`,
	 * `'varchar'`, a Postgres domain name.
	 */
	readonly type?: ColumnType;
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
	 * `false` makes `TypeOrmPolicyStore` reject writes to `''` and skip the global
	 * half of the `load()` union entirely (D2). Station's shape.
	 */
	readonly supportsGlobalScope?: boolean;
	/**
	 * Extra `EntitySchema` column options merged into the generated column —
	 * `length`, `collation`, `foreignKey`, a `transformer`.
	 *
	 * `name`, `type` and `primary` are owned by the factory and cannot be
	 * overridden here; they are what the store and the migrations agree on.
	 */
	readonly column?: Omit<EntitySchemaColumnOptions, "name" | "type" | "primary">;
}

/** The default scope column: `text` named `scope`, identity mapping, global supported. */
export function defaultScopeColumn(): ScopeColumnOptions<string> {
	return {
		name: "scope",
		type: "text",
		// `''` is a legal `text` value and is exactly what the global scope is, so
		// the default column needs no sentinel and no NULL.
		toScope: (value) => value,
		fromScope: (scope) => scope,
		supportsGlobalScope: true,
	};
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/** Extra columns to graft onto one table, keyed by property name. */
export type ExtraColumnMap = Readonly<Record<string, EntitySchemaColumnOptions>>;

/**
 * How `${prefix}policy_links.link_id` is spelled in SQL.
 *
 * A link id is core's `TemplateLinkRecord['id']` — a `string` on the JavaScript
 * side whatever the column's SQL type is — so this is purely a physical-schema
 * choice, and the one that matters is the foreign key. A deployment that reuses
 * its own grant table's `uuid` primary key as the link id needs a composite FK to
 * `(tenant, id)`, and Postgres refuses one between `text` and `uuid` ("foreign
 * key constraint cannot be implemented … incompatible types").
 *
 * The drizzle driver's `linkIdColumn` is the same option in that driver's
 * spelling (a column-builder thunk); the two produce the same DDL, which is what
 * lets either driver read the other's tables.
 */
export interface LinkIdColumnOptions {
	/** SQL name of the column. Default `'link_id'`. */
	readonly name?: string;
	/**
	 * Column type. Default `'text'`.
	 *
	 * Anything TypeORM accepts as a `ColumnType` for the target driver. Must be a
	 * **string** if the tier-2 migration builder is used — DDL needs a type name and
	 * `ColumnType` also admits constructors.
	 */
	readonly type?: ColumnType;
	/**
	 * Extra `EntitySchema` column options merged into the generated column.
	 *
	 * `name`, `type` and `primary` are owned by the factory and cannot be
	 * overridden here; they are what the store and the migrations agree on.
	 */
	readonly column?: Omit<EntitySchemaColumnOptions, "name" | "type" | "primary">;
}

/** The default link id column: `text` named `link_id`. */
export function defaultLinkIdColumn(): LinkIdColumnOptions {
	return { name: "link_id", type: "text" };
}

/** Options for {@link createPermissionsEntities}. */
export interface CreatePermissionsEntitiesOptions<TScope = string> {
	/** Table-name prefix. Default `'permission_'`. */
	readonly tablePrefix?: string;
	/** The tenant column. Defaults to `text` named `scope` with an identity mapping. */
	readonly scopeColumn?: ScopeColumnOptions<TScope>;
	/**
	 * The link id column. Defaults to `text` named `link_id`.
	 *
	 * See {@link LinkIdColumnOptions} — the reason to change it is a composite
	 * foreign key to a `uuid` grants table.
	 */
	readonly linkIdColumn?: LinkIdColumnOptions;
	/** Postgres schema the tables live in. Default: the connection's search path. */
	readonly schemaName?: string;
	/**
	 * Extra columns per table.
	 *
	 * The escape hatch for a deployment that needs a column the model does not have
	 * — a tenant foreign key, a `deleted_at`. Purely additive: nothing here can
	 * remove or retype a column the store reads.
	 */
	readonly extraColumns?: {
		readonly policies?: ExtraColumnMap;
		readonly links?: ExtraColumnMap;
		readonly scopeVersions?: ExtraColumnMap;
	};
}

/** What {@link createPermissionsEntities} returns. */
export interface PermissionsEntities {
	/** `${prefix}policies` — static policies *and* templates. */
	readonly policy: EntitySchema<PolicyRow>;
	/** `${prefix}policy_links` — template links, the role-grant primitive. */
	readonly link: EntitySchema<LinkRow>;
	/** `${prefix}scope_versions` — the invalidation stamp. */
	readonly scopeVersion: EntitySchema<ScopeVersionRow>;
}

/**
 * Metadata the store needs and the schemas alone do not carry: the scope codec,
 * the prefix and the entity names.
 *
 * Attached to each `EntitySchema` under a **registered** symbol (`Symbol.for`),
 * not held in a module-level `WeakMap`: this package ships three entry points and
 * a bundler is free to give `.` and `./testing` separate copies of this module, at
 * which point a module-local map would be looking in the wrong one. A registered
 * symbol is process-global by construction.
 */
export interface PermissionsEntitiesMeta {
	readonly tablePrefix: string;
	readonly schemaName: string | undefined;
	readonly scopeColumn: ScopeColumnOptions<unknown>;
	readonly names: {
		readonly policy: string;
		readonly link: string;
		readonly scopeVersion: string;
	};
}

const ENTITIES_META = Symbol.for("@nestm/permissions-typeorm:entities-meta");

/** Reads back the metadata {@link createPermissionsEntities} attached, if any. */
export function permissionsEntitiesMetaOf(schema: object): PermissionsEntitiesMeta | undefined {
	return (schema as Record<symbol, PermissionsEntitiesMeta | undefined>)[ENTITIES_META];
}

function attachMeta(schema: object, meta: PermissionsEntitiesMeta): void {
	Object.defineProperty(schema, ENTITIES_META, {
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
 * Builds the three policy-store entity schemas.
 *
 * ```ts
 * const entities = createPermissionsEntities();
 *
 * export const dataSource = new DataSource({
 *   type: "postgres",
 *   url: process.env.DATABASE_URL,
 *   entities: [entities.policy, entities.link, entities.scopeVersion],
 *   migrations: [PermissionsInitialMigration()],
 * });
 * ```
 *
 * What the tables carry, and why:
 *
 * - `policies` holds static policies **and** templates, so "list everything in
 *   this scope" stays one query. `kind` is checked, not trusted.
 * - `links` stores slot values as columns, not as a `values jsonb`: "revoke every
 *   grant for member X" and "who holds this role?" become plain indexed
 *   statements. Both slot pairs are nullable with a pair check — a template that
 *   only declares `?principal` must be linkable without inventing a `?resource`
 *   (D6), and core's conformance suite requires a link with *no* slots at all to
 *   round-trip.
 * - `scope_versions` is the invalidation stamp — one `bigint` per scope, bumped
 *   in the same transaction as the write it describes.
 *
 * **No foreign key is emitted from `links.template_id` to `policies.policy_id`.**
 * The obvious `ON DELETE CASCADE` turns "an operator deleted a template" into
 * "every grant under it silently disappeared", and core's conformance suite
 * requires the opposite: an orphaned link must survive into the bundle so
 * `buildPolicySet` can refuse it loudly. Consumers who want the constraint anyway
 * add it in their own migration, and accept that trade knowingly.
 */
export function createPermissionsEntities<TScope = string>(
	options: CreatePermissionsEntitiesOptions<TScope> = {},
): PermissionsEntities {
	const tablePrefix = options.tablePrefix ?? DEFAULT_TABLE_PREFIX;
	const scopeColumn =
		options.scopeColumn ?? (defaultScopeColumn() as unknown as ScopeColumnOptions<TScope>);

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

	const schemaName = options.schemaName;
	const withSchema = schemaName === undefined ? {} : { schema: schemaName };

	const scope = (constraintName: string): EntitySchemaColumnOptions => ({
		...scopeColumn.column,
		primary: true,
		primaryKeyConstraintName: constraintName,
		name: scopeColumn.name,
		type: scopeColumn.type ?? "text",
		nullable: false,
	});

	const timestamps = {
		createdAt: {
			name: "created_at",
			type: "timestamptz",
			nullable: false,
			default: () => "now()",
		},
		updatedAt: {
			name: "updated_at",
			type: "timestamptz",
			nullable: false,
			default: () => "now()",
		},
	} satisfies Record<string, EntitySchemaColumnOptions>;

	const policy = new EntitySchema<PolicyRow>({
		name: names.policy,
		tableName: names.policy,
		...withSchema,
		columns: {
			scope: scope(`${names.policy}_pk`),
			policyId: {
				primary: true,
				primaryKeyConstraintName: `${names.policy}_pk`,
				name: "policy_id",
				type: "text",
				nullable: false,
			},
			kind: { name: "kind", type: "text", nullable: false },
			// The canonical persisted form is JSON, never policy text: `jsonb` answers
			// "which policies mention Run?" with an index and round-trips through Cedar
			// losslessly. `cedarText` beside it is for humans only — never parsed back.
			cedarJson: { name: "cedar_json", type: "jsonb", nullable: false },
			cedarText: { name: "cedar_text", type: "text", nullable: true },
			description: { name: "description", type: "text", nullable: true },
			annotations: { name: "annotations", type: "jsonb", nullable: false, default: {} },
			enabled: { name: "enabled", type: "boolean", nullable: false, default: true },
			...timestamps,
			...options.extraColumns?.policies,
		},
		checks: [
			{ name: `${names.policy}_kind_check`, expression: `"kind" in ('static', 'template')` },
		],
		indices: [
			{
				// The load path is "everything enabled in this scope", so the index is
				// partial on exactly that predicate.
				name: `${names.policy}_${scopeColumn.name}_enabled_index`,
				columns: ["scope"],
				where: `"enabled"`,
			},
			// NOTE: the `GIN (cedar_json jsonb_path_ops)` index the design specifies is
			// **not** here. `EntitySchemaIndexOptions` has no `using`, so TypeORM cannot
			// express it and `migration:generate` would silently produce a btree index
			// that answers no `@>` query. It is emitted by `buildPermissionsMigration`
			// and `PermissionsInitialMigration` instead, and `permissionsPostgresIndexStatements`
			// hands it to consumers on the `migration:generate` path. See migration.ts.
		],
	});

	const link = new EntitySchema<LinkRow>({
		name: names.link,
		tableName: names.link,
		...withSchema,
		columns: {
			scope: scope(`${names.link}_pk`),
			// The drizzle **property** name stays `linkId` whatever the SQL name is —
			// that is what the store and `rows.ts` read.
			linkId: {
				...linkIdColumn.column,
				primary: true,
				primaryKeyConstraintName: `${names.link}_pk`,
				name: linkIdColumn.name ?? "link_id",
				type: linkIdColumn.type ?? "text",
				nullable: false,
			},
			templateId: { name: "template_id", type: "text", nullable: false },
			principalType: { name: "principal_type", type: "text", nullable: true },
			principalId: { name: "principal_id", type: "text", nullable: true },
			resourceType: { name: "resource_type", type: "text", nullable: true },
			resourceId: { name: "resource_id", type: "text", nullable: true },
			...timestamps,
			...options.extraColumns?.links,
		},
		checks: [
			// A half-filled slot is a link Cedar will reject at build time; catching it
			// at write time keeps the failure next to the code that caused it.
			{
				name: `${names.link}_principal_slot_check`,
				expression: `("principal_type" is null) = ("principal_id" is null)`,
			},
			{
				name: `${names.link}_resource_slot_check`,
				expression: `("resource_type" is null) = ("resource_id" is null)`,
			},
		],
		indices: [
			{
				name: `${names.link}_principal_index`,
				columns: ["scope", "principalType", "principalId"],
			},
		],
	});

	const scopeVersion = new EntitySchema<ScopeVersionRow>({
		name: names.scopeVersion,
		tableName: names.scopeVersion,
		...withSchema,
		columns: {
			scope: scope(`${names.scopeVersion}_pk`),
			// A counter, not a timestamp: monotonic and immune to clock skew between
			// the replicas that write it.
			version: { name: "version", type: "bigint", nullable: false, default: 1 },
			updatedAt: timestamps.updatedAt,
			...options.extraColumns?.scopeVersions,
		},
		indices: [
			// The poller's only query is `updated_at > $since`.
			{ name: `${names.scopeVersion}_updated_at_index`, columns: ["updatedAt"] },
		],
	});

	const meta: PermissionsEntitiesMeta = {
		tablePrefix,
		schemaName,
		scopeColumn: scopeColumn as unknown as ScopeColumnOptions<unknown>,
		names,
	};
	attachMeta(policy, meta);
	attachMeta(link, meta);
	attachMeta(scopeVersion, meta);

	return { policy, link, scopeVersion };
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
export function assertIdentifier(
	value: string,
	option: string,
	{ allowEmpty = false }: { allowEmpty?: boolean } = {},
): void {
	if (allowEmpty && value === "") {
		return;
	}
	if (typeof value !== "string" || !IDENTIFIER.test(value)) {
		throw new TypeError(
			`${option} must be a plain SQL identifier ` +
				`(letters, digits, "_", "$"; not starting with a digit), received ${JSON.stringify(value)}. ` +
				`It is concatenated into DDL, where no bind parameter exists.`,
		);
	}
}
