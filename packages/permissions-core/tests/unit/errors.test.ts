import { describe, expect, it } from "vitest";

import type { DetailedError } from "../../src/cedar/binding.ts";
import {
	CedarVersionError,
	PermissionsError,
	SchemaValidationError,
	isPermissionsError,
} from "../../src/diagnostics/errors.ts";
import { formatDetailedErrors, throwCedarFailure } from "../../src/cedar/answers.ts";

const detail: DetailedError = {
	message: "failed to resolve type: Nope",
	help: "neither `S::Nope` nor `Nope` refers to anything declared",
	code: null,
	url: null,
	severity: "error",
	sourceLocations: [{ start: 0, end: 4, label: null }],
};

describe("PermissionsError", () => {
	it("carries a code and a name", () => {
		const error = new PermissionsError("POLICY_STORE", "store unavailable");

		expect(error).toBeInstanceOf(Error);
		expect(error.name).toBe("PermissionsError");
		expect(error.code).toBe("POLICY_STORE");
		expect(error.message).toBe("store unavailable");
	});

	it("omits optional fields it was not given", () => {
		const error = new PermissionsError("ENGINE_INIT", "boom");

		expect(error.details).toBeUndefined();
		expect(error.scope).toBeUndefined();
		expect("details" in error).toBe(false);
		expect("scope" in error).toBe(false);
	});

	it("passes Cedar details and the scope through", () => {
		const error = new PermissionsError("POLICY_INVALID", "bad policy", {
			details: [detail],
			scope: "org:8f3e",
		});

		expect(error.details).toEqual([detail]);
		expect(error.details?.[0]?.sourceLocations).toEqual([{ start: 0, end: 4, label: null }]);
		expect(error.scope).toBe("org:8f3e");
	});

	it("supports a cause", () => {
		const cause = new Error("underlying");
		expect(new PermissionsError("POLICY_STORE", "wrapped", { cause }).cause).toBe(cause);
	});

	it("has a stack that does not name the constructor", () => {
		const error = new PermissionsError("ENGINE_INIT", "boom");

		expect(error.stack).toBeDefined();
		expect(error.stack?.split("\n")[1]).not.toContain("new PermissionsError");
	});

	it("is detectable via isPermissionsError", () => {
		expect(isPermissionsError(new PermissionsError("ENGINE_INIT", "boom"))).toBe(true);
		// A separately bundled copy has a different constructor identity. The public
		// guard is intentionally structural so its stable string discriminant still
		// crosses that package boundary.
		expect(
			isPermissionsError({
				name: "PermissionsError",
				code: "POLICY_STORE",
				message: "store unavailable",
			}),
		).toBe(true);
		expect(isPermissionsError(new Error("boom"))).toBe(false);
		expect(isPermissionsError({ code: "NOT_A_PERMISSIONS_CODE", message: "boom" })).toBe(false);
		expect(isPermissionsError({ code: "POLICY_STORE" })).toBe(false);
		expect(isPermissionsError(undefined)).toBe(false);
	});
});

describe("CedarVersionError", () => {
	const error = new CedarVersionError("unsupported", { actual: "5.1", expectedMajor: "4" });

	it("is a PermissionsError with the CEDAR_VERSION code", () => {
		expect(error).toBeInstanceOf(PermissionsError);
		expect(error.code).toBe("CEDAR_VERSION");
		expect(error.name).toBe("CedarVersionError");
	});

	it("carries the observed and expected versions", () => {
		expect(error.actual).toBe("5.1");
		expect(error.expectedMajor).toBe("4");
	});
});

describe("SchemaValidationError", () => {
	it("defaults to the SCHEMA_INVALID code", () => {
		const error = new SchemaValidationError("bad");

		expect(error).toBeInstanceOf(PermissionsError);
		expect(error.code).toBe("SCHEMA_INVALID");
		expect(error.name).toBe("SchemaValidationError");
	});

	it("carries the definition path and namespace for structural failures", () => {
		const error = new SchemaValidationError("bad", {
			namespace: "Station",
			path: "entities.Run.memberOf[0]",
		});

		expect(error.namespace).toBe("Station");
		expect(error.path).toBe("entities.Run.memberOf[0]");
	});

	it("carries Cedar details for Cedar-side failures", () => {
		expect(new SchemaValidationError("bad", { details: [detail] }).details).toEqual([detail]);
	});
});

describe("answer narrowing", () => {
	it("joins Cedar messages", () => {
		expect(formatDetailedErrors([detail, { ...detail, message: "second" }])).toBe(
			"failed to resolve type: Nope; second",
		);
	});

	it("throws a PermissionsError preserving the raw diagnostics", () => {
		expect(() =>
			throwCedarFailure(
				{ type: "failure", errors: [detail] },
				{
					code: "SCHEMA_INVALID",
					message: "Cedar rejected the schema",
					scope: "org:1",
				},
			),
		).toThrowError(
			expect.objectContaining({
				code: "SCHEMA_INVALID",
				scope: "org:1",
				message: "Cedar rejected the schema: failed to resolve type: Nope",
			}),
		);
	});
});
