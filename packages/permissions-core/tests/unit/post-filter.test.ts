import { describe, expect, it, vi } from "vitest";

import { PostFilterOverflowError } from "../../src/diagnostics/errors.ts";
import {
	DEFAULT_MAX_POST_FILTER_ROWS,
	createPostFilter,
	type PostFilterCheck,
} from "../../src/plan/post-filter.ts";

interface Row {
	readonly id: string;
	readonly name: string;
}

function rows(...ids: string[]): Row[] {
	return ids.map((id) => ({ id, name: `run-${id}` }));
}

function build(check: PostFilterCheck, maxRows = 10) {
	return createPostFilter({
		check,
		maxRows,
		resourceType: "Run",
		action: "run:read",
		scope: "org:1",
	});
}

const rowToResource = (row: Row) => ({ type: "Run", id: row.id });

describe("createPostFilter", () => {
	it("keeps allowed rows, in order, and drops the rest", async () => {
		const postFilter = build(async (resources) => resources.map((r) => r.id !== "b"));

		await expect(postFilter(rows("a", "b", "c"), { rowToResource })).resolves.toEqual(
			rows("a", "c"),
		);
	});

	it("maps each row through rowToResource with its index", async () => {
		const check = vi.fn<PostFilterCheck>(async (resources) => resources.map(() => true));
		const seen: number[] = [];
		const postFilter = build(check);

		await postFilter(rows("a", "b"), {
			rowToResource: (row, index) => {
				seen.push(index);
				return { type: "Run", id: row.id };
			},
		});

		expect(seen).toEqual([0, 1]);
		expect(check).toHaveBeenCalledWith([
			{ type: "Run", id: "a" },
			{ type: "Run", id: "b" },
		]);
	});

	it("short-circuits an empty batch without calling check", async () => {
		const check = vi.fn<PostFilterCheck>(async () => []);

		await expect(build(check)([], { rowToResource })).resolves.toEqual([]);
		expect(check).not.toHaveBeenCalled();
	});

	it("throws POST_FILTER_OVERFLOW past the cap", async () => {
		const postFilter = build(async (resources) => resources.map(() => true), 2);

		let thrown: unknown;
		try {
			await postFilter(rows("a", "b", "c"), { rowToResource });
		} catch (error) {
			thrown = error;
		}

		expect(thrown).toBeInstanceOf(PostFilterOverflowError);
		expect(thrown).toMatchObject({ code: "POST_FILTER_OVERFLOW", rows: 3, maxRows: 2 });
		expect((thrown as Error).message).toContain("Paginate before filtering");
	});

	it("allows exactly the cap", async () => {
		const postFilter = build(async (resources) => resources.map(() => true), 2);

		await expect(postFilter(rows("a", "b"), { rowToResource })).resolves.toHaveLength(2);
	});

	it("lets a call override the cap", async () => {
		const postFilter = build(async (resources) => resources.map(() => true), 1);

		await expect(postFilter(rows("a", "b"), { rowToResource, maxRows: 2 })).resolves.toHaveLength(
			2,
		);
	});

	it("documents 500 as the default cap", () => {
		expect(DEFAULT_MAX_POST_FILTER_ROWS).toBe(500);
	});

	it("refuses a row mapped to the wrong resource type", async () => {
		// A mismatched type would ask Cedar about a different entity entirely, and
		// the answer would look perfectly plausible.
		const postFilter = build(async (resources) => resources.map(() => true));

		await expect(
			postFilter(rows("a"), { rowToResource: (row) => ({ type: "Project", id: row.id }) }),
		).rejects.toMatchObject({
			code: "ENTITY_RESOLUTION",
			message: expect.stringContaining('returned a "Project"'),
		});
	});

	it("refuses a rowToResource that does not return an EntityRef", async () => {
		const postFilter = build(async (resources) => resources.map(() => true));

		await expect(
			postFilter(rows("a"), {
				rowToResource: (() => undefined) as unknown as (row: Row) => { type: string; id: string },
			}),
		).rejects.toMatchObject({ code: "ENTITY_RESOLUTION" });
	});

	it("refuses a check that answers with the wrong arity", async () => {
		const postFilter = build(async () => [true]);

		await expect(postFilter(rows("a", "b"), { rowToResource })).rejects.toMatchObject({
			code: "EVALUATION_FAILED",
		});
	});

	it("never mutates or reorders the input", async () => {
		const input = Object.freeze(rows("a", "b", "c"));
		const postFilter = build(async (resources) => resources.map((r) => r.id !== "a"));

		const result = await postFilter(input, { rowToResource });

		expect(input).toEqual(rows("a", "b", "c"));
		expect(result).toEqual([input[1], input[2]]);
	});
});
