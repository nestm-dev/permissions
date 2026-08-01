import { describe, expect, it, vi } from "vitest";

import { SingleFlight } from "../../src/util/single-flight.ts";

function deferred<T>(): {
	promise: Promise<T>;
	resolve: (value: T) => void;
	reject: (error: unknown) => void;
} {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((resolveFn, rejectFn) => {
		resolve = resolveFn;
		reject = rejectFn;
	});
	return { promise, resolve, reject };
}

describe("SingleFlight", () => {
	it("shares one promise across concurrent callers of a key", async () => {
		const flight = new SingleFlight<string, number>();
		const gate = deferred<number>();
		const factory = vi.fn(async () => gate.promise);

		const callers = [flight.run("a", factory), flight.run("a", factory), flight.run("a", factory)];

		expect(factory).toHaveBeenCalledTimes(1);
		expect(flight.size).toBe(1);
		expect(callers[0]).toBe(callers[1]);
		expect(callers[1]).toBe(callers[2]);

		gate.resolve(7);
		await expect(Promise.all(callers)).resolves.toEqual([7, 7, 7]);
	});

	it("keeps distinct keys independent", async () => {
		const flight = new SingleFlight<string, string>();
		const factory = vi.fn(async (key: string) => key.toUpperCase());

		const [a, b] = await Promise.all([
			flight.run("a", async () => factory("a")),
			flight.run("b", async () => factory("b")),
		]);

		expect([a, b]).toEqual(["A", "B"]);
		expect(factory).toHaveBeenCalledTimes(2);
		expect(flight.size).toBe(0);
	});

	it("drops the key once the run settles", async () => {
		const flight = new SingleFlight<string, number>();
		const factory = vi.fn(async () => 1);

		await flight.run("a", factory);
		expect(flight.has("a")).toBe(false);

		await flight.run("a", factory);
		expect(factory).toHaveBeenCalledTimes(2);
	});

	it("evicts the key on failure so the next caller retries", async () => {
		const flight = new SingleFlight<string, string>();
		let attempt = 0;
		const factory = vi.fn(async () => {
			attempt += 1;
			if (attempt === 1) {
				throw new Error("cold start failed");
			}
			return "ok";
		});

		await expect(flight.run("a", factory)).rejects.toThrow("cold start failed");
		expect(flight.has("a")).toBe(false);
		expect(flight.size).toBe(0);

		await expect(flight.run("a", factory)).resolves.toBe("ok");
		expect(factory).toHaveBeenCalledTimes(2);
	});

	it("rejects every concurrent caller with the same error", async () => {
		const flight = new SingleFlight<string, number>();
		const gate = deferred<number>();
		const factory = vi.fn(async () => gate.promise);

		const first = flight.run("a", factory);
		const second = flight.run("a", factory);
		const failure = new Error("store unavailable");
		gate.reject(failure);

		await expect(first).rejects.toBe(failure);
		await expect(second).rejects.toBe(failure);
		expect(factory).toHaveBeenCalledTimes(1);
		expect(flight.has("a")).toBe(false);
	});

	it("turns a synchronous throw into a rejection without stranding the key", async () => {
		const flight = new SingleFlight<string, number>();

		const rejected = flight.run("a", () => {
			throw new Error("bad factory");
		});

		await expect(rejected).rejects.toThrow("bad factory");
		expect(flight.has("a")).toBe(false);
		await expect(flight.run("a", async () => 42)).resolves.toBe(42);
	});

	it("exposes the in-flight keys", async () => {
		const flight = new SingleFlight<string, number>();
		const gate = deferred<number>();

		const running = flight.run("a", async () => gate.promise);
		expect([...flight.keys()]).toEqual(["a"]);

		gate.resolve(1);
		await running;
		expect([...flight.keys()]).toEqual([]);
	});
});
