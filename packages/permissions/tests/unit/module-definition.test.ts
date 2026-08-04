import "reflect-metadata";
import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { describe, expect, it } from "vitest";
import type { DynamicModule, Provider } from "@nestjs/common";

import {
	MODULE_OPTIONS_TOKEN,
	PERMISSIONS_MODULE_OPTIONS,
	PermissionsGuard,
	PermissionsModule,
	type PermissionsModuleOptions,
} from "../../src/index.ts";
import { SEED_POLICIES, TEST_SCOPE, testVocabulary } from "../shared/test-vocabulary.ts";

const baseOptions: PermissionsModuleOptions = {
	vocabulary: testVocabulary,
	policies: SEED_POLICIES,
	warmScopes: [TEST_SCOPE],
};

@Module({})
class DependencyModule {}

function guardProviders(definition: DynamicModule): Provider[] {
	return (definition.providers ?? []).filter(
		(provider) =>
			typeof provider === "object" && "provide" in provider && provider.provide === APP_GUARD,
	);
}

function optionsProvider(definition: DynamicModule): Provider | undefined {
	return (definition.providers ?? []).find(
		(provider) =>
			typeof provider === "object" &&
			"provide" in provider &&
			provider.provide === PERMISSIONS_MODULE_OPTIONS,
	);
}

describe("module definition", () => {
	it("uses the PERMISSIONS_MODULE_OPTIONS symbol as the options token", () => {
		expect(MODULE_OPTIONS_TOKEN).toBe(PERMISSIONS_MODULE_OPTIONS);
	});

	it("wires forRoot options to the options token", () => {
		const definition = PermissionsModule.forRoot(baseOptions);
		const provider = optionsProvider(definition);

		expect(provider).toBeDefined();
		expect(provider).toMatchObject({ useValue: baseOptions });
	});

	it("adds static imports to the module graph without injecting them as options", () => {
		const definition = PermissionsModule.forRoot({
			...baseOptions,
			imports: [DependencyModule],
		});
		const provider = optionsProvider(definition);

		expect(definition.imports).toEqual([DependencyModule]);
		expect(provider).toMatchObject({ useValue: baseOptions });
		expect(provider).not.toMatchObject({ useValue: { imports: expect.anything() } });
	});

	it("registers the module globally by default", () => {
		expect(PermissionsModule.forRoot(baseOptions).global).toBe(true);
	});

	it("honours isGlobal: false", () => {
		expect(PermissionsModule.forRoot({ ...baseOptions, isGlobal: false }).global).toBe(false);
	});

	it("registers PermissionsGuard as an APP_GUARD by default", () => {
		const guards = guardProviders(PermissionsModule.forRoot(baseOptions));

		expect(guards).toHaveLength(1);
		expect(guards[0]).toMatchObject({ provide: APP_GUARD, useClass: PermissionsGuard });
	});

	it("removes the APP_GUARD when disableGlobalGuard is set", () => {
		const definition = PermissionsModule.forRoot({ ...baseOptions, disableGlobalGuard: true });

		expect(guardProviders(definition)).toHaveLength(0);
	});

	it("exposes forRootAsync with the createPermissionsOptions factory name", () => {
		const definition = PermissionsModule.forRootAsync({
			imports: [DependencyModule],
			useFactory: () => baseOptions,
		});

		expect(definition.module).toBe(PermissionsModule);
		expect(definition.imports).toEqual([DependencyModule]);
		expect(guardProviders(definition)).toHaveLength(1);
	});

	it("names the module itself, not the base ConfigurableModuleClass", () => {
		expect(PermissionsModule.forRoot(baseOptions).module).toBe(PermissionsModule);
	});
});

describe("forRoot option validation", () => {
	it("rejects a vocabulary that is not a defineVocabulary() result", () => {
		expect(() =>
			PermissionsModule.forRoot({ vocabulary: { namespace: "Test" } as never }),
		).toThrowError(/defineVocabulary/);
	});

	it("rejects seeds combined with a caller-supplied store", () => {
		expect(() =>
			PermissionsModule.forRoot({
				vocabulary: testVocabulary,
				store: {} as never,
				policies: SEED_POLICIES,
			}),
		).toThrowError(/cannot be combined with `store`/);
	});

	it("rejects a seed policy declaring neither text nor cedarJson", () => {
		expect(() =>
			PermissionsModule.forRoot({
				vocabulary: testVocabulary,
				policies: [{ id: "broken" } as never],
			}),
		).toThrowError(/exactly one of/);
	});

	it("rejects an out-of-range policy-set cache bound", () => {
		expect(() =>
			PermissionsModule.forRoot({
				vocabulary: testVocabulary,
				engine: { policySetCache: { maxScopes: 0 } },
			}),
		).toThrowError(/positive integer/);
	});

	it("rejects a non-array warmScopes", () => {
		expect(() =>
			PermissionsModule.forRoot({ vocabulary: testVocabulary, warmScopes: "org:acme" as never }),
		).toThrowError(/warmScopes/);
	});
});
