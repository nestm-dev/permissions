import { ModuleRef } from "@nestjs/core";
import type { FactoryProvider } from "@nestjs/common";

import {
	PRINCIPAL_RESOLVER_DEFINITION_DEPENDENCIES_READY,
	resolveProviderDefinition,
} from "../internal/definition-resolver.ts";
import type { ProviderDefinitionDependencies } from "../internal/definition-resolver.ts";
import { PERMISSIONS_MODULE_OPTIONS, PRINCIPAL_RESOLVER } from "../permissions.tokens.ts";
import type { PermissionsModuleOptions } from "../interfaces/permissions-module-options.interface.ts";
import type { PrincipalResolver } from "../interfaces/principal-resolver.interface.ts";

/** Resolves `options.principalResolver`, or `undefined` when none was configured. */
export async function resolvePrincipalResolver(
	options: PermissionsModuleOptions,
	moduleRef: ModuleRef,
	dependencies?: ProviderDefinitionDependencies,
): Promise<PrincipalResolver | undefined> {
	if (options.principalResolver === undefined) {
		return undefined;
	}
	return resolveProviderDefinition(
		options.principalResolver,
		moduleRef,
		"principalResolver",
		dependencies,
	);
}

/**
 * `PRINCIPAL_RESOLVER` — the configured resolver, or `undefined`.
 *
 * Always provided, even when unconfigured: injecting the token then yields
 * `undefined` instead of an "unknown provider" DI failure, which is what lets
 * the guard (next slice) treat "no resolver" as a configuration state it can
 * report rather than a crash at bootstrap.
 */
export const principalResolverProvider: FactoryProvider<Promise<PrincipalResolver | undefined>> = {
	provide: PRINCIPAL_RESOLVER,
	inject: [
		PERMISSIONS_MODULE_OPTIONS,
		ModuleRef,
		{ token: PRINCIPAL_RESOLVER_DEFINITION_DEPENDENCIES_READY, optional: true },
	],
	useFactory: async (
		options: PermissionsModuleOptions,
		moduleRef: ModuleRef,
		dependencies?: ProviderDefinitionDependencies,
	) => resolvePrincipalResolver(options, moduleRef, dependencies),
};
