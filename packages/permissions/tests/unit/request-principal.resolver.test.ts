import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";

import {
	DEFAULT_PRINCIPAL_PROPERTY,
	NOT_IN_SCOPE,
	RequestPrincipalResolver,
	isNotInScope,
	isResolvedPrincipal,
	type PrincipalResolutionContext,
} from "../../src/index.ts";
import { TEST_SCOPE } from "../shared/test-vocabulary.ts";

interface Session {
	readonly userId: string;
	readonly organizationId: string;
}

function context(request: unknown): PrincipalResolutionContext {
	return { request, contextKind: "http", scope: TEST_SCOPE };
}

describe("RequestPrincipalResolver", () => {
	it("defaults to reading request.user", () => {
		expect(DEFAULT_PRINCIPAL_PROPERTY).toBe("user");
		expect(new RequestPrincipalResolver({ map: () => null }).property).toBe("user");
	});

	it("reads the configured property and passes the resolution context to map", () => {
		const map = vi.fn((session: Session) => ({
			ref: { type: "Member", id: session.userId },
			entities: [],
		}));
		const resolver = new RequestPrincipalResolver<Session>({ property: "session", map });
		const ctx = context({ session: { userId: "member-1", organizationId: "acme" } });

		const resolution = resolver.resolve(ctx);

		expect(map).toHaveBeenCalledWith({ userId: "member-1", organizationId: "acme" }, ctx);
		expect(isResolvedPrincipal(resolution)).toBe(true);
		expect(resolution).toMatchObject({ ref: { type: "Member", id: "member-1" } });
	});

	it("returns null when the property is absent — the auth layer never ran", () => {
		const map = vi.fn();
		const resolver = new RequestPrincipalResolver({ property: "session", map });

		expect(resolver.resolve(context({}))).toBeNull();
		expect(resolver.resolve(context({ session: null }))).toBeNull();
		expect(map).not.toHaveBeenCalled();
	});

	it("returns null when the request is not an object", () => {
		const resolver = new RequestPrincipalResolver({ map: () => NOT_IN_SCOPE });

		expect(resolver.resolve(context(undefined))).toBeNull();
		expect(resolver.resolve(context("not-a-request"))).toBeNull();
	});

	it("passes a null map result through as unauthenticated", () => {
		const resolver = new RequestPrincipalResolver({ map: () => null });

		expect(resolver.resolve(context({ user: { id: "member-1" } }))).toBeNull();
	});

	it("passes not-in-scope through — distinct from unauthenticated", () => {
		const resolver = new RequestPrincipalResolver<Session>({
			property: "session",
			map: (session, { scope }) =>
				session.organizationId === scope
					? { ref: { type: "Member", id: session.userId }, entities: [] }
					: NOT_IN_SCOPE,
		});

		const resolution = resolver.resolve(
			context({ session: { userId: "member-1", organizationId: "other" } }),
		);

		expect(isNotInScope(resolution)).toBe(true);
		expect(isResolvedPrincipal(resolution)).toBe(false);
		expect(resolution).not.toBeNull();
	});

	it("carries a scopeHint when the map supplies one", () => {
		const resolver = new RequestPrincipalResolver<Session>({
			property: "session",
			map: (session) => ({
				ref: { type: "Member", id: session.userId },
				entities: [],
				scopeHint: session.organizationId,
			}),
		});

		expect(
			resolver.resolve(context({ session: { userId: "member-1", organizationId: "acme" } })),
		).toMatchObject({ scopeHint: "acme" });
	});

	it("rejects construction without a map function", () => {
		expect(() => new RequestPrincipalResolver({} as never)).toThrowError(/requires a `map`/);
	});
});

describe("resolution guards", () => {
	it("classifies every arm of the union", () => {
		expect(isNotInScope(null)).toBe(false);
		expect(isNotInScope(NOT_IN_SCOPE)).toBe(true);
		expect(isResolvedPrincipal(null)).toBe(false);
		expect(isResolvedPrincipal(NOT_IN_SCOPE)).toBe(false);
		expect(isResolvedPrincipal({ ref: { type: "Member", id: "m" }, entities: [] })).toBe(true);
	});
});
