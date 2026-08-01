import { Inject, Injectable, Logger, ServiceUnavailableException } from "@nestjs/common";
import type { OnApplicationShutdown, OnModuleInit } from "@nestjs/common";
import { GLOBAL_POLICY_SCOPE } from "@nestm/permissions-core";
import type { PolicyScopeId, PolicyStore } from "@nestm/permissions-core";

import { releaseInstanceId } from "../internal/instance-registry.ts";
import {
	AUTHORIZATION_ENGINE,
	PERMISSIONS_MODULE_OPTIONS,
	POLICY_STORE,
} from "../permissions.tokens.ts";
import type { AuthorizationEngine } from "../providers/engine.provider.ts";
import type { PermissionsModuleOptions } from "../interfaces/permissions-module-options.interface.ts";

/**
 * Owns the engine's lifecycle: warm at boot, invalidate on demand, dispose at
 * shutdown.
 *
 * Much thinner than the design's two-phase `PolicySetManager` because the
 * shipped core made phase B unnecessary: policy sets are loaded **lazily per
 * scope** by the engine's own `PolicySetCache`, so there is no "load the policy
 * set at `OnModuleInit`" step and therefore no `'unloaded' | 'ready' | 'stale'`
 * state machine to keep. What is left is genuinely stateful:
 *
 * - **warm** the scopes the app knows it needs immediately, failure being a
 *   logged warning rather than a boot failure — the lazy path retries on the
 *   first check, so a store that is slow to come up costs latency, not uptime;
 * - **assertReady**, which the guard calls before every decision. It fails only
 *   on a disposed engine, and it fails with 503 — never with a silent deny;
 * - **dispose**, which is terminal in core (every later check throws
 *   `ENGINE_INIT`), so it has to be tied to application shutdown and nothing
 *   else.
 */
@Injectable()
export class PolicySetManager implements OnModuleInit, OnApplicationShutdown {
	private readonly logger = new Logger(PolicySetManager.name);

	constructor(
		@Inject(AUTHORIZATION_ENGINE) private readonly engine: AuthorizationEngine,
		@Inject(POLICY_STORE) private readonly store: PolicyStore,
		@Inject(PERMISSIONS_MODULE_OPTIONS) private readonly options: PermissionsModuleOptions,
	) {}

	async onModuleInit(): Promise<void> {
		const scopes = this.options.warmScopes ?? [];
		for (const scope of scopes) {
			try {
				await this.engine.warm(scope);
			} catch (error) {
				this.logger.warn(
					`Could not warm policy scope "${scope}" at boot: ${describe(error)}. It will be ` +
						"loaded lazily on its first check.",
				);
			}
		}
	}

	/** The engine this manager owns. */
	get authorizationEngine(): AuthorizationEngine {
		return this.engine;
	}

	/**
	 * @throws `ServiceUnavailableException` when the engine can no longer decide.
	 *
	 * Fail closed, and fail *visibly*: a disposed engine answering `deny` would be
	 * indistinguishable from a policy denial, so the caller gets a 503 instead.
	 */
	assertReady(): void {
		if (this.engine === undefined || this.engine.disposed) {
			throw new ServiceUnavailableException(
				"The authorization engine is not available. Requests are refused rather than " +
					"decided without policies.",
			);
		}
	}

	/**
	 * Marks every cached scope stale; the next check reloads it.
	 *
	 * Nothing is unloaded — a stale-but-known policy set keeps answering until a
	 * reload succeeds, which is strictly better than an empty one.
	 */
	async reload(): Promise<void> {
		await this.invalidate("*");
	}

	/**
	 * Marks **one** scope stale, or every scope with `'*'`.
	 *
	 * The per-scope form is what a grant-write flow wants. A store that implements
	 * `watch` already emits the event and needs none of this; a store that does not
	 * — a projection of the application's own tables, a composite over a read-only
	 * source — leaves the writer holding the only knowledge that anything changed,
	 * and `reload()` was the only way to say so. Dropping every tenant's cache to
	 * publish one tenant's grant makes every other tenant pay a cold load, which on
	 * a busy instance is a thundering herd against the policy store.
	 *
	 * Compiled query plans for the scope are dropped outright rather than served
	 * stale (core's contract), so this is safe to call on the write path.
	 */
	// oxlint-disable-next-line typescript/no-redundant-type-constituents -- `PolicyScopeId` widens to `string`, but spelling the sentinel out is the contract
	async invalidate(scope: PolicyScopeId | "*"): Promise<void> {
		this.assertReady();
		await this.engine.invalidate(scope);
	}

	/**
	 * The store's current version string for `scope` (`g<n>:s<m>`).
	 *
	 * Reads the store rather than the engine: the shipped engine exposes no
	 * per-scope revision, and the store's `currentVersion` is the value the
	 * cache's own freshness logic compares against.
	 */
	async revision(scope: PolicyScopeId = GLOBAL_POLICY_SCOPE): Promise<string> {
		this.assertReady();
		return this.store.currentVersion(scope);
	}

	async onApplicationShutdown(): Promise<void> {
		const instanceId = this.engine.instanceId;
		await this.engine.dispose();
		releaseInstanceId(instanceId);
	}
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
