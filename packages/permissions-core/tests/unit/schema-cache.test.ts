import { describe, expect, it, vi } from "vitest";

import type { CedarBinding, CheckParseAnswer, Schema } from "../../src/cedar/binding.ts";
import {
	DEFAULT_SCHEMA_NAME_PREFIX,
	SchemaCache,
	schemaHash,
} from "../../src/runtime/schema-cache.ts";

const SCHEMA: Schema = { Station: { entityTypes: { Run: {} }, actions: {} } };

function stubBinding(answers: CheckParseAnswer[] = []) {
	const preparseSchema = vi.fn(
		(): CheckParseAnswer => answers.shift() ?? { type: "success" },
	) as unknown as CedarBinding["preparseSchema"];

	return {
		binding: { preparseSchema } as unknown as CedarBinding,
		calls: () => (preparseSchema as unknown as ReturnType<typeof vi.fn>).mock.calls,
	};
}

describe("schemaHash", () => {
	it("is independent of key order", () => {
		expect(schemaHash({ A: { entityTypes: {}, actions: {} } })).toBe(
			schemaHash({ A: { actions: {}, entityTypes: {} } }),
		);
	});

	it("changes with the schema", () => {
		expect(schemaHash({ A: { entityTypes: {}, actions: {} } })).not.toBe(
			schemaHash({ B: { entityTypes: {}, actions: {} } }),
		);
	});
});

describe("SchemaCache", () => {
	it("preparses once per hash and returns a stable name", () => {
		const { binding, calls } = stubBinding();
		const cache = new SchemaCache();
		const hash = schemaHash(SCHEMA as Record<string, never>);

		const first = cache.ensure(binding, hash, SCHEMA);
		const second = cache.ensure(binding, hash, SCHEMA);

		expect(first).toBe(second);
		expect(first).toBe(`${DEFAULT_SCHEMA_NAME_PREFIX}${hash}`);
		expect(calls()).toHaveLength(1);
		expect(cache.preparses).toBe(1);
		expect(cache.size).toBe(1);
		expect(cache.has(hash)).toBe(true);
		expect(cache.names()).toEqual([first]);
	});

	it("honours a custom prefix", () => {
		const { binding } = stubBinding();
		const cache = new SchemaCache({ prefix: "engine-7-" });

		expect(cache.ensure(binding, "abc", SCHEMA)).toBe("engine-7-abc");
		expect(cache.nameFor("abc")).toBe("engine-7-abc");
	});

	it("keeps distinct hashes distinct", () => {
		const { binding, calls } = stubBinding();
		const cache = new SchemaCache();

		expect(cache.ensure(binding, "a", SCHEMA)).not.toBe(cache.ensure(binding, "b", SCHEMA));
		expect(calls()).toHaveLength(2);
	});

	it("throws SCHEMA_INVALID with Cedar's diagnostics and does not memoise the failure", () => {
		const { binding, calls } = stubBinding([
			{ type: "failure", errors: [{ message: "undeclared entity type Nope" } as never] },
		]);
		const cache = new SchemaCache();

		expect(() => cache.ensure(binding, "a", SCHEMA)).toThrowError(
			expect.objectContaining({
				code: "SCHEMA_INVALID",
				message: expect.stringContaining("undeclared entity type Nope"),
			}),
		);
		expect(cache.has("a")).toBe(false);

		expect(cache.ensure(binding, "a", SCHEMA)).toBe(cache.nameFor("a"));
		expect(calls()).toHaveLength(2);
	});

	it("clear drops the memo so the next ensure re-registers", () => {
		const { binding, calls } = stubBinding();
		const cache = new SchemaCache();

		cache.ensure(binding, "a", SCHEMA);
		cache.clear();
		expect(cache.size).toBe(0);

		cache.ensure(binding, "a", SCHEMA);
		expect(calls()).toHaveLength(2);
	});
});
