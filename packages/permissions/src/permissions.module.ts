import { Module } from "@nestjs/common";
import { DiscoveryModule } from "@nestjs/core";
import type { DynamicModule, OnModuleInit } from "@nestjs/common";

import { ConfigurableModuleClass } from "./permissions.module-definition.ts";
import { RouteAuthorizationAudit } from "./audit/route-authorization.audit.ts";
import { PermissionsGuard } from "./guards/permissions.guard.ts";
import { assertPermissionsModuleOptions } from "./internal/assert-options.ts";
import { authorizationEngineProvider } from "./providers/engine.provider.ts";
import { policyStoreProvider } from "./providers/policy-store.provider.ts";
import { principalResolverProvider } from "./providers/principal-resolver.provider.ts";
import { EntityProviderDiscoveryService } from "./services/entity-provider.discovery.service.ts";
import {
	EntityProviderRegistry,
	assertEntityProviderClass,
} from "./services/entity-provider.registry.ts";
import { PermissionsService } from "./services/permissions.service.ts";
import { PolicySetManager } from "./services/policy-set.manager.ts";
import {
	AUTHORIZATION_ENGINE,
	PERMISSIONS_MODULE_OPTIONS,
	POLICY_STORE,
	PRINCIPAL_RESOLVER,
} from "./permissions.tokens.ts";
import type { PermissionsFeatureOptions } from "./interfaces/permissions-feature-options.interface.ts";
import type { PermissionsForRootOptions } from "./permissions.module-definition.ts";

/** Host module for `@EntityProvider()` classes registered via `PermissionsModule.forFeature`. */
@Module({})
export class PermissionsFeatureModule {}

@Module({
	imports: [DiscoveryModule],
	providers: [
		policyStoreProvider,
		EntityProviderRegistry,
		authorizationEngineProvider,
		principalResolverProvider,
		EntityProviderDiscoveryService,
		PolicySetManager,
		PermissionsService,
		PermissionsGuard,
		RouteAuthorizationAudit,
	],
	exports: [
		PERMISSIONS_MODULE_OPTIONS,
		POLICY_STORE,
		AUTHORIZATION_ENGINE,
		PRINCIPAL_RESOLVER,
		EntityProviderRegistry,
		PolicySetManager,
		PermissionsService,
		PermissionsGuard,
		RouteAuthorizationAudit,
	],
})
export class PermissionsModule extends ConfigurableModuleClass implements OnModuleInit {
	constructor(private readonly entityProviders: EntityProviderDiscoveryService) {
		super();
	}

	/**
	 * Runs after every provider in the container has been instantiated, which is
	 * what makes a container-wide scan find entity providers declared in feature
	 * modules — including those registered through `forFeature`.
	 *
	 * `PolicySetManager.onModuleInit` (the warm pass) runs before this one; that
	 * is fine and deliberate — warming loads policies and never touches entities.
	 */
	onModuleInit(): void {
		this.entityProviders.scan();
	}

	/**
	 * Registers the module with statically known options.
	 *
	 * Validation happens here rather than inside the engine factory because
	 * `resolveEngineOptions` is pure and synchronous: a bad `instanceId` or an
	 * out-of-range cache bound should throw from the app module with a stack that
	 * points at the mistake, not from an async provider during bootstrap.
	 */
	static override forRoot(options: PermissionsForRootOptions): DynamicModule {
		assertPermissionsModuleOptions(options);
		return super.forRoot(options);
	}

	/**
	 * Registers `@EntityProvider()` classes as providers. Purely ergonomic —
	 * classes listed in any module's `providers` array are discovered identically
	 * (and that is the right place for one that injects feature-local providers).
	 */
	static forFeature(options: PermissionsFeatureOptions = {}): DynamicModule {
		const entityProviders = options.entityProviders ?? [];
		for (const entityProvider of entityProviders) {
			assertEntityProviderClass(entityProvider);
		}
		return {
			module: PermissionsFeatureModule,
			imports: options.imports ?? [],
			providers: [...entityProviders],
			exports: [...entityProviders],
		};
	}
}
