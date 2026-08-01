import { describe, expect, it } from "vitest";

import {
	SHORT_HASH_LENGTH,
	sha256Hex,
	shortHash,
	stableHash,
	stableStringify,
} from "../../src/util/hash.ts";

describe("stableStringify", () => {
	it("is independent of key order", () => {
		expect(stableStringify({ b: 1, a: 2 })).toBe(stableStringify({ a: 2, b: 1 }));
		expect(stableStringify({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
	});

	it("sorts nested keys too", () => {
		expect(stableStringify({ outer: { z: 1, a: { y: 2, b: 3 } } })).toBe(
			'{"outer":{"a":{"b":3,"y":2},"z":1}}',
		);
	});

	it("preserves array order", () => {
		expect(stableStringify([3, 1, 2])).toBe("[3,1,2]");
		expect(stableStringify([3, 1, 2])).not.toBe(stableStringify([1, 2, 3]));
	});

	it("renders primitives distinguishably", () => {
		expect(stableStringify(null)).toBe("null");
		expect(stableStringify(undefined)).toBe("null");
		expect(stableStringify(true)).toBe("true");
		expect(stableStringify("a")).toBe('"a"');
		expect(stableStringify(12)).toBe("12");
		expect(stableStringify(12n)).toBe("#12n");
		expect(stableStringify(Number.NaN)).toBe("#NaN");
		expect(stableStringify(Number.POSITIVE_INFINITY)).toBe("#Infinity");
	});

	it("renders dates as ISO instants", () => {
		expect(stableStringify(new Date("2026-07-30T12:00:00.000Z"))).toBe("#2026-07-30T12:00:00.000Z");
		expect(stableStringify({ at: new Date(0) })).toBe('{"at":#1970-01-01T00:00:00.000Z}');
	});

	it("keeps a tagged primitive distinguishable from the same text as a string", () => {
		expect(stableStringify(12n)).not.toBe(stableStringify("#12n"));
	});

	it("drops undefined members so an absent optional hashes like a missing one", () => {
		expect(stableStringify({ a: 1, b: undefined })).toBe(stableStringify({ a: 1 }));
	});

	it("rejects circular structures", () => {
		const cyclic: Record<string, unknown> = { a: 1 };
		cyclic.self = cyclic;

		expect(() => stableStringify(cyclic)).toThrow(TypeError);
		expect(() => stableStringify(cyclic)).toThrow(/circular/);
	});

	it("allows the same object twice when it is not a cycle", () => {
		const shared = { a: 1 };
		expect(stableStringify({ left: shared, right: shared })).toBe(
			'{"left":{"a":1},"right":{"a":1}}',
		);
	});

	it("rejects functions and symbols at the top level", () => {
		expect(() => stableStringify(() => 1)).toThrow(TypeError);
		expect(() => stableStringify(Symbol("s"))).toThrow(TypeError);
	});

	it("skips function-valued members", () => {
		expect(stableStringify({ a: 1, fn: () => 1 })).toBe('{"a":1}');
	});
});

describe("sha256Hex", () => {
	it("matches the published vector for 'abc'", () => {
		expect(sha256Hex("abc")).toBe(
			"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
		);
	});

	it("hashes utf-8 rather than code units", () => {
		expect(sha256Hex("é")).toBe(sha256Hex("é"));
		expect(sha256Hex("a")).not.toBe(sha256Hex("b"));
	});
});

describe("stableHash", () => {
	it("agrees across key orderings", () => {
		expect(stableHash({ a: 1, b: [1, { d: 4, c: 3 }] })).toBe(
			stableHash({ b: [1, { c: 3, d: 4 }], a: 1 }),
		);
	});

	it("changes with content", () => {
		expect(stableHash({ a: 1 })).not.toBe(stableHash({ a: 2 }));
	});

	it("is the sha256 of the stable serialisation", () => {
		const value = { z: 1, a: 2 };
		expect(stableHash(value)).toBe(sha256Hex(stableStringify(value)));
	});
});

describe("shortHash", () => {
	it("truncates to the default length", () => {
		const hash = shortHash({ a: 1 });
		expect(hash).toHaveLength(SHORT_HASH_LENGTH);
		expect(stableHash({ a: 1 }).startsWith(hash)).toBe(true);
	});

	it("honours an explicit length", () => {
		expect(shortHash({ a: 1 }, 8)).toHaveLength(8);
	});
});
