// `@nestm/permissions-typeorm/nestjs` — the optional framework wiring.
//
// This is the **only** file in the package that imports `@nestjs/*`. The base
// entry compiles a `WHERE` clause and talks to Postgres; neither activity needs
// a dependency-injection container, and a migration script or a worker should not
// have to install one to use them. `tests/unit/entry-points.test.ts` asserts the
// separation by loading the barrel with a hostile module resolver.
//
// What it provides is deliberately small: one `TypeOrmPolicyStore`, exported
// under its own class token, so the application composes it itself —
//
// ```ts
// @Module({
//   imports: [
//     TypeOrmModule.forRoot({ …, entities: [entities.policy, entities.link, entities.scopeVersion] }),
//     PermissionsTypeOrmModule.forRootAsync({
//       inject: [DataSource],
//       useFactory: (dataSource: DataSource) => ({ dataSource, store: { entities } }),
//     }),
//     PermissionsModule.forRoot({ vocabulary, store: { useExisting: TypeOrmPolicyStore } }),
//   ],
// })
// export class AppModule {}
// ```
//
// Rather than have this module reach into `@nestm/permissions` and register the
// store there: that would make the TypeORM package depend on the Nest package,
// invert the dependency the workspace is built around, and hide which store an
// application is actually using behind an import order.

import {
	Module,
	type DynamicModule,
	type OnApplicationShutdown,
	type Provider,
} from "@nestjs/common";
import type { DataSource } from "typeorm";

import {
	TypeOrmPolicyStore,
	type TypeOrmPolicyStoreOptions,
} from "./store/typeorm-policy-store.ts";

/** Entry identity. Exported so the built entry has real runtime output. */
export const NESTJS_ENTRY_NAME = "@nestm/permissions-typeorm/nestjs" as const;

/** Injection token holding the resolved {@link PermissionsTypeOrmModuleOptions}. */
export const PERMISSIONS_TYPEORM_OPTIONS = Symbol.for("@nestm/permissions-typeorm:options");

/** What the module needs to build a store. */
export interface PermissionsTypeOrmModuleOptions {
	/**
	 * An initialised (or about-to-be-initialised) `DataSource`.
	 *
	 * The module never creates, initialises or destroys it — under `@nestjs/typeorm`
	 * the `TypeOrmModule` owns that lifecycle, and two owners means a connection
	 * closed while the other still holds it.
	 */
	readonly dataSource: DataSource;
	/** Entities, poll interval, LISTEN/NOTIFY, error sink. */
	readonly store?: TypeOrmPolicyStoreOptions;
}

/** `forRoot` input. */
export interface PermissionsTypeOrmModuleForRootOptions extends PermissionsTypeOrmModuleOptions {
	/**
	 * Register globally, so consumers need not import the module in every feature.
	 * Default `true` — a policy store is process-wide infrastructure, and a second
	 * instance would mean a second poller.
	 */
	readonly global?: boolean;
}

/** `forRootAsync` input. */
export interface PermissionsTypeOrmModuleAsyncOptions {
	/** Modules exporting whatever `useFactory` injects (a `TypeOrmModule`, usually). */
	readonly imports?: DynamicModule["imports"];
	/** Providers to inject into `useFactory`. */
	readonly inject?: readonly unknown[];
	/** Produces the options once the container can supply the `DataSource`. */
	readonly useFactory: (
		...args: never[]
	) => PermissionsTypeOrmModuleOptions | Promise<PermissionsTypeOrmModuleOptions>;
	/** See {@link PermissionsTypeOrmModuleForRootOptions.global}. Default `true`. */
	readonly global?: boolean;
}

/**
 * Provides and exports a {@link TypeOrmPolicyStore}.
 *
 * The store's `dispose()` is wired to the module's lifetime, so the poller stops
 * and any `LISTEN` connection closes when the application shuts down. A store
 * that outlives its application keeps a `pg` client open and a timer scheduled,
 * which shows up as a test run that never exits.
 */
@Module({})
export class PermissionsTypeOrmModule implements OnApplicationShutdown {
	constructor(private readonly store: TypeOrmPolicyStore) {}

	/**
	 * Stops the poller and closes any dedicated `LISTEN` connection.
	 *
	 * The `DataSource` is deliberately left alone — it belongs to whoever created
	 * it, and destroying someone else's connection pool at shutdown is how a
	 * graceful shutdown becomes a stack of "connection terminated" errors.
	 */
	async onApplicationShutdown(): Promise<void> {
		await this.store.dispose();
	}

	/** Registers the store with statically known options. */
	static forRoot(options: PermissionsTypeOrmModuleForRootOptions): DynamicModule {
		const optionsProvider: Provider = {
			provide: PERMISSIONS_TYPEORM_OPTIONS,
			useValue: options,
		};

		return {
			module: PermissionsTypeOrmModule,
			global: options.global !== false,
			providers: [optionsProvider, storeProvider],
			exports: [TypeOrmPolicyStore, PERMISSIONS_TYPEORM_OPTIONS],
		};
	}

	/** Registers the store with options produced by a factory. */
	static forRootAsync(options: PermissionsTypeOrmModuleAsyncOptions): DynamicModule {
		const optionsProvider: Provider = {
			provide: PERMISSIONS_TYPEORM_OPTIONS,
			useFactory: options.useFactory as (...args: unknown[]) => unknown,
			inject: [...(options.inject ?? [])] as never[],
		};

		return {
			module: PermissionsTypeOrmModule,
			global: options.global !== false,
			imports: [...(options.imports ?? [])],
			providers: [optionsProvider, storeProvider],
			exports: [TypeOrmPolicyStore, PERMISSIONS_TYPEORM_OPTIONS],
		};
	}
}

/**
 * The store itself.
 *
 * `useFactory` rather than `useClass` because the constructor takes plain values
 * (a `DataSource`, an options bag) that no container can resolve on its own, and
 * `Symbol`-token injection for them would be ceremony around one `new`.
 */
const storeProvider: Provider = {
	provide: TypeOrmPolicyStore,
	inject: [PERMISSIONS_TYPEORM_OPTIONS],
	useFactory: (options: PermissionsTypeOrmModuleOptions): TypeOrmPolicyStore =>
		new TypeOrmPolicyStore(options.dataSource, options.store ?? {}),
};
