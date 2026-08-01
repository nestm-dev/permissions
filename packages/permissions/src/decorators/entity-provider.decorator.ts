import { DiscoveryService } from "@nestjs/core";

import { METADATA_KEY } from "../permissions.constants.ts";

/** Options accepted by `@EntityProvider()`. */
export interface EntityProviderOptions {
	/**
	 * Composition order, lower first; ties keep registration order.
	 *
	 * Matters for `resolvePrincipal`, where the first provider returning a
	 * non-empty graph wins.
	 */
	readonly order?: number;
}

const discoverable = DiscoveryService.createDecorator<EntityProviderOptions>();

/**
 * Marks a provider class as a contributor to the Cedar entity graph.
 *
 * Discovered container-wide at `onModuleInit`, so a class listed in any module's
 * `providers` array is registered — `PermissionsModule.forFeature()` is the
 * ergonomic shorthand. Must be singleton-scoped: the registry holds the instance
 * for the lifetime of the application.
 *
 * The class implements any subset of `FeatureEntityProvider`; per-feature
 * knowledge is the point (tenancy knows Organizations, projects knows Projects).
 */
export function EntityProvider(options: EntityProviderOptions = {}): ClassDecorator {
	return (target) => {
		discoverable(options)(target);
		// Mirrored onto a stable string key as well: `DiscoveryService` generates a
		// per-process uuid for its own key, which is useless to anything wanting to
		// recognise an entity provider from outside this module (the boot-time
		// route audit, a third-party test helper).
		Reflect.defineMetadata(METADATA_KEY.entityProvider, options, target);
	};
}

/** Discovery metadata key `DiscoveryService.getProviders()` filters on. */
EntityProvider.KEY = discoverable.KEY;
