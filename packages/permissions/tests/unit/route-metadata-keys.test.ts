import "reflect-metadata";
import { afterEach, describe, expect, it } from "vitest";

import { FALLBACK_ROUTE_METADATA_KEYS, loadRouteMetadataKeys } from "../../src/index.ts";
import { __resetRouteMetadataKeys } from "../../src/audit/route-authorization.audit.ts";

afterEach(() => {
	__resetRouteMetadataKeys();
});

describe("loadRouteMetadataKeys", () => {
	it("reads the real keys from @nestjs/common/constants", async () => {
		const keys = await loadRouteMetadataKeys();

		expect(keys).toEqual({ path: "path", method: "method", source: "nest" });
	});

	it("falls back to the literal keys when the deep import is gone", async () => {
		const keys = await loadRouteMetadataKeys(() => {
			throw new Error("Cannot find module '@nestjs/common/constants'");
		});

		expect(keys).toEqual({ ...FALLBACK_ROUTE_METADATA_KEYS, source: "fallback" });
		// The fallback is the value Nest actually writes, not a placeholder: an
		// audit running on it identifies exactly the same routes.
		expect(keys.path).toBe("path");
		expect(keys.method).toBe("method");
	});

	it("falls back when the module exists but no longer exports the keys", async () => {
		const keys = await loadRouteMetadataKeys(async () => ({ SOMETHING_ELSE: 1 }));

		expect(keys.source).toBe("fallback");
	});

	it("memoises the answer", async () => {
		let calls = 0;
		const load = async (): Promise<Record<string, unknown>> => {
			calls += 1;
			return { PATH_METADATA: "custom-path", METHOD_METADATA: "custom-method" };
		};

		const first = await loadRouteMetadataKeys(load);
		const second = await loadRouteMetadataKeys(load);

		expect(calls).toBe(1);
		expect(first).toBe(second);
		expect(first.path).toBe("custom-path");
	});
});
