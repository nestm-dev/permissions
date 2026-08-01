import { describe, expect, it, vi } from "vitest";

import { LruCache, type LruEvictionReason } from "../../src/util/lru.ts";

describe("LruCache", () => {
	it("rejects a non-positive or fractional max", () => {
		expect(() => new LruCache<string, number>({ max: 0 })).toThrow(
			/positive integer max, received 0/,
		);
		expect(() => new LruCache<string, number>({ max: 1.5 })).toThrow(/positive integer max/);
		expect(() => new LruCache<string, number>({ max: -1 })).toThrowError(
			expect.objectContaining({ name: "PermissionsError", code: "ENGINE_INIT" }),
		);
	});

	it("stores and reads values", () => {
		const cache = new LruCache<string, number>({ max: 3 });

		cache.set("a", 1).set("b", 2);

		expect(cache.size).toBe(2);
		expect(cache.max).toBe(3);
		expect(cache.get("a")).toBe(1);
		expect(cache.get("missing")).toBeUndefined();
		expect(cache.has("b")).toBe(true);
	});

	it("evicts the least recently used entry at capacity", () => {
		const evicted: string[] = [];
		const cache = new LruCache<string, number>({
			max: 2,
			onEvict: (key) => {
				evicted.push(key);
			},
		});

		cache.set("a", 1).set("b", 2).set("c", 3).set("d", 4);

		expect(evicted).toEqual(["a", "b"]);
		expect([...cache.keys()]).toEqual(["c", "d"]);
	});

	it("refreshes recency on get", () => {
		const evicted: string[] = [];
		const cache = new LruCache<string, number>({
			max: 2,
			onEvict: (key) => {
				evicted.push(key);
			},
		});

		cache.set("a", 1).set("b", 2);
		expect(cache.get("a")).toBe(1);
		cache.set("c", 3);

		expect(evicted).toEqual(["b"]);
		expect([...cache.keys()]).toEqual(["a", "c"]);
	});

	it("does not refresh recency on peek or has", () => {
		const cache = new LruCache<string, number>({ max: 2 });

		cache.set("a", 1).set("b", 2);
		expect(cache.peek("a")).toBe(1);
		expect(cache.has("a")).toBe(true);
		cache.set("c", 3);

		expect([...cache.keys()]).toEqual(["b", "c"]);
	});

	it("reports the eviction reason", () => {
		const seen: Array<[string, number, LruEvictionReason]> = [];
		const cache = new LruCache<string, number>({
			max: 2,
			onEvict: (key, value, reason) => {
				seen.push([key, value, reason]);
			},
		});

		cache.set("a", 1).set("b", 2).set("c", 3);
		cache.delete("b");
		cache.set("d", 4);
		cache.clear();

		expect(seen).toEqual([
			["a", 1, "capacity"],
			["b", 2, "delete"],
			["c", 3, "clear"],
			["d", 4, "clear"],
		]);
	});

	it("does not evict when set replaces an existing key", () => {
		const onEvict = vi.fn();
		const cache = new LruCache<string, number>({ max: 2, onEvict });

		cache.set("a", 1).set("b", 2).set("a", 10);

		expect(onEvict).not.toHaveBeenCalled();
		expect(cache.peek("a")).toBe(10);
		expect(cache.size).toBe(2);
		// The replacement also refreshed recency.
		expect([...cache.keys()]).toEqual(["b", "a"]);
	});

	it("clears oldest first", () => {
		const evicted: string[] = [];
		const cache = new LruCache<string, number>({
			max: 5,
			onEvict: (key) => {
				evicted.push(key);
			},
		});

		cache.set("a", 1).set("b", 2).set("c", 3);
		cache.clear();

		expect(evicted).toEqual(["a", "b", "c"]);
		expect(cache.size).toBe(0);
	});

	it("reports whether delete removed anything", () => {
		const cache = new LruCache<string, number>({ max: 2 });
		cache.set("a", 1);

		expect(cache.delete("a")).toBe(true);
		expect(cache.delete("a")).toBe(false);
	});

	it("iterates least-recently-used first", () => {
		const cache = new LruCache<string, number>({ max: 3 });
		cache.set("a", 1).set("b", 2).set("c", 3);
		cache.get("a");

		expect([...cache]).toEqual([
			["b", 2],
			["c", 3],
			["a", 1],
		]);
		expect([...cache.values()]).toEqual([2, 3, 1]);
		expect([...cache.entries()].map(([key]) => key)).toEqual(["b", "c", "a"]);
	});
});
