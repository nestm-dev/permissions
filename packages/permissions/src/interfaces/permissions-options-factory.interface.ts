import type { PermissionsModuleOptions } from "./permissions-module-options.interface.ts";

/**
 * Implement this interface to provide module options via
 * `forRootAsync({ useClass })` / `forRootAsync({ useExisting })`.
 */
export interface PermissionsOptionsFactory {
	createPermissionsOptions(): Promise<PermissionsModuleOptions> | PermissionsModuleOptions;
}
