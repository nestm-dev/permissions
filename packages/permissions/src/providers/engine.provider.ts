import type { FactoryProvider } from "@nestjs/common";
import { createEngine } from "@nestm/permissions-core";
import type {
	AnyVocabulary,
	EngineOptions,
	PermissionsEngine,
	PolicyStore,
} from "@nestm/permissions-core";

import { assertPermissionsModuleOptions } from "../internal/assert-options.ts";
import { claimInstanceId, releaseInstanceId } from "../internal/instance-registry.ts";
import { EntityProviderRegistry } from "../services/entity-provider.registry.ts";
import {
	AUTHORIZATION_ENGINE,
	PERMISSIONS_MODULE_OPTIONS,
	POLICY_STORE,
} from "../permissions.tokens.ts";
import type { PermissionsModuleOptions } from "../interfaces/permissions-module-options.interface.ts";

/** The engine type this package injects. */
export type AuthorizationEngine = PermissionsEngine<AnyVocabulary>;

/**
 * Builds the engine from module options, the resolved store and the composed
 * entity provider.
 *
 * `registry.asEntityProvider()` is captured before discovery has run and reads
 * its registration list on every call, which is what lets the engine exist
 * before `onModuleInit` without the composition being frozen empty.
 */
export async function createAuthorizationEngine(
	options: PermissionsModuleOptions,
	policyStore: PolicyStore,
	registry: EntityProviderRegistry,
): Promise<AuthorizationEngine> {
	// `forRoot` already ran this; `forRootAsync` had no options to validate at
	// registration time, so this is where that path fails fast.
	assertPermissionsModuleOptions(options);

	const explicitInstanceId = options.engine?.instanceId;
	if (explicitInstanceId !== undefined) {
		claimInstanceId(explicitInstanceId);
	}

	const engineOptions: EngineOptions<AnyVocabulary> = {
		vocabulary: options.vocabulary,
		policyStore,
		entityProvider: registry.asEntityProvider(),
		...options.engine,
	};

	try {
		return await createEngine(engineOptions);
	} catch (error) {
		// A failed creation owns no policy-set ids, so the claim has to come back —
		// otherwise a boot that failed on a bad schema poisons every later boot with
		// "instanceId already in use", which points at entirely the wrong problem.
		if (explicitInstanceId !== undefined) {
			releaseInstanceId(explicitInstanceId);
		}
		throw error;
	}
}

/** `AUTHORIZATION_ENGINE` — the live `PermissionsEngine`. */
export const authorizationEngineProvider: FactoryProvider<Promise<AuthorizationEngine>> = {
	provide: AUTHORIZATION_ENGINE,
	inject: [PERMISSIONS_MODULE_OPTIONS, POLICY_STORE, EntityProviderRegistry],
	useFactory: async (
		options: PermissionsModuleOptions,
		policyStore: PolicyStore,
		registry: EntityProviderRegistry,
	) => createAuthorizationEngine(options, policyStore, registry),
};
