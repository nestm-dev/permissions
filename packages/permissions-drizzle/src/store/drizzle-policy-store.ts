// `DrizzlePolicyStore` — core's `PolicyStore` over three Postgres tables.
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
import { desc, eq, inArray, sql, type SQL } from "drizzle-orm";
import type { PgColumn, PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

import {
	permissionsSchemaMetaOf,
	type PermissionsSchema,
	type ScopeColumnOptions,
} from "../schema.ts";
import { DEFAULT_POLL_INTERVAL_MS, type PolicyStoreDriverOptions } from "./options.ts";
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
} from "./rows.ts";
import { PolicyChangeWatcher, PolicyNotifyListener, type WatcherTimers } from "./watcher.ts";

/**
 * Anything that can run this store's statements.
 *
 * `PgDatabase` is the common supertype of `NodePgDatabase` and the `tx` handed to
 * a `transaction()` callback, which is what lets every private method be written
 * once and used both inside and outside a transaction.
 *
 * It is also the **constructor**'s parameter type. Running the store over a
 * transaction handle is not an exotic call shape but the required one under RLS
 * (`set_config(…, true)` is transaction-local), and this package's own README
 * tells consumers to do it — so a constructor demanding `NodePgDatabase` forced
 * a `as unknown as NodePgDatabase` double-cast at the one call site the design
 * cares most about. A `PgTransaction` is a `PgDatabase` and is not a
 * `NodePgDatabase`; typing the parameter as the supertype the class already uses
 * internally is the whole fix.
 */
export type DrizzlePolicyStoreDatabase = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

/** Options the store accepts, plus the seams its own tests need. */
export interface DrizzlePolicyStoreOptions extends PolicyStoreDriverOptions {
	/** Timer seam for the poller. Tests drive ticks with it; production never sets it. */
	readonly timers?: WatcherTimers;
}

/**
 * Postgres-backed {@link PolicyStore}.
 *
 * ```ts
 * export const { permissionPolicies, permissionPolicyLinks, permissionScopeVersions } =
 *   createPermissionsSchema();
 *
 * const store = new DrizzlePolicyStore(db, {
 *   permissionPolicies, permissionPolicyLinks, permissionScopeVersions,
 * });
 * ```
 *
 * The schema object may be the factory's return value or a re-assembled one —
 * the scope codec travels on the tables themselves, so the two cannot drift.
 */
export class DrizzlePolicyStore implements PolicyStore {
	readonly #db: DrizzlePolicyStoreDatabase;
	readonly #schema: PermissionsSchema;
	readonly #scopeColumn: ScopeColumnOptions<unknown>;
	readonly #options: DrizzlePolicyStoreOptions;
	readonly #listeners = new Set<PolicyChangeListener>();
	#watcher: PolicyChangeWatcher | undefined;
	#notifier: PolicyNotifyListener | undefined;
	/** Exact-precision watermark: the last `updated_at` the poller has already seen. */
	#since: string | undefined;
	#disposed = false;

	constructor(
		db: DrizzlePolicyStoreDatabase,
		schema: PermissionsSchema,
		options: DrizzlePolicyStoreOptions = {},
	) {
		this.#db = db;
		this.#schema = schema;
		this.#options = options;

		const meta = permissionsSchemaMetaOf(schema.permissionPolicies);
		const scopeColumn = options.scopeColumn ?? meta?.scopeColumn;
		if (scopeColumn === undefined) {
			throw storeError(
				"DrizzlePolicyStore could not determine the scope column codec. Build the schema with " +
					"createPermissionsSchema() (which attaches it to the tables), or pass options.scopeColumn " +
					"explicitly when the tables were declared by hand.",
			);
		}
		this.#scopeColumn = scopeColumn;
	}

	/** Whether this store's scope column can hold the global scope (`''`). */
	get supportsGlobalScope(): boolean {
		return this.#scopeColumn.supportsGlobalScope !== false;
	}

	// -----------------------------------------------------------------------
	// Reads
	// -----------------------------------------------------------------------

	/**
	 * {@inheritDoc PolicyStore.load}
	 *
	 * The three reads are issued **sequentially**, and that is deliberate despite
	 * costing two extra round trips. `db` here may be a `transaction()` handle
	 * rather than a pool — which is not an exotic call shape but the *required*
	 * one under row-level security, since `set_config(…, true)` is
	 * transaction-local and a store querying a different pooled connection would
	 * see no tenant context and read nothing. A transaction handle is a single
	 * `pg` client, and overlapping queries on one client are deprecated in
	 * `pg@8` and removed in `pg@9`. `load()` is a cold path (D1: the engine
	 * caches per scope and `watch()` invalidates), so three round trips there is
	 * the cheap side of that trade.
	 */
	async load(scope: PolicyScopeId): Promise<PolicyBundle> {
		const scopes = this.#effectiveScopes(scope);
		const values = scopes.map((candidate) => this.#toColumn(candidate));

		const { permissionPolicies, permissionPolicyLinks } = this.#schema;

		const policyRows = await this.#db
			.select({
				scope: permissionPolicies.scope,
				policyId: permissionPolicies.policyId,
				kind: permissionPolicies.kind,
				cedarJson: permissionPolicies.cedarJson,
				cedarText: permissionPolicies.cedarText,
				description: permissionPolicies.description,
				annotations: permissionPolicies.annotations,
				enabled: permissionPolicies.enabled,
				updatedAt: permissionPolicies.updatedAt,
			})
			.from(permissionPolicies)
			.where(this.#scopeIn(permissionPolicies.scope, values));

		const linkRows = await this.#db
			.select({
				scope: permissionPolicyLinks.scope,
				linkId: permissionPolicyLinks.linkId,
				templateId: permissionPolicyLinks.templateId,
				principalType: permissionPolicyLinks.principalType,
				principalId: permissionPolicyLinks.principalId,
				resourceType: permissionPolicyLinks.resourceType,
				resourceId: permissionPolicyLinks.resourceId,
				updatedAt: permissionPolicyLinks.updatedAt,
			})
			.from(permissionPolicyLinks)
			.where(this.#scopeIn(permissionPolicyLinks.scope, values));

		const versions = await this.#readVersions(this.#db, scope);

		const policies = (policyRows as readonly PolicyRow[])
			.map((row) => toPolicyRecord(row, this.#toScope(row.scope)))
			.toSorted(byId);
		const links = (linkRows as readonly LinkRow[])
			.map((row) => toLinkRecord(row, this.#toScope(row.scope)))
			.toSorted(byId);

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
		return this.#readVersions(this.#db, scope);
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

		const table = this.#schema.permissionPolicies;

		await this.#db.transaction(async (tx) => {
			for (const record of policies) {
				const values = {
					scope: this.#toColumn(record.scope),
					...policyRowValues(record),
				};
				await tx
					.insert(table)
					.values(values as never)
					.onConflictDoUpdate({
						target: [table.scope, table.policyId],
						set: {
							kind: values.kind,
							cedarJson: values.cedarJson,
							cedarText: values.cedarText,
							description: values.description,
							annotations: values.annotations,
							enabled: values.enabled,
							updatedAt: values.updatedAt,
						} as never,
					});
			}
			await this.#bump(tx, touched);
		});

		this.#commit(touched, "save");
	}

	/** {@inheritDoc PolicyStore.delete} */
	async delete(scope: PolicyScopeId, ids: readonly string[]): Promise<void> {
		if (ids.length === 0) {
			return;
		}
		this.#assertWritableScope(scope);

		const table = this.#schema.permissionPolicies;
		const scopeValue = this.#toColumn(scope);

		const removed = await this.#db.transaction(async (tx) => {
			const result = await tx
				.delete(table)
				.where(both(eq(table.scope, scopeValue as never), inArray(table.policyId, [...ids])));
			const count = rowCountOf(result);
			if (count > 0) {
				await this.#bump(tx, new Set([scope]));
			}
			return count > 0;
		});

		this.#commit(removed ? new Set([scope]) : new Set(), "delete");
	}

	/** {@inheritDoc PolicyStore.linkTemplate} */
	async linkTemplate(link: TemplateLinkRecord): Promise<void> {
		assertLinkRecord(link);
		this.#assertWritableScope(link.scope);

		const table = this.#schema.permissionPolicyLinks;
		const values = { scope: this.#toColumn(link.scope), ...linkRowValues(link) };

		await this.#db.transaction(async (tx) => {
			await tx
				.insert(table)
				.values(values as never)
				.onConflictDoUpdate({
					target: [table.scope, table.linkId],
					set: {
						templateId: values.templateId,
						principalType: values.principalType,
						principalId: values.principalId,
						resourceType: values.resourceType,
						resourceId: values.resourceId,
						updatedAt: values.updatedAt,
					} as never,
				});
			await this.#bump(tx, new Set([link.scope]));
		});

		this.#commit(new Set([link.scope]), "link");
	}

	/** {@inheritDoc PolicyStore.unlinkTemplate} */
	async unlinkTemplate(scope: PolicyScopeId, linkId: string): Promise<void> {
		this.#assertWritableScope(scope);

		const table = this.#schema.permissionPolicyLinks;
		const scopeValue = this.#toColumn(scope);

		const removed = await this.#db.transaction(async (tx) => {
			const result = await tx
				.delete(table)
				.where(both(eq(table.scope, scopeValue as never), eq(table.linkId, linkId)));
			const count = rowCountOf(result);
			if (count > 0) {
				await this.#bump(tx, new Set([scope]));
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
	 * `pg` client open.
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
		const table = this.#schema.permissionScopeVersions;
		const rows = await this.#db
			.select({ at: sql<string>`coalesce(max(${table.updatedAt}), now())::text` })
			.from(table);
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

		const table = this.#schema.permissionScopeVersions;
		const rows = await this.#db
			.select({ scope: table.scope, at: sql<string>`${table.updatedAt}::text` })
			.from(table)
			.where(sql`${table.updatedAt} > ${since}::timestamptz`)
			.orderBy(desc(table.updatedAt));

		if (rows.length === 0) {
			return;
		}

		// Ordered descending, so the first row carries the new watermark. Advanced
		// only here — a throw above leaves it where it was, and the next tick asks
		// the same question again.
		this.#since = rows[0]?.at ?? since;

		// `PolicyChangeEvent['scope']` rather than `PolicyScopeId | '*'` spelled out:
		// `PolicyScopeId` is a `string` alias, so the explicit union reads as
		// redundant to a type-aware linter while carrying exactly the meaning core's
		// event type already names.
		const scopes = new Set<PolicyChangeEvent["scope"]>();
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

	#scopeIn(column: PgColumn, values: readonly unknown[]): SQL {
		// Never an empty list: `#effectiveScopes` always yields at least one scope,
		// and drizzle emits `in ()` — a syntax error — for an empty array.
		return inArray(column, values as never[]);
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
	async #readVersions(executor: DrizzlePolicyStoreDatabase, scope: PolicyScopeId): Promise<string> {
		const table = this.#schema.permissionScopeVersions;
		const scopes = this.#effectiveScopes(scope);
		const values = scopes.map((candidate) => this.#toColumn(candidate));

		const rows = await executor
			.select({ scope: table.scope, version: table.version })
			.from(table)
			.where(this.#scopeIn(table.scope, values));

		const byScope = new Map<PolicyScopeId, number>();
		for (const row of rows as readonly { scope: unknown; version: number }[]) {
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
	 */
	async #bump(
		executor: DrizzlePolicyStoreDatabase,
		scopes: ReadonlySet<PolicyScopeId>,
	): Promise<void> {
		if (scopes.size === 0) {
			return;
		}
		const table = this.#schema.permissionScopeVersions;

		for (const scope of [...scopes].toSorted()) {
			await executor
				.insert(table)
				.values({ scope: this.#toColumn(scope), version: 1, updatedAt: sql`now()` } as never)
				.onConflictDoUpdate({
					target: table.scope,
					set: { version: sql`${table.version} + 1`, updatedAt: sql`now()` } as never,
				});

			const notify = this.#options.notify;
			if (notify !== undefined) {
				// In the same transaction as the bump: `pg_notify` is transactional, so a
				// rolled-back write cannot announce itself.
				await executor.execute(
					sql`select pg_notify(${notify.channel}, ${isGlobalScope(scope) ? "*" : scope})`,
				);
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
}

/**
 * `a AND b`, without drizzle's `and()`.
 *
 * `and()` is typed `SQL | undefined` and returns `undefined` for an empty list.
 * Feeding that to `.where()` is not a type error and not a runtime error — it is
 * a `DELETE` with no `WHERE`. Nothing in this package ever produces a condition
 * that might be absent.
 */
function both(left: SQL, right: SQL): SQL {
	return sql`(${left} and ${right})`;
}

/** node-postgres reports affected rows as `rowCount`; drizzle passes the result through. */
function rowCountOf(result: unknown): number {
	const count = (result as { rowCount?: unknown }).rowCount;
	return typeof count === "number" ? count : 0;
}
