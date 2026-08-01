import { describe, expect, it } from "vitest";

import type { EntityRef } from "../../src/cedar/uid.ts";
import {
	DEFAULT_ENTITY_CACHE_MAX_ENTRIES,
	DEFAULT_ENTITY_CACHE_TTL_MS,
	EntityCache,
} from "../../src/entities/entity-cache.ts";
import type { EntityGraph } from "../../src/entities/entity-provider.ts";

const TENANT = "org:1";
const OTHER = "org:2";

const ref = (type: string, id: string): EntityRef => ({ type, id });

function graph(id: string): EntityGraph {
	return [{ uid: { type: "Station::Member", id }, attrs: {}, parents: [] }];
}

/** A cache with a clock the test drives by hand. */
function fixture(options: { ttlMs?: number; maxEntries?: number } = {}): {
	cache: EntityCache;
	advance: (ms: number) => void;
} {
	let now = 1_000;
	const cache = new EntityCache({ ...options, clock: () => now });
	const advance = (ms: number): void => {
		now += ms;
	};

	return { cache, advance };
}

describe("defaults", () => {
	it("uses the documented TTL and capacity", () => {
		const cache = new EntityCache();

		expect(cache.ttlMs).toBe(DEFAULT_ENTITY_CACHE_TTL_MS);
		expect(cache.stats()).toMatchObject({
			maxEntries: DEFAULT_ENTITY_CACHE_MAX_ENTRIES,
			ttlMs: 30_000,
			entries: 0,
		});
	});

	it("keys on scope, type and id", () => {
		expect(new EntityCache().keyFor(TENANT, ref("Member", "m1"))).toBe("org:1:Member:m1");
	});
});

describe("get / set", () => {
	it("returns what was stored", () => {
		const { cache } = fixture();
		cache.set(TENANT, ref("Member", "m1"), graph("m1"));

		expect(cache.get(TENANT, ref("Member", "m1"))).toEqual(graph("m1"));
		expect(cache.stats()).toMatchObject({ hits: 1, misses: 0, entries: 1 });
	});

	it("misses on an unknown key", () => {
		const { cache } = fixture();

		expect(cache.get(TENANT, ref("Member", "nope"))).toBeUndefined();
		expect(cache.stats()).toMatchObject({ hits: 0, misses: 1 });
	});

	it("keeps scopes apart", () => {
		const { cache } = fixture();
		cache.set(TENANT, ref("Member", "m1"), graph("tenant"));
		cache.set(OTHER, ref("Member", "m1"), graph("other"));

		expect(cache.get(TENANT, ref("Member", "m1"))).toEqual(graph("tenant"));
		expect(cache.get(OTHER, ref("Member", "m1"))).toEqual(graph("other"));
	});

	it("restarts the TTL on overwrite", () => {
		const { cache, advance } = fixture({ ttlMs: 100 });
		cache.set(TENANT, ref("Member", "m1"), graph("first"));

		advance(90);
		cache.set(TENANT, ref("Member", "m1"), graph("second"));
		advance(50);

		expect(cache.get(TENANT, ref("Member", "m1"))).toEqual(graph("second"));
	});
});

describe("TTL", () => {
	it("serves an entry right up to its expiry", () => {
		const { cache, advance } = fixture({ ttlMs: 100 });
		cache.set(TENANT, ref("Member", "m1"), graph("m1"));

		advance(99);

		expect(cache.get(TENANT, ref("Member", "m1"))).toEqual(graph("m1"));
	});

	it("drops an entry the moment its TTL is reached", () => {
		const { cache, advance } = fixture({ ttlMs: 100 });
		cache.set(TENANT, ref("Member", "m1"), graph("m1"));

		advance(100);

		expect(cache.get(TENANT, ref("Member", "m1"))).toBeUndefined();
		// Dropped, not merely hidden: a stale ancestor set is a wrong decision.
		expect(cache.size).toBe(0);
		expect(cache.stats()).toMatchObject({ hits: 0, misses: 1, expirations: 1 });
	});
});

describe("capacity", () => {
	it("evicts the least recently used entry", () => {
		const { cache } = fixture({ maxEntries: 2 });
		cache.set(TENANT, ref("Member", "m1"), graph("m1"));
		cache.set(TENANT, ref("Member", "m2"), graph("m2"));

		// Reading m1 makes m2 the least recently used.
		expect(cache.get(TENANT, ref("Member", "m1"))).toBeDefined();
		cache.set(TENANT, ref("Member", "m3"), graph("m3"));

		expect(cache.get(TENANT, ref("Member", "m2"))).toBeUndefined();
		expect(cache.get(TENANT, ref("Member", "m1"))).toBeDefined();
		expect(cache.get(TENANT, ref("Member", "m3"))).toBeDefined();
		expect(cache.stats()).toMatchObject({ evictions: 1, entries: 2 });
	});

	it("never exceeds maxEntries", () => {
		const { cache } = fixture({ maxEntries: 3 });

		for (let index = 0; index < 20; index += 1) {
			cache.set(TENANT, ref("Member", `m${String(index)}`), graph(String(index)));
		}

		expect(cache.size).toBe(3);
		expect(cache.stats().evictions).toBe(17);
	});
});

describe("invalidate", () => {
	it("drops one scope and leaves the others", () => {
		const { cache } = fixture();
		cache.set(TENANT, ref("Member", "m1"), graph("m1"));
		cache.set(TENANT, ref("Member", "m2"), graph("m2"));
		cache.set(OTHER, ref("Member", "m1"), graph("other"));

		expect(cache.invalidate(TENANT)).toBe(2);
		expect(cache.get(TENANT, ref("Member", "m1"))).toBeUndefined();
		expect(cache.get(OTHER, ref("Member", "m1"))).toEqual(graph("other"));
		expect(cache.stats()).toMatchObject({ invalidations: 2 });
	});

	it("drops every scope for '*'", () => {
		const { cache } = fixture();
		cache.set(TENANT, ref("Member", "m1"), graph("m1"));
		cache.set(OTHER, ref("Member", "m1"), graph("other"));
		cache.set("", ref("Member", "m1"), graph("global"));

		expect(cache.invalidate("*")).toBe(3);
		expect(cache.size).toBe(0);
	});

	it("is a no-op for an unknown scope", () => {
		const { cache } = fixture();
		cache.set(TENANT, ref("Member", "m1"), graph("m1"));

		expect(cache.invalidate("never-seen")).toBe(0);
		expect(cache.size).toBe(1);
	});

	it("does not confuse a scope with a scope that is its prefix", () => {
		const { cache } = fixture();
		cache.set("org:1", ref("Member", "m1"), graph("a"));
		cache.set("org:1:sub", ref("Member", "m1"), graph("b"));

		expect(cache.invalidate("org:1")).toBe(1);
		expect(cache.get("org:1:sub", ref("Member", "m1"))).toEqual(graph("b"));
	});
});

describe("invalidateEntity", () => {
	it("drops one entity across every scope by default", () => {
		const { cache } = fixture();
		cache.set(TENANT, ref("Member", "m1"), graph("a"));
		cache.set(OTHER, ref("Member", "m1"), graph("b"));
		cache.set(TENANT, ref("Member", "m2"), graph("c"));

		expect(cache.invalidateEntity(ref("Member", "m1"))).toBe(2);
		expect(cache.get(TENANT, ref("Member", "m2"))).toEqual(graph("c"));
		expect(cache.size).toBe(1);
	});

	it("can be narrowed to one scope", () => {
		const { cache } = fixture();
		cache.set(TENANT, ref("Member", "m1"), graph("a"));
		cache.set(OTHER, ref("Member", "m1"), graph("b"));

		expect(cache.invalidateEntity(ref("Member", "m1"), TENANT)).toBe(1);
		expect(cache.get(OTHER, ref("Member", "m1"))).toEqual(graph("b"));
	});

	it("distinguishes entities of the same id but different types", () => {
		const { cache } = fixture();
		cache.set(TENANT, ref("Member", "x"), graph("member"));
		cache.set(TENANT, ref("Project", "x"), graph("project"));

		expect(cache.invalidateEntity(ref("Member", "x"))).toBe(1);
		expect(cache.get(TENANT, ref("Project", "x"))).toEqual(graph("project"));
	});
});

describe("clear", () => {
	it("empties everything and counts it", () => {
		const { cache } = fixture();
		cache.set(TENANT, ref("Member", "m1"), graph("a"));
		cache.set(OTHER, ref("Member", "m2"), graph("b"));

		cache.clear();

		expect(cache.size).toBe(0);
		expect(cache.stats()).toMatchObject({ invalidations: 2, evictions: 0 });
	});
});
