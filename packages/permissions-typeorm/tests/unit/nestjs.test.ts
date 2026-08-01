// `PermissionsTypeOrmModule` — the shape of what it registers.
//
// The module is deliberately thin: one provider, one export, one lifecycle hook.
// What is worth asserting is therefore not behaviour but *contract*, and the
// three items below are each a thing an application would only discover in
// production:
//
//   * the store is exported under its **class** token, so `store: { useExisting:
//     TypeOrmPolicyStore }` in `PermissionsModule.forRoot` resolves;
//   * the module is **global** by default, because a second instance means a
//     second poller and a second `LISTEN` connection;
//   * `onApplicationShutdown` disposes the store but **not** the `DataSource`,
//     which belongs to whoever created it.
//
// Asserted against the metadata rather than by booting a Nest application: a
// container boot would need `@nestjs/core`, `reflect-metadata` and a real
// database, to check three properties that are right there in the object.

import type { DynamicModule, Provider } from "@nestjs/common";
import { DataSource } from "typeorm";
import { describe, expect, it } from "vitest";

import { createPermissionsEntities } from "../../src/entities/create-entities.ts";
import {
	PERMISSIONS_TYPEORM_OPTIONS,
	PermissionsTypeOrmModule,
	type PermissionsTypeOrmModuleOptions,
} from "../../src/nestjs.ts";
import { TypeOrmPolicyStore } from "../../src/store/typeorm-policy-store.ts";

const entities = createPermissionsEntities();

function dataSource(): DataSource {
	// Never initialised: the module must be constructible before the connection
	// exists, which is the normal order under `@nestjs/typeorm`.
	return new DataSource({
		type: "postgres",
		entities: [entities.policy, entities.link, entities.scopeVersion],
	});
}

/** Finds the provider registered under a token. */
function providerFor(module: DynamicModule, token: unknown): Provider | undefined {
	return module.providers?.find(
		(provider) =>
			typeof provider === "object" && "provide" in provider && provider.provide === token,
	);
}

describe("PermissionsTypeOrmModule.forRoot", () => {
	it("provides and exports the store under its class token", () => {
		const module = PermissionsTypeOrmModule.forRoot({ dataSource: dataSource() });

		expect(module.module).toBe(PermissionsTypeOrmModule);
		expect(module.exports).toEqual([TypeOrmPolicyStore, PERMISSIONS_TYPEORM_OPTIONS]);
		expect(providerFor(module, TypeOrmPolicyStore)).toBeDefined();
		expect(providerFor(module, PERMISSIONS_TYPEORM_OPTIONS)).toBeDefined();
	});

	it("is global by default, because two stores means two pollers", () => {
		expect(PermissionsTypeOrmModule.forRoot({ dataSource: dataSource() }).global).toBe(true);
		expect(
			PermissionsTypeOrmModule.forRoot({ dataSource: dataSource(), global: false }).global,
		).toBe(false);
	});

	it("builds a real store from the options token", () => {
		const source = dataSource();
		const module = PermissionsTypeOrmModule.forRoot({
			dataSource: source,
			store: { entities, poll: false },
		});

		const provider = providerFor(module, TypeOrmPolicyStore) as {
			inject: unknown[];
			useFactory: (options: PermissionsTypeOrmModuleOptions) => TypeOrmPolicyStore;
		};

		expect(provider.inject).toEqual([PERMISSIONS_TYPEORM_OPTIONS]);

		const store = provider.useFactory({
			dataSource: source,
			store: { entities, poll: false },
		});
		expect(store).toBeInstanceOf(TypeOrmPolicyStore);
		expect(store.entities).toBe(entities);
		expect(store.supportsGlobalScope).toBe(true);
	});
});

describe("PermissionsTypeOrmModule.forRootAsync", () => {
	it("wires the factory and its injections through", () => {
		const token = Symbol("DATA_SOURCE");
		const module = PermissionsTypeOrmModule.forRootAsync({
			imports: [],
			inject: [token],
			useFactory: ((source: DataSource) => ({ dataSource: source })) as never,
		});

		const provider = providerFor(module, PERMISSIONS_TYPEORM_OPTIONS) as {
			inject: unknown[];
			useFactory: (source: DataSource) => PermissionsTypeOrmModuleOptions;
		};

		expect(provider.inject).toEqual([token]);
		expect(module.imports).toEqual([]);
		expect(module.exports).toEqual([TypeOrmPolicyStore, PERMISSIONS_TYPEORM_OPTIONS]);

		const source = dataSource();
		expect(provider.useFactory(source).dataSource).toBe(source);
	});

	it("defaults `inject` and `imports` to empty rather than undefined", () => {
		const module = PermissionsTypeOrmModule.forRootAsync({
			useFactory: (() => ({ dataSource: dataSource() })) as never,
		});
		expect(module.imports).toEqual([]);
		expect(
			(providerFor(module, PERMISSIONS_TYPEORM_OPTIONS) as { inject: unknown[] }).inject,
		).toEqual([]);
	});
});

describe("lifecycle", () => {
	it("disposes the store on shutdown and leaves the DataSource alone", async () => {
		const source = dataSource();
		const store = new TypeOrmPolicyStore(source, { entities, poll: false });
		const module = new PermissionsTypeOrmModule(store);

		let disposed = false;
		const original = store.dispose.bind(store);
		store.dispose = async (): Promise<void> => {
			disposed = true;
			await original();
		};

		await module.onApplicationShutdown();

		expect(disposed).toBe(true);
		// Destroying someone else's pool at shutdown turns a graceful stop into a
		// stack of "connection terminated" errors from whatever else was using it.
		expect(source.isInitialized).toBe(false);
	});
});
