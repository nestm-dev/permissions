import "reflect-metadata";
import { HttpException } from "@nestjs/common";
import { describe, expect, it } from "vitest";

import { NOT_FOUND_DETAIL, createAuthorizationError } from "../../src/index.ts";

function bodyOf(error: Error): unknown {
	return error instanceof HttpException ? error.getResponse() : undefined;
}

describe("createAuthorizationError", () => {
	it.each([
		["UNAUTHORIZED", 401],
		["FORBIDDEN", 403],
		["NOT_FOUND", 404],
		["BAD_REQUEST", 400],
		["SERVICE_UNAVAILABLE", 503],
		["INTERNAL", 500],
	] as const)("maps %s to HTTP %i", async (status, expected) => {
		const error = await createAuthorizationError("http", status);

		expect(error).toBeInstanceOf(HttpException);
		expect((error as HttpException).getStatus()).toBe(expected);
	});

	it("builds an identical not-found body whatever the caller passes as a message", async () => {
		// The security property of ADR-0014, asserted where it is implemented: two
		// different denials must be indistinguishable, so the message argument is
		// ignored for NOT_FOUND rather than merely "usually omitted".
		const unknownTenant = await createAuthorizationError("http", "NOT_FOUND");
		const nonMemberProbe = await createAuthorizationError(
			"http",
			"NOT_FOUND",
			"Member m-2 is not in org:acme",
		);

		expect(JSON.stringify(bodyOf(unknownTenant))).toBe(JSON.stringify(bodyOf(nonMemberProbe)));
		expect(bodyOf(unknownTenant)).toMatchObject({ message: NOT_FOUND_DETAIL, statusCode: 404 });
	});

	it("keeps the same body shape under a custom notFoundStatus", async () => {
		const error = await createAuthorizationError("http", "NOT_FOUND", undefined, {
			notFoundStatus: 410,
		});

		expect((error as HttpException).getStatus()).toBe(410);
		expect(bodyOf(error)).toEqual({
			statusCode: 410,
			message: NOT_FOUND_DETAIL,
			error: NOT_FOUND_DETAIL,
		});
	});

	it("carries the message on every other status", async () => {
		const error = await createAuthorizationError("http", "FORBIDDEN", "nope");

		expect(bodyOf(error)).toMatchObject({ message: "nope" });
	});

	it("gives an rpc context a plain Error", async () => {
		const error = await createAuthorizationError("rpc", "FORBIDDEN", "nope");

		expect(error).toBeInstanceOf(Error);
		expect(error).not.toBeInstanceOf(HttpException);
		expect(error.message).toBe("nope");
	});

	it("tells a websocket caller which optional peer is missing", async () => {
		// @nestjs/websockets is not installed here, which is exactly the case the
		// message exists for.
		await expect(createAuthorizationError("ws", "FORBIDDEN")).rejects.toThrowError(
			/@nestjs\/websockets is required/,
		);
	});
});
