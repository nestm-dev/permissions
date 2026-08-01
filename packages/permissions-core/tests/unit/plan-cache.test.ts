import { describe, expect, it } from "vitest";

import type { EntityJson } from "../../src/cedar/binding.ts";
import {
	DEFAULT_PLAN_CACHE_MAX,
	DEFAULT_PLAN_CACHE_TTL_MS,
	PlanCache,
	canonicalEntityGraph,
	planCacheKey,
	type PlanCacheKeyInput,
} from "../../src/runtime/plan-cache.ts";

function entity(
	type: string,
	id: string,
	attrs: Record<string, unknown> = {},
	parents: EntityJson["parents"] = [],
): EntityJson {
	return {
		uid: { type, id },
		attrs: attrs as EntityJson["attrs"],
		parents,
	};
}

const MEMBER = entity(
	"Station::Member",
	"m1",
	{ organization: { __entity: { type: "Station::Organization", id: "o1" } }, identitySubject: "s" },
	[
		{ type: "Station::Role", id: "admin" },
		{ type: "Station::Organization", id: "o1" },
	],
);

function key(overrides: Partial<PlanCacheKeyInput> = {}): string {
	return planCacheKey({
		instanceId: "perm-1",
		scope: "org:1",
		policySetVersion: "g0:s1",
		principal: { type: "Member", id: "m1" },
		entities: [MEMBER],
		action: "run:read",
		resourceType: "Run",
		context: null,
		vocabHash: "schema-abc",
		...overrides,
	});
}

// ---------------------------------------------------------------------------
// Keying
// ---------------------------------------------------------------------------

describe("planCacheKey", () => {
	it("is stable for identical input", () => {
		expect(key()).toBe(key());
	});

	it.each([
		["instanceId", { instanceId: "perm-2" }],
		["scope", { scope: "org:2" }],
		["policySetVersion", { policySetVersion: "g0:s2" }],
		["principal", { principal: { type: "Member", id: "m2" } }],
		["action", { action: "run:dispatch" }],
		["resourceType", { resourceType: "Project" }],
		["context", { context: { mfa: true } }],
		["vocabHash", { vocabHash: "schema-def" }],
	])("changes with %s", (_label, overrides) => {
		expect(key(overrides as Partial<PlanCacheKeyInput>)).not.toBe(key());
	});

	it("changes when a principal ancestor changes", () => {
		const other = entity("Station::Member", "m1", MEMBER.attrs as Record<string, unknown>, [
			{ type: "Station::Role", id: "viewer" },
		]);

		expect(key({ entities: [other] })).not.toBe(key());
	});

	it("changes when a principal *attribute* changes", () => {
		// core.md §5.6 keys on ancestors only. That is not enough: a residual folds
		// `principal.organization` into a literal, so two members with the same
		// roles and different organisations must not share a plan.
		const otherOrg = entity(
			"Station::Member",
			"m1",
			{
				organization: { __entity: { type: "Station::Organization", id: "o2" } },
				identitySubject: "s",
			},
			[
				{ type: "Station::Role", id: "admin" },
				{ type: "Station::Organization", id: "o1" },
			],
		);

		expect(key({ entities: [otherOrg] })).not.toBe(key());
	});

	it("is independent of ancestor order", () => {
		const reordered = entity("Station::Member", "m1", MEMBER.attrs as Record<string, unknown>, [
			{ type: "Station::Organization", id: "o1" },
			{ type: "Station::Role", id: "admin" },
		]);

		expect(key({ entities: [reordered] })).toBe(key());
	});

	it("is independent of entity order in the graph", () => {
		const role = entity("Station::Role", "admin");
		const organization = entity("Station::Organization", "o1");

		expect(key({ entities: [MEMBER, role, organization] })).toBe(
			key({ entities: [organization, role, MEMBER] }),
		);
	});

	it("is independent of attribute key order", () => {
		const reordered = entity(
			"Station::Member",
			"m1",
			{
				identitySubject: "s",
				organization: { __entity: { type: "Station::Organization", id: "o1" } },
			},
			[...MEMBER.parents],
		);

		expect(key({ entities: [reordered] })).toBe(key());
	});

	it("is independent of context key order", () => {
		expect(key({ context: { a: 1, b: 2 } })).toBe(key({ context: { b: 2, a: 1 } }));
	});

	it("distinguishes the two UID encodings' *contents*, not their spelling", () => {
		const escaped: EntityJson = {
			...MEMBER,
			uid: { __entity: { type: "Station::Member", id: "m1" } },
		};

		expect(key({ entities: [escaped] })).toBe(key());
	});

	it("is a fixed-length hash whatever the graph size", () => {
		const many = Array.from({ length: 200 }, (_value, index) =>
			entity("Station::Role", `r${String(index)}`),
		);

		expect(key({ entities: many })).toHaveLength(64);
	});
});

describe("canonicalEntityGraph", () => {
	it("separates entities so two graphs cannot collide by concatenation", () => {
		const a = canonicalEntityGraph([entity("T", "ab"), entity("T", "c")]);
		const b = canonicalEntityGraph([entity("T", "a"), entity("T", "bc")]);

		expect(a).not.toBe(b);
	});

	it("includes tags when present", () => {
		const tagged: EntityJson = { ...entity("T", "a"), tags: { k: "v" } };

		expect(canonicalEntityGraph([tagged])).not.toBe(canonicalEntityGraph([entity("T", "a")]));
	});
});

// ---------------------------------------------------------------------------
// The cache
// ---------------------------------------------------------------------------

describe("PlanCache", () => {
	it("uses the documented defaults", () => {
		expect(new PlanCache<string>().stats()).toMatchObject({
			max: DEFAULT_PLAN_CACHE_MAX,
			ttlMs: DEFAULT_PLAN_CACHE_TTL_MS,
		});
		expect(DEFAULT_PLAN_CACHE_MAX).toBe(2000);
		expect(DEFAULT_PLAN_CACHE_TTL_MS).toBe(30_000);
	});

	it("hits and misses", () => {
		const cache = new PlanCache<string>();

		expect(cache.get("k")).toBeUndefined();
		cache.set("k", "org:1", "plan");
		expect(cache.get("k")).toBe("plan");
		expect(cache.stats()).toMatchObject({ hits: 1, misses: 1, entries: 1 });
	});

	it("expires an entry past its TTL and counts it as a miss", () => {
		let now = 0;
		const cache = new PlanCache<string>({ ttlMs: 100, clock: () => now });

		cache.set("k", "org:1", "plan");
		now = 99;
		expect(cache.get("k")).toBe("plan");

		now = 199;
		expect(cache.get("k")).toBeUndefined();
		expect(cache.stats()).toMatchObject({ expirations: 1, misses: 1, entries: 0 });
	});

	it("evicts the least recently used entry at capacity", () => {
		const cache = new PlanCache<string>({ max: 2 });

		cache.set("a", "org:1", "A");
		cache.set("b", "org:1", "B");
		// Reading `a` makes `b` the least recent.
		expect(cache.get("a")).toBe("A");
		cache.set("c", "org:1", "C");

		expect(cache.get("b")).toBeUndefined();
		expect(cache.get("a")).toBe("A");
		expect(cache.get("c")).toBe("C");
		expect(cache.stats()).toMatchObject({ evictions: 1 });
	});

	it("drops only the named scope on invalidate", () => {
		const cache = new PlanCache<string>();

		cache.set("a", "org:1", "A");
		cache.set("b", "org:2", "B");
		cache.set("c", "org:1", "C");

		expect(cache.invalidate("org:1")).toBe(2);
		expect(cache.get("a")).toBeUndefined();
		expect(cache.get("c")).toBeUndefined();
		expect(cache.get("b")).toBe("B");
		expect(cache.stats()).toMatchObject({ invalidations: 2 });
	});

	it("drops everything for '*'", () => {
		const cache = new PlanCache<string>();

		cache.set("a", "org:1", "A");
		cache.set("b", "org:2", "B");

		expect(cache.invalidate("*")).toBe(2);
		expect(cache.size).toBe(0);
	});

	it("returns 0 when a scope holds nothing", () => {
		expect(new PlanCache<string>().invalidate("org:9")).toBe(0);
	});

	it("clear() empties without counting invalidations", () => {
		const cache = new PlanCache<string>();
		cache.set("a", "org:1", "A");

		cache.clear();

		expect(cache.size).toBe(0);
		expect(cache.stats()).toMatchObject({ invalidations: 0 });
	});
});
