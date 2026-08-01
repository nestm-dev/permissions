import { describe, expect, it } from "vitest";

import {
	DEFAULT_INSTANCE_ID_PREFIX,
	generateInstanceId,
	resolveEngineOptions,
	type EngineOptions,
} from "../../src/engine.options.ts";
import { redactContextKeys } from "../../src/diagnostics/decision-event.ts";
import { MemoryPolicyStore } from "../../src/policy/memory-policy-store.ts";
import { DEFAULT_MAX_SCOPES, DEFAULT_STALE_AFTER_MS } from "../../src/runtime/policy-set-cache.ts";
import {
	DEFAULT_ENTITY_CACHE_MAX_ENTRIES,
	DEFAULT_ENTITY_CACHE_TTL_MS,
} from "../../src/entities/entity-cache.ts";
import { stationVocabulary, type StationVocabulary } from "../fixtures/station-vocabulary.ts";

function options(
	overrides: Partial<EngineOptions<StationVocabulary>> = {},
): EngineOptions<StationVocabulary> {
	return { vocabulary: stationVocabulary, policyStore: new MemoryPolicyStore(), ...overrides };
}

describe("defaults", () => {
	it("fills every optional field", () => {
		const resolved = resolveEngineOptions(options());

		expect(resolved).toMatchObject({
			namespace: "Station",
			policySetCache: { maxScopes: DEFAULT_MAX_SCOPES, staleAfterMs: DEFAULT_STALE_AFTER_MS },
			validateOnLoad: true,
			validateRequests: true,
			redactContext: redactContextKeys,
			clock: Date.now,
		});
		expect(resolved.entityProvider).toBeUndefined();
		expect(resolved.onDecision).toBeUndefined();
		expect(resolved.cedar).toBeUndefined();
	});

	it("leaves the entity cache off unless it is asked for", () => {
		expect(resolveEngineOptions(options()).entityCache).toBeUndefined();
		expect(resolveEngineOptions(options({ entityCache: false })).entityCache).toBeUndefined();
	});

	it("resolves an entity cache that was asked for", () => {
		expect(resolveEngineOptions(options({ entityCache: {} })).entityCache).toEqual({
			ttlMs: DEFAULT_ENTITY_CACHE_TTL_MS,
			maxEntries: DEFAULT_ENTITY_CACHE_MAX_ENTRIES,
		});
		expect(resolveEngineOptions(options({ entityCache: { ttlMs: 5_000 } })).entityCache).toEqual({
			ttlMs: 5_000,
			maxEntries: DEFAULT_ENTITY_CACHE_MAX_ENTRIES,
		});
	});

	it("defaults the namespace to the vocabulary's and lets it be overridden", () => {
		expect(resolveEngineOptions(options()).namespace).toBe("Station");
		expect(resolveEngineOptions(options({ namespace: "Acme::Station" })).namespace).toBe(
			"Acme::Station",
		);
	});

	it("keeps the caller's cache tuning", () => {
		expect(
			resolveEngineOptions(options({ policySetCache: { maxScopes: 8, staleAfterMs: 1_000 } }))
				.policySetCache,
		).toEqual({ maxScopes: 8, staleAfterMs: 1_000 });
	});

	it("does not mutate the input", () => {
		const input = options();
		const before = JSON.stringify(Object.keys(input));

		resolveEngineOptions(input);

		expect(JSON.stringify(Object.keys(input))).toBe(before);
		expect(input.instanceId).toBeUndefined();
	});
});

describe("instanceId", () => {
	it("generates a prefixed hex id", () => {
		expect(generateInstanceId()).toMatch(/^perm-[\da-f]{16}$/);
		expect(DEFAULT_INSTANCE_ID_PREFIX).toBe("perm-");
	});

	it("never repeats", () => {
		const ids = new Set(Array.from({ length: 200 }, () => generateInstanceId()));

		expect(ids.size).toBe(200);
	});

	it("is generated when omitted and preserved when given", () => {
		expect(resolveEngineOptions(options()).instanceId).toMatch(/^perm-/);
		expect(resolveEngineOptions(options({ instanceId: "engine-a" })).instanceId).toBe("engine-a");
	});

	it("differs between two resolutions of the same options object", () => {
		const input = options();

		expect(resolveEngineOptions(input).instanceId).not.toBe(resolveEngineOptions(input).instanceId);
	});
});

const clock = (): number => 42;
const onDecision = (): void => undefined;
const redactContext = (): string => "hidden";

describe("seams", () => {
	it("passes the binding, clock, sink and redactor through untouched", () => {
		const cedar = { getCedarLangVersion: () => "4.5" };

		const resolved = resolveEngineOptions(
			options({
				// @ts-expect-error -- a partial binding is enough to prove it is not touched
				cedar,
				clock,
				onDecision,
				redactContext,
			}),
		);

		expect(resolved.cedar).toBe(cedar);
		expect(resolved.clock).toBe(clock);
		expect(resolved.onDecision).toBe(onDecision);
		expect(resolved.redactContext).toBe(redactContext);
	});

	it("keeps the entity provider", () => {
		const entityProvider = { resolvePrincipal: async () => [] };

		expect(resolveEngineOptions(options({ entityProvider })).entityProvider).toBe(entityProvider);
	});

	it("never touches Cedar", async () => {
		const { __cedarLoaded } = await import("../../src/cedar/loader.ts");

		resolveEngineOptions(options());

		expect(__cedarLoaded()).toBe(false);
	});
});

describe("validation", () => {
	it("rejects a missing vocabulary", () => {
		expect(() =>
			// @ts-expect-error -- exercising the runtime guard a JS caller would hit
			resolveEngineOptions({ policyStore: new MemoryPolicyStore() }),
		).toThrowError(/vocabulary must be the result of defineVocabulary/);
	});

	it("rejects something that is not a vocabulary", () => {
		expect(() =>
			resolveEngineOptions({
				// @ts-expect-error -- a raw definition object is not a built vocabulary
				vocabulary: { namespace: "X" },
				policyStore: new MemoryPolicyStore(),
			}),
		).toThrowError(/defineVocabulary/);
	});

	it("rejects a missing policy store", () => {
		expect(() =>
			// @ts-expect-error -- exercising the runtime guard a JS caller would hit
			resolveEngineOptions({ vocabulary: stationVocabulary }),
		).toThrowError(/policyStore is required/);
	});

	it("rejects an empty namespace", () => {
		expect(() => resolveEngineOptions(options({ namespace: "" }))).toThrowError(
			/namespace must be a non-empty/,
		);
	});

	it("rejects an empty instanceId", () => {
		expect(() => resolveEngineOptions(options({ instanceId: "" }))).toThrowError(
			/instanceId must be a non-empty string/,
		);
	});

	it("rejects non-positive-integer bounds", () => {
		expect(() => resolveEngineOptions(options({ policySetCache: { maxScopes: 0 } }))).toThrowError(
			/policySetCache.maxScopes must be a positive integer/,
		);
		expect(() =>
			resolveEngineOptions(options({ policySetCache: { staleAfterMs: -1 } })),
		).toThrowError(/policySetCache.staleAfterMs must be a positive integer/);
		expect(() => resolveEngineOptions(options({ entityCache: { ttlMs: 1.5 } }))).toThrowError(
			/entityCache.ttlMs must be a positive integer/,
		);
		expect(() => resolveEngineOptions(options({ entityCache: { maxEntries: 0 } }))).toThrowError(
			/entityCache.maxEntries must be a positive integer/,
		);
	});

	it("raises every failure as an ENGINE_INIT PermissionsError", () => {
		expect(() => resolveEngineOptions(options({ namespace: "" }))).toThrowError(
			expect.objectContaining({ name: "PermissionsError", code: "ENGINE_INIT" }),
		);
	});
});
