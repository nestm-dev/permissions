import { ModuleRef } from "@nestjs/core";
import type { FactoryProvider } from "@nestjs/common";
import {
	GLOBAL_POLICY_SCOPE,
	MemoryPolicyStore,
	loadCedar,
	policyKindOf,
	policyRecordFromText,
} from "@nestm/permissions-core";
import type {
	CedarBinding,
	PolicyRecord,
	PolicyStore,
	TemplateLinkRecord,
} from "@nestm/permissions-core";

import { resolveProviderDefinition } from "../internal/definition-resolver.ts";
import { PERMISSIONS_MODULE_OPTIONS, POLICY_STORE } from "../permissions.tokens.ts";
import type {
	PermissionsModuleOptions,
	SeedLink,
	SeedPolicy,
} from "../interfaces/permissions-module-options.interface.ts";

/** Timestamp every seeded record carries, so a bundle version is stable across boots. */
const SEED_TIME = new Date(0);

function toPolicyRecord(seed: SeedPolicy, binding: CedarBinding | undefined): PolicyRecord {
	const scope = seed.scope ?? GLOBAL_POLICY_SCOPE;

	if (seed.text !== undefined) {
		// Parsing text is the one seed path that needs Cedar, which is exactly why
		// it happens here — inside the asynchronous provider — and never in
		// `forRoot`, which must stay synchronous and WASM-free.
		if (binding === undefined) {
			throw new Error("PermissionsModule: Cedar binding missing while parsing a text seed policy.");
		}
		return policyRecordFromText(binding, {
			id: seed.id,
			text: seed.text,
			scope,
			...(seed.description === undefined ? {} : { description: seed.description }),
			...(seed.annotations === undefined ? {} : { annotations: seed.annotations }),
			...(seed.enabled === undefined ? {} : { enabled: seed.enabled }),
			updatedAt: SEED_TIME,
		});
	}

	return {
		id: seed.id,
		scope,
		kind: policyKindOf(seed.cedarJson),
		cedarJson: seed.cedarJson,
		...(seed.description === undefined ? {} : { description: seed.description }),
		...(seed.annotations === undefined ? {} : { annotations: seed.annotations }),
		enabled: seed.enabled ?? true,
		updatedAt: SEED_TIME,
	};
}

function toLinkRecord(seed: SeedLink): TemplateLinkRecord {
	return {
		id: seed.id,
		scope: seed.scope ?? GLOBAL_POLICY_SCOPE,
		templateId: seed.templateId,
		values: seed.values,
		updatedAt: SEED_TIME,
	};
}

/**
 * The default store: an in-memory one seeded from `policies` / `links`.
 *
 * `loadCedar()` is awaited only when at least one seed is written as Cedar text;
 * a JSON-only seed set (and the empty one) never touches the WASM.
 */
export async function createSeededMemoryStore(
	options: PermissionsModuleOptions,
): Promise<MemoryPolicyStore> {
	const seeds = options.policies ?? [];
	const needsCedar = seeds.some((seed) => seed.text !== undefined);
	const binding = needsCedar ? await loadCedar() : undefined;

	return new MemoryPolicyStore({
		policies: seeds.map((seed) => toPolicyRecord(seed, binding)),
		links: (options.links ?? []).map(toLinkRecord),
	});
}

/** Resolves `options.store` — every arm of the union, plus the seeded default. */
export async function resolvePolicyStore(
	options: PermissionsModuleOptions,
	moduleRef: ModuleRef,
): Promise<PolicyStore> {
	if (options.store === undefined) {
		return createSeededMemoryStore(options);
	}
	return resolveProviderDefinition(options.store, moduleRef, "store");
}

/** `POLICY_STORE` — the resolved policy store for this module registration. */
export const policyStoreProvider: FactoryProvider<Promise<PolicyStore>> = {
	provide: POLICY_STORE,
	inject: [PERMISSIONS_MODULE_OPTIONS, ModuleRef],
	useFactory: async (options: PermissionsModuleOptions, moduleRef: ModuleRef) =>
		resolvePolicyStore(options, moduleRef),
};
