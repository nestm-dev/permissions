// `@nestm/permissions-drizzle/nestjs` — the optional framework wiring.
//
// This is the **only** file in the package that imports `@nestjs/*`. The base
// entry compiles a `WHERE` clause and talks to Postgres; neither activity needs
// a dependency-injection container, and a migration script or a worker should not
// have to install one to use them. `tests/unit/entry-points.test.ts` asserts the
// separation by loading the barrel with a hostile module resolver.
//
// What it provides is deliberately small: one `DrizzlePolicyStore`, exported
// under its own class token, so the application composes it itself —
//
// ```ts
// @Module({
//   imports: [
//     PermissionsDrizzleModule.forRoot({ db, schema }),
//     PermissionsModule.forRoot({
//       vocabulary,
//       store: { useExisting: DrizzlePolicyStore },
//     }),
//   ],
// })
// export class AppModule {}
// ```
//
// Rather than have this module reach into `@nestm/permissions` and register the
// store there: that would make the drizzle package depend on the Nest package,
// invert the dependency the workspace is built around, and hide which store an
// application is actually using behind an import order.

import {
	Module,
	type DynamicModule,
	type OnApplicationShutdown,
	type Provider,
} from "@nestjs/common";
import type { PermissionsSchema } from "./schema.ts";
import {
	DrizzlePolicyStore,
	type DrizzlePolicyStoreDatabase,
	type DrizzlePolicyStoreOptions,
} from "./store/drizzle-policy-store.ts";

/** Entry identity. Exported so the built entry has real runtime output. */
export const NESTJS_ENTRY_NAME = "@nestm/permissions-drizzle/nestjs" as const;

/** Injection token holding the resolved {@link PermissionsDrizzleModuleOptions}. */
export const PERMISSIONS_DRIZZLE_OPTIONS = Symbol.for("@nestm/permissions-drizzle:options");

/** What the module needs to build a store. */
export interface PermissionsDrizzleModuleOptions {
	/**
	 * A `drizzle(pool)` instance. The module never creates or owns a connection.
	 *
	 * Typed as the `PgDatabase` supertype the store itself uses, so a `drizzle()`
	 * from any pg driver fits without a cast. A `transaction()` handle also fits
	 * structurally and must not be passed *here* — the module's store outlives any
	 * transaction. Under transaction-local RLS, pass the pool here and configure
	 * `store.executor` with the request-aware transaction executor.
	 */
	readonly db: DrizzlePolicyStoreDatabase;
	/** The three tables, from `createPermissionsSchema` or re-assembled from consts. */
	readonly schema: PermissionsSchema;
	/** Poll interval, LISTEN/NOTIFY, error sink. */
	readonly store?: DrizzlePolicyStoreOptions;
}

/** `forRoot` input. */
export interface PermissionsDrizzleModuleForRootOptions extends PermissionsDrizzleModuleOptions {
	/**
	 * Register globally, so consumers need not import the module in every feature.
	 * Default `true` — a policy store is process-wide infrastructure, and a second
	 * instance would mean a second poller.
	 */
	readonly global?: boolean;
}

/** `forRootAsync` input. */
export interface PermissionsDrizzleModuleAsyncOptions {
	/** Modules exporting whatever `useFactory` injects (a `DatabaseModule`, usually). */
	readonly imports?: DynamicModule["imports"];
	/** Providers to inject into `useFactory`. */
	readonly inject?: readonly unknown[];
	/** Produces the options once the container can supply the database. */
	readonly useFactory: (
		...args: never[]
	) => PermissionsDrizzleModuleOptions | Promise<PermissionsDrizzleModuleOptions>;
	/** See {@link PermissionsDrizzleModuleForRootOptions.global}. Default `true`. */
	readonly global?: boolean;
}

/**
 * Provides and exports a {@link DrizzlePolicyStore}.
 *
 * The store's `dispose()` is wired to the module's lifetime, so the poller stops
 * and any `LISTEN` connection closes when the application shuts down. A store
 * that outlives its application keeps a `pg` client open and a timer scheduled,
 * which shows up as a test run that never exits.
 */
@Module({})
export class PermissionsDrizzleModule implements OnApplicationShutdown {
	constructor(private readonly store: DrizzlePolicyStore) {}

	/**
	 * Stops the poller and closes any dedicated `LISTEN` connection.
	 *
	 * A store that outlives its application keeps a `pg` client open and a timer
	 * scheduled, which surfaces as a test run — or a graceful shutdown — that never
	 * finishes.
	 */
	async onApplicationShutdown(): Promise<void> {
		await this.store.dispose();
	}

	/** Registers the store with statically known options. */
	static forRoot(options: PermissionsDrizzleModuleForRootOptions): DynamicModule {
		const optionsProvider: Provider = {
			provide: PERMISSIONS_DRIZZLE_OPTIONS,
			useValue: options,
		};

		return {
			module: PermissionsDrizzleModule,
			global: options.global !== false,
			providers: [optionsProvider, storeProvider],
			exports: [DrizzlePolicyStore, PERMISSIONS_DRIZZLE_OPTIONS],
		};
	}

	/** Registers the store with options produced by a factory. */
	static forRootAsync(options: PermissionsDrizzleModuleAsyncOptions): DynamicModule {
		const optionsProvider: Provider = {
			provide: PERMISSIONS_DRIZZLE_OPTIONS,
			useFactory: options.useFactory as (...args: unknown[]) => unknown,
			inject: [...(options.inject ?? [])] as never[],
		};

		return {
			module: PermissionsDrizzleModule,
			global: options.global !== false,
			imports: [...(options.imports ?? [])],
			providers: [optionsProvider, storeProvider],
			exports: [DrizzlePolicyStore, PERMISSIONS_DRIZZLE_OPTIONS],
		};
	}
}

/**
 * The store itself.
 *
 * `useFactory` rather than `useClass` because the constructor takes plain values
 * (a database handle, a table triple) that no container can resolve on its own,
 * and `Symbol`-token injection for three of them would be ceremony around one
 * `new`.
 */
const storeProvider: Provider = {
	provide: DrizzlePolicyStore,
	inject: [PERMISSIONS_DRIZZLE_OPTIONS],
	useFactory: (options: PermissionsDrizzleModuleOptions): DrizzlePolicyStore =>
		new DrizzlePolicyStore(options.db, options.schema, options.store ?? {}),
};
