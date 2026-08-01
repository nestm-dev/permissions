// `TypeOrmPolicyStore` — core's `PolicyStore` over three Postgres tables.
//
// The four contracts that make this more than a CRUD wrapper, each of which
// fails as *wrong authorization* rather than as a crash:
//
//   D1  implementing `watch` is a promise that every write becomes an event. The
//       engine stops polling `currentVersion` the moment a store implements it,
//       so a missed event serves stale decisions indefinitely. Writes emit
//       synchronously after commit (zero staleness for the writing replica) and
//       the poller covers the others.
//   D2  `load(scope)` returns global (`''`) ∪ `scope`, versioned `g<n>:s<m>`, and
//       **throws** when an id exists in both halves. Precedence between them is
//       undefined, so a silent winner is a configuration error waiting to be a
//       security incident.
//   D6  a template that declares only `?principal` must be linkable without
//       inventing a `?resource`; the slot columns are nullable in pairs.
//   —   every write bumps its scope's version **in the same transaction**. A bump
//       that commits separately leaves a window in which a replica loads the new
//       policies under the old version and then caches them forever.
//
// Every one of those is asserted by core's shared conformance suite, which this
// store runs in `tests/integration/conformance.test.ts` — the same suite
// `MemoryPolicyStore` and `DrizzlePolicyStore` run.

import {
	GLOBAL_POLICY_SCOPE,
	composePolicyVersion,
	isGlobalScope,
	type PolicyBundle,
	type PolicyChangeEvent,
	type PolicyChangeListener,
	type PolicyChangeReason,
	type PolicyRecord,
	type PolicyScopeId,
	type PolicyStore,
	type TemplateLinkRecord,
	type Unsubscribe,
} from "@nestm/permissions-core";
import { In, type DataSource, type EntityManager, type EntityMetadata } from "typeorm";

import {
	createPermissionsEntities,
	permissionsEntitiesMetaOf,
	type PermissionsEntities,
	type ScopeColumnOptions,
} from "../entities/create-entities.ts";
import {
	assertLinkRecord,
	assertPolicyRecord,
	byId,
	linkRowValues,
	policyRowValues,
	storeError,
	toLinkRecord,
	toPolicyRecord,
	type LinkRow,
	type PolicyRow,
	type ScopeVersionRow,
} from "../entities/rows.ts";
import { DEFAULT_POLL_INTERVAL_MS, type PolicyStoreDriverOptions } from "./options.ts";
import { PolicyChangeWatcher, PolicyNotifyListener, type WatcherTimers } from "./watcher.ts";

/** Options the store accepts, plus the seams its own tests need. */
export interface TypeOrmPolicyStoreOptions extends PolicyStoreDriverOptions {
	/** Timer seam for the poller. Tests drive ticks with it; production never sets it. */
	readonly timers?: WatcherTimers;
}

/** Resolved metadata and identifiers, computed once the `DataSource` is initialised. */
interface Resolved {
	readonly policy: EntityMetadata;
	readonly link: EntityMetadata;
	readonly scopeVersion: EntityMetadata;
	/** Escaped, schema-qualified table name of the scope-versions table. */
	readonly scopeVersionTable: string;
	/** Escaped column names on the scope-versions table. */
	readonly scopeVersionColumns: {
		readonly scope: string;
		readonly version: string;
		readonly updatedAt: string;
	};
	/** Raw (unescaped) scope column name per table, for `orUpdate` conflict targets. */
	readonly scopeColumnNames: {
		readonly policy: string;
		readonly link: string;
		readonly scopeVersion: string;
	};
}

/**
 * Postgres-backed {@link PolicyStore}.
 *
 * ```ts
 * const entities = createPermissionsEntities();
 *
 * const dataSource = new DataSource({
 *   type: "postgres",
 *   url: process.env.DATABASE_URL,
 *   entities: [entities.policy, entities.link, entities.scopeVersion],
 * });
 * await dataSource.initialize();
 *
 * const store = new TypeOrmPolicyStore(dataSource, { entities });
 * ```
 *
 * `entities` is optional — omitted, the store builds the default triple and
 * resolves it against the `DataSource` **by entity name**, so a consumer who
 * registered the factory's output from another module gets the same tables. The
 * scope codec travels on the schemas themselves, so entities and store cannot
 * drift.
 *
 * Metadata is resolved **lazily**, on first use, because a `DataSource` is
 * routinely constructed before it is initialised (and always is, under NestJS):
 * a store that demanded metadata in its constructor could not be a provider.
 */
export class TypeOrmPolicyStore implements PolicyStore {
	readonly #dataSource: DataSource;
	readonly #entities: PermissionsEntities;
	readonly #scopeColumn: ScopeColumnOptions<unknown>;
	readonly #options: TypeOrmPolicyStoreOptions;
	readonly #listeners = new Set<PolicyChangeListener>();
	#resolved: Resolved | undefined;
	#watcher: PolicyChangeWatcher | undefined;
	#notifier: PolicyNotifyListener | undefined;
	/** Exact-precision watermark: the last `updated_at` the poller has already seen. */
	#since: string | undefined;
	#disposed = false;

	constructor(dataSource: DataSource, options: TypeOrmPolicyStoreOptions = {}) {
		this.#dataSource = dataSource;
		this.#options = options;
		this.#entities =
			options.entities ??
			createPermissionsEntities({
				...(options.tablePrefix === undefined ? {} : { tablePrefix: options.tablePrefix }),
				...(options.scopeColumn === undefined
					? {}
					: { scopeColumn: options.scopeColumn as ScopeColumnOptions<string> }),
			});

		const meta = permissionsEntitiesMetaOf(this.#entities.policy);
		const scopeColumn = options.scopeColumn ?? meta?.scopeColumn;
		if (scopeColumn === undefined) {
			throw storeError(
				"TypeOrmPolicyStore could not determine the scope column codec. Build the entities with " +
					"createPermissionsEntities() (which attaches it to the schemas), or pass " +
					"options.scopeColumn explicitly when the schemas were declared by hand.",
			);
		}
		this.#scopeColumn = scopeColumn;
	}

	/** The entity schemas this store reads and writes. */
	get entities(): PermissionsEntities {
		return this.#entities;
	}

	/** Whether this store's scope column can hold the global scope (`''`). */
	get supportsGlobalScope(): boolean {
		return this.#scopeColumn.supportsGlobalScope !== false;
	}

	// -----------------------------------------------------------------------
	// Reads
	// -----------------------------------------------------------------------

	/** {@inheritDoc PolicyStore.load} */
	async load(scope: PolicyScopeId): Promise<PolicyBundle> {
		const scopes = this.#effectiveScopes(scope);
		const values = scopes.map((candidate) => this.#toColumn(candidate));
		const manager = this.#dataSource.manager;

		// **Sequential, not `Promise.all`.** Three concurrent reads through one
		// `EntityManager` is wrong in two ways that only show up in production:
		//
		//   * A pooled manager hands each of them a *different* connection, so the
		//     three halves of a bundle can straddle a concurrent write — policies
		//     from before it, links from after — and the version stamp from either
		//     side. A bundle assembled from two points in time is exactly the input
		//     `buildPolicySet` cannot detect and the cache will keep.
		//   * A manager bound to a query runner (an RLS deployment wrapping the store
		//     in its own `set_config` transaction) has exactly one client, and
		//     overlapping queries on one client are removed in `pg@9`.
		//
		// Three round-trips in sequence cost a fraction of a millisecond each on the
		// cold-load path, which runs once per scope per policy version.
		const policyRows = await manager
			.getRepository<PolicyRow>(this.#entities.policy)
			.find({ where: { scope: In(values) } });
		const linkRows = await manager
			.getRepository<LinkRow>(this.#entities.link)
			.find({ where: { scope: In(values) } });
		const versions = await this.#readVersions(manager, scope);

		const policies = policyRows
			.map((row) => toPolicyRecord(row, this.#toScope(row.scope)))
			.toSorted(byId);
		const links = linkRows.map((row) => toLinkRecord(row, this.#toScope(row.scope))).toSorted(byId);

		this.#assertNoCollisions(policies, links, scope);

		return Object.freeze({
			scope,
			version: versions,
			policies: Object.freeze(policies),
			links: Object.freeze(links),
		});
	}

	/** {@inheritDoc PolicyStore.currentVersion} */
	async currentVersion(scope: PolicyScopeId): Promise<string> {
		return this.#readVersions(this.#dataSource.manager, scope);
	}

	// -----------------------------------------------------------------------
	// Writes
	// -----------------------------------------------------------------------

	/** {@inheritDoc PolicyStore.save} */
	async save(policies: readonly PolicyRecord[]): Promise<void> {
		if (policies.length === 0) {
			return;
		}

		const touched = new Set<PolicyScopeId>();
		for (const record of policies) {
			assertPolicyRecord(record);
			this.#assertWritableScope(record.scope);
			touched.add(record.scope);
		}

		const resolved = this.#resolve();

		await this.#dataSource.transaction(async (manager) => {
			await manager
				.createQueryBuilder()
				.insert()
				.into(this.#entities.policy)
				// `as never`: the scope column's type is the consumer's (`string`, a uuid,
				// a branded id), and `QueryDeepPartialEntity` will not take an `unknown`.
				// The value came out of their own `fromScope`, which is the only thing
				// that knows what it should be.
				.values(
					policies.map((record) => ({
						scope: this.#toColumn(record.scope),
						...policyRowValues(record),
					})) as never,
				)
				.orUpdate(
					[
						"kind",
						"cedar_json",
						"cedar_text",
						"description",
						"annotations",
						"enabled",
						"updated_at",
					],
					[resolved.scopeColumnNames.policy, "policy_id"],
				)
				.execute();

			await this.#bump(manager, touched);
		});

		this.#commit(touched, "save");
	}

	/** {@inheritDoc PolicyStore.delete} */
	async delete(scope: PolicyScopeId, ids: readonly string[]): Promise<void> {
		if (ids.length === 0) {
			return;
		}
		this.#assertWritableScope(scope);

		const scopeValue = this.#toColumn(scope);

		const removed = await this.#dataSource.transaction(async (manager) => {
			const result = await manager
				.createQueryBuilder()
				.delete()
				.from(this.#entities.policy)
				.where("scope = :nestm_scope", { nestm_scope: scopeValue })
				.andWhere("policyId in (:...nestm_ids)", { nestm_ids: [...ids] })
				.execute();

			const count = result.affected ?? 0;
			if (count > 0) {
				await this.#bump(manager, new Set([scope]));
			}
			return count > 0;
		});

		this.#commit(removed ? new Set([scope]) : new Set(), "delete");
	}

	/** {@inheritDoc PolicyStore.linkTemplate} */
	async linkTemplate(link: TemplateLinkRecord): Promise<void> {
		assertLinkRecord(link);
		this.#assertWritableScope(link.scope);

		const resolved = this.#resolve();
		const values = { scope: this.#toColumn(link.scope), ...linkRowValues(link) };

		await this.#dataSource.transaction(async (manager) => {
			await manager
				.createQueryBuilder()
				.insert()
				.into(this.#entities.link)
				.values([values] as never)
				.orUpdate(
					[
						"template_id",
						"principal_type",
						"principal_id",
						"resource_type",
						"resource_id",
						"updated_at",
					],
					[resolved.scopeColumnNames.link, "link_id"],
				)
				.execute();

			await this.#bump(manager, new Set([link.scope]));
		});

		this.#commit(new Set([link.scope]), "link");
	}

	/** {@inheritDoc PolicyStore.unlinkTemplate} */
	async unlinkTemplate(scope: PolicyScopeId, linkId: string): Promise<void> {
		this.#assertWritableScope(scope);

		const scopeValue = this.#toColumn(scope);

		const removed = await this.#dataSource.transaction(async (manager) => {
			const result = await manager
				.createQueryBuilder()
				.delete()
				.from(this.#entities.link)
				.where("scope = :nestm_scope", { nestm_scope: scopeValue })
				.andWhere("linkId = :nestm_link_id", { nestm_link_id: linkId })
				.execute();

			const count = result.affected ?? 0;
			if (count > 0) {
				await this.#bump(manager, new Set([scope]));
			}
			return count > 0;
		});

		this.#commit(removed ? new Set([scope]) : new Set(), "unlink");
	}

	// -----------------------------------------------------------------------
	// Change events (D1)
	// -----------------------------------------------------------------------

	/**
	 * {@inheritDoc PolicyStore.watch}
	 *
	 * Starts the poller on the first subscription and stops it on the last
	 * unsubscribe, so a store nobody watches issues no background queries at all.
	 */
	watch(listener: PolicyChangeListener): Unsubscribe {
		this.#listeners.add(listener);
		this.#startBackground();

		let active = true;
		return () => {
			if (!active) {
				return;
			}
			active = false;
			this.#listeners.delete(listener);
			if (this.#listeners.size === 0) {
				this.#watcher?.stop();
			}
		};
	}

	/**
	 * Stops the poller and closes the LISTEN connection.
	 *
	 * Not part of the `PolicyStore` SPI — the store owns background resources the
	 * SPI does not model, and a process that never calls this keeps a dedicated
	 * `pg` client open. It deliberately does **not** destroy the `DataSource`: the
	 * store was handed one it does not own.
	 */
	async dispose(): Promise<void> {
		this.#disposed = true;
		this.#listeners.clear();
		this.#watcher?.stop();
		this.#watcher = undefined;
		const notifier = this.#notifier;
		this.#notifier = undefined;
		await notifier?.stop();
	}

	/** The poller, once `watch` has started it. Exposed for the watcher tests. */
	get watcher(): PolicyChangeWatcher | undefined {
		return this.#watcher;
	}

	/**
	 * Runs one poll tick immediately, seeding the watermark if needed.
	 *
	 * The suites use it to assert "exactly one event per changed scope" without
	 * waiting on a timer; production goes through {@link watch}.
	 */
	async pollOnce(): Promise<void> {
		if (this.#since === undefined) {
			await this.#seed();
		}
		await this.#tick();
	}

	// -----------------------------------------------------------------------
	// Internals
	// -----------------------------------------------------------------------

	#startBackground(): void {
		if (this.#disposed) {
			return;
		}

		const poll = this.#options.poll;
		if (poll !== false && this.#watcher === undefined) {
			this.#watcher = new PolicyChangeWatcher({
				intervalMs: poll?.intervalMs ?? DEFAULT_POLL_INTERVAL_MS,
				seed: () => this.#seed(),
				tick: () => this.#tick(),
				...(this.#options.onError === undefined ? {} : { onError: this.#options.onError }),
				...(this.#options.timers === undefined ? {} : { timers: this.#options.timers }),
			});
		}
		this.#watcher?.start();

		const notify = this.#options.notify;
		if (notify !== undefined && this.#notifier === undefined) {
			const notifier = new PolicyNotifyListener({
				notify,
				onPayload: (payload) => {
					// The payload is a scope id written by another replica's write. It is
					// only ever used to invalidate a cache, never to authorize anything,
					// so an unexpected value costs a redundant reload and nothing else.
					this.#notify({ scope: payload === "*" ? "*" : payload, reason: "external" });
				},
				...(this.#options.onError === undefined ? {} : { onError: this.#options.onError }),
			});
			this.#notifier = notifier;
			void notifier.start().catch((error: unknown) => {
				this.#options.onError?.(error);
			});
		}
	}

	async #seed(): Promise<void> {
		const { scopeVersionTable, scopeVersionColumns } = this.#resolve();
		const rows = (await this.#dataSource.manager.query(
			`select coalesce(max(${scopeVersionColumns.updatedAt}), now())::text as at from ${scopeVersionTable}`,
		)) as readonly { at: string | null }[];
		this.#since = rows[0]?.at ?? new Date().toISOString();
	}

	/**
	 * One query, whatever the tenant count.
	 *
	 * The watermark is carried as the database's own `::text` rendering rather than
	 * as a JavaScript `Date`: `timestamptz` has microsecond precision and `Date`
	 * has milliseconds, so a millisecond-truncated watermark re-reports the same
	 * row on every tick forever (`updated_at > 12:00:00.000` never excludes
	 * `12:00:00.0005`).
	 */
	async #tick(): Promise<void> {
		const since = this.#since;
		if (since === undefined) {
			return;
		}

		const { scopeVersionTable, scopeVersionColumns } = this.#resolve();
		const rows = (await this.#dataSource.manager.query(
			`select ${scopeVersionColumns.scope} as scope, ${scopeVersionColumns.updatedAt}::text as at ` +
				`from ${scopeVersionTable} where ${scopeVersionColumns.updatedAt} > $1::timestamptz ` +
				`order by ${scopeVersionColumns.updatedAt} desc`,
			[since],
		)) as readonly { scope: unknown; at: string }[];

		if (rows.length === 0) {
			return;
		}

		// Ordered descending, so the first row carries the new watermark. Advanced
		// only here — a throw above leaves it where it was, and the next tick asks
		// the same question again.
		this.#since = rows[0]?.at ?? since;

		// `Set<string>` rather than `Set<PolicyScopeId | "*">`: `PolicyScopeId` *is*
		// `string`, so the union collapses and only the noise survives.
		const scopes = new Set<string>();
		for (const row of rows) {
			const scope = this.#toScope(row.scope);
			scopes.add(isGlobalScope(scope) ? "*" : scope);
		}

		for (const scope of scopes) {
			this.#notify({ scope, reason: "external" });
		}
	}

	/** The scope values `load(scope)` reads: the scope, plus the global one when there is one. */
	#effectiveScopes(scope: PolicyScopeId): readonly PolicyScopeId[] {
		if (isGlobalScope(scope)) {
			this.#assertWritableScope(scope);
			return [GLOBAL_POLICY_SCOPE];
		}
		return this.supportsGlobalScope ? [GLOBAL_POLICY_SCOPE, scope] : [scope];
	}

	#toColumn(scope: PolicyScopeId): unknown {
		return this.#scopeColumn.fromScope(scope);
	}

	#toScope(value: unknown): PolicyScopeId {
		return this.#scopeColumn.toScope(value);
	}

	#assertWritableScope(scope: PolicyScopeId): void {
		if (isGlobalScope(scope) && !this.supportsGlobalScope) {
			throw storeError(
				`This schema's scope column cannot hold the global scope, so "" is not writable. ` +
					`Seed per-tenant templates instead — a NOT NULL tenant column has no value that ` +
					`means "every tenant", and inventing one is how a global policy leaks into a ` +
					`tenant's bundle.`,
				scope,
			);
		}
	}

	/** D2: an id in both halves has undefined precedence, so it is an error, not a winner. */
	#assertNoCollisions(
		policies: readonly PolicyRecord[],
		links: readonly TemplateLinkRecord[],
		scope: PolicyScopeId,
	): void {
		if (isGlobalScope(scope) || !this.supportsGlobalScope) {
			return;
		}

		const globalPolicyIds = new Set(
			policies.filter((record) => isGlobalScope(record.scope)).map((record) => record.id),
		);
		for (const record of policies) {
			if (!isGlobalScope(record.scope) && globalPolicyIds.has(record.id)) {
				throw storeError(
					`Policy id "${record.id}" exists in both the global scope and "${scope}". ` +
						`Ids must be unique across the effective bundle.`,
					scope,
				);
			}
		}

		const globalLinkIds = new Set(
			links.filter((link) => isGlobalScope(link.scope)).map((link) => link.id),
		);
		for (const link of links) {
			if (!isGlobalScope(link.scope) && globalLinkIds.has(link.id)) {
				throw storeError(
					`Template link id "${link.id}" exists in both the global scope and "${scope}". ` +
						`Ids must be unique across the effective bundle.`,
					scope,
				);
			}
		}
	}

	/**
	 * The composite `g<n>:s<m>` version (D2), read as two primary-key lookups.
	 *
	 * A scope with no row is revision 0 — untouched, not missing.
	 */
	async #readVersions(manager: EntityManager, scope: PolicyScopeId): Promise<string> {
		const scopes = this.#effectiveScopes(scope);
		const values = scopes.map((candidate) => this.#toColumn(candidate));

		const rows = await manager
			.getRepository<ScopeVersionRow>(this.#entities.scopeVersion)
			.find({ where: { scope: In(values) } });

		const byScope = new Map<PolicyScopeId, number>();
		for (const row of rows) {
			// `bigint` comes back from node-postgres as a string; `Number` is exact up
			// to 2^53 revisions, which is a great many policy writes.
			byScope.set(this.#toScope(row.scope), Number(row.version));
		}

		const globalRevision = this.supportsGlobalScope
			? (byScope.get(GLOBAL_POLICY_SCOPE) ?? 0)
			: // No global row can exist under this schema, so the global half is
				// pinned at 0 rather than being read and always missing.
				0;
		const scopeRevision = byScope.get(scope) ?? 0;

		return composePolicyVersion(globalRevision, scopeRevision);
	}

	/**
	 * The version bump, in the caller's transaction.
	 *
	 * `INSERT … ON CONFLICT DO UPDATE SET version = version + 1` is monotonic and
	 * immune to clock skew, which a `now()`-based stamp is not: two replicas whose
	 * clocks disagree by a second would otherwise write versions that go backwards.
	 *
	 * Written as raw SQL rather than through `InsertQueryBuilder.orUpdate`, which
	 * can only assign `EXCLUDED` values — it has no spelling for
	 * `version = version + 1`, and an `EXCLUDED.version` of 1 would reset the
	 * counter on every write instead of advancing it.
	 */
	async #bump(manager: EntityManager, scopes: ReadonlySet<PolicyScopeId>): Promise<void> {
		if (scopes.size === 0) {
			return;
		}
		const { scopeVersionTable, scopeVersionColumns } = this.#resolve();

		for (const scope of [...scopes].toSorted()) {
			await manager.query(
				`insert into ${scopeVersionTable} ` +
					`(${scopeVersionColumns.scope}, ${scopeVersionColumns.version}, ${scopeVersionColumns.updatedAt}) ` +
					`values ($1, 1, now()) ` +
					`on conflict (${scopeVersionColumns.scope}) do update set ` +
					`${scopeVersionColumns.version} = ${scopeVersionTable}.${scopeVersionColumns.version} + 1, ` +
					`${scopeVersionColumns.updatedAt} = now()`,
				[this.#toColumn(scope)],
			);

			const notify = this.#options.notify;
			if (notify !== undefined) {
				// In the same transaction as the bump: `pg_notify` is transactional, so a
				// rolled-back write cannot announce itself.
				await manager.query(`select pg_notify($1, $2)`, [
					notify.channel,
					isGlobalScope(scope) ? "*" : scope,
				]);
			}
		}
	}

	#commit(scopes: ReadonlySet<PolicyScopeId>, reason: PolicyChangeReason): void {
		for (const scope of [...scopes].toSorted()) {
			// A global write changes the effective bundle of every scope, so it is
			// broadcast as `'*'` (D2) rather than as a change to `''`.
			this.#notify({ scope: isGlobalScope(scope) ? "*" : scope, reason });
		}
	}

	#notify(event: PolicyChangeEvent): void {
		const failures: unknown[] = [];

		// Every listener is notified even if one throws: a half-notified set of
		// caches is worse than a loud failure after the fact.
		for (const listener of this.#listeners) {
			try {
				listener(event);
			} catch (error) {
				failures.push(error);
			}
		}

		if (failures.length > 0) {
			throw storeError(
				`${String(failures.length)} policy-change listener(s) threw for scope "${event.scope}".`,
				undefined,
				failures[0],
			);
		}
	}

	/** Metadata + escaped identifiers, resolved once and memoised. */
	#resolve(): Resolved {
		const cached = this.#resolved;
		if (cached !== undefined) {
			return cached;
		}

		if (!this.#dataSource.isInitialized) {
			throw storeError(
				"TypeOrmPolicyStore was used before its DataSource was initialised. Call " +
					"`await dataSource.initialize()` first — entity metadata does not exist until then.",
			);
		}

		const metadataFor = (
			schema: PermissionsEntities[keyof PermissionsEntities],
		): EntityMetadata => {
			try {
				return this.#dataSource.getMetadata(schema);
			} catch (cause) {
				throw storeError(
					`TypeOrmPolicyStore could not find entity metadata for ` +
						`"${String((schema as { options?: { name?: string } }).options?.name)}". Register the ` +
						`schemas from createPermissionsEntities() in your DataSource's \`entities\` array.`,
					undefined,
					cause,
				);
			}
		};

		const policy = metadataFor(this.#entities.policy);
		const link = metadataFor(this.#entities.link);
		const scopeVersion = metadataFor(this.#entities.scopeVersion);

		const escape = (name: string): string => this.#dataSource.driver.escape(name);
		const tableOf = (metadata: EntityMetadata): string =>
			metadata.schema === undefined
				? escape(metadata.tableName)
				: `${escape(metadata.schema)}.${escape(metadata.tableName)}`;

		const columnName = (metadata: EntityMetadata, propertyPath: string): string => {
			const column = metadata.findColumnWithPropertyPathStrict(propertyPath);
			if (column === undefined) {
				throw storeError(
					`The entity "${metadata.name}" has no column for the property "${propertyPath}". ` +
						`It was not built by createPermissionsEntities().`,
				);
			}
			return column.databaseName;
		};

		const resolved: Resolved = {
			policy,
			link,
			scopeVersion,
			scopeVersionTable: tableOf(scopeVersion),
			scopeVersionColumns: {
				scope: escape(columnName(scopeVersion, "scope")),
				version: escape(columnName(scopeVersion, "version")),
				updatedAt: escape(columnName(scopeVersion, "updatedAt")),
			},
			scopeColumnNames: {
				policy: columnName(policy, "scope"),
				link: columnName(link, "scope"),
				scopeVersion: columnName(scopeVersion, "scope"),
			},
		};

		this.#resolved = resolved;
		return resolved;
	}
}
