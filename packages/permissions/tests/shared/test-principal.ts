import { NOT_IN_SCOPE } from "../../src/index.ts";
import type {
	PrincipalResolution,
	PrincipalResolutionContext,
	PrincipalResolver,
} from "../../src/index.ts";
import { IDS, memberGraph } from "./test-vocabulary.ts";

/** Header carrying the caller's member id. Absent means unauthenticated. */
export const USER_HEADER = "x-test-user";
/** Header overriding the member's role, which the dispatch policy reads. */
export const ROLE_HEADER = "x-test-role";

/**
 * The member id that is authenticated but belongs to no scope the app knows —
 * the `NOT_IN_SCOPE` arm, and therefore the not-found path.
 */
export const OUTSIDER = "ghost";

/**
 * A principal resolver driven by request headers.
 *
 * Reads headers rather than `request.user` on purpose: a middleware that writes
 * `request.user` needs `@fastify/middie` under the Fastify adapter, and this
 * suite runs under both. `RequestPrincipalResolver` (the shipped one, which does
 * read a request property) has its own unit suite.
 */
export class HeaderPrincipalResolver implements PrincipalResolver {
	resolve(context: PrincipalResolutionContext): PrincipalResolution {
		const request = context.request;
		if (typeof request !== "object" || request === null) {
			return null;
		}
		const headers = (request as { headers?: Record<string, string | undefined> }).headers ?? {};

		const id = headers[USER_HEADER];
		if (id === undefined || id === "") {
			return null;
		}
		if (id === OUTSIDER) {
			return NOT_IN_SCOPE;
		}

		const role = headers[ROLE_HEADER] ?? (id === IDS.member ? "admin" : "member");
		return { ref: { type: "Member", id }, entities: memberGraph(id, role) };
	}
}
