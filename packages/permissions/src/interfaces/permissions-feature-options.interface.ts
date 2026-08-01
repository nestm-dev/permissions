import type { ModuleMetadata, Type } from "@nestjs/common";

/** Options for `PermissionsModule.forFeature()`. */
export interface PermissionsFeatureOptions {
	/**
	 * `@EntityProvider()` classes to register as providers. Purely ergonomic —
	 * entity providers are discovered container-wide, so a class listed in any
	 * module's `providers` array works identically (and that is the right place
	 * for one that injects feature-local providers).
	 */
	entityProviders?: Type<unknown>[];
	/**
	 * Modules whose exported providers the entity-provider classes depend on.
	 * They run inside the feature host module, so non-global dependencies must be
	 * imported here.
	 */
	imports?: ModuleMetadata["imports"];
}
