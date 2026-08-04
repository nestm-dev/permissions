import { ConfigurableModuleBuilder } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";

import { PermissionsGuard } from "./guards/permissions.guard.ts";
import { PERMISSIONS_MODULE_OPTIONS } from "./permissions.tokens.ts";
import type {
	PermissionsModuleExtras,
	PermissionsModuleOptions,
} from "./interfaces/permissions-module-options.interface.ts";

export const { ConfigurableModuleClass, MODULE_OPTIONS_TOKEN, OPTIONS_TYPE, ASYNC_OPTIONS_TYPE } =
	new ConfigurableModuleBuilder<PermissionsModuleOptions>({
		optionsInjectionToken: PERMISSIONS_MODULE_OPTIONS,
	})
		.setClassMethodName("forRoot")
		.setFactoryMethodName("createPermissionsOptions")
		.setExtras<PermissionsModuleExtras>(
			{ imports: [], isGlobal: true, disableGlobalGuard: false },
			(definition, extras) => ({
				...definition,
				imports: [...(definition.imports ?? []), ...(extras.imports ?? [])],
				global: extras.isGlobal !== false,
				providers: [
					...(definition.providers ?? []),
					...(extras.disableGlobalGuard
						? []
						: [{ provide: APP_GUARD, useClass: PermissionsGuard }]),
				],
			}),
		)
		.build();

/** Options accepted by `PermissionsModule.forRoot()` (module options + extras). */
export type PermissionsForRootOptions = typeof OPTIONS_TYPE;

/** Options accepted by `PermissionsModule.forRootAsync()`. */
export type PermissionsForRootAsyncOptions = typeof ASYNC_OPTIONS_TYPE;
