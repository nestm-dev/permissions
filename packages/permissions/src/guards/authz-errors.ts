import {
	BadRequestException,
	ForbiddenException,
	HttpException,
	HttpStatus,
	InternalServerErrorException,
	NotFoundException,
	ServiceUnavailableException,
	UnauthorizedException,
} from "@nestjs/common";

import { loadOptionalModule } from "../utils/execution-context.util.ts";
import type { PrincipalContextKind } from "../interfaces/principal-resolver.interface.ts";

/**
 * Context-aware exception construction, adapted from `@nestm/better-auth`'s
 * `guards/auth-errors.ts`: HTTP and GraphQL get Nest HTTP exceptions, WS gets
 * `WsException`, RPC gets a plain `Error`.
 */

type WsExceptionCtor = new (error: string | object) => Error;

let wsExceptionCtor: WsExceptionCtor | undefined;

/** Test seam: drops the memoised `@nestjs/websockets` handle. */
export function __resetWsException(): void {
	wsExceptionCtor = undefined;
}

async function getWsException(): Promise<WsExceptionCtor> {
	if (!wsExceptionCtor) {
		try {
			const module = await loadOptionalModule("@nestjs/websockets");
			// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- shape asserted by the alias above
			wsExceptionCtor = module.WsException as WsExceptionCtor;
		} catch {
			throw new Error(
				"@nestjs/websockets is required for WebSocket execution contexts. " +
					"Install it: npm install @nestjs/websockets @nestjs/platform-socket.io",
			);
		}
	}
	return wsExceptionCtor;
}

/**
 * **The** not-found body.
 *
 * A single frozen constant, never interpolated with anything from the request,
 * because the security property of ADR-0014 is that "this tenant does not exist"
 * and "you are not a member of this tenant" are byte-identical. Echoing the id
 * that was probed — even in the message — reintroduces the oracle the 404 was
 * there to close.
 */
export const NOT_FOUND_DETAIL = "Not Found";

/** Statuses this package maps a denial onto. */
export type AuthorizationErrorStatus =
	"UNAUTHORIZED" | "FORBIDDEN" | "NOT_FOUND" | "BAD_REQUEST" | "SERVICE_UNAVAILABLE" | "INTERNAL";

/** Extra knobs for {@link createAuthorizationError}. */
export interface AuthorizationErrorOptions {
	/** Status the not-found response uses. Default `404`. */
	readonly notFoundStatus?: number;
}

function httpError(
	status: AuthorizationErrorStatus,
	message: string | undefined,
	options: AuthorizationErrorOptions,
): HttpException {
	switch (status) {
		case "UNAUTHORIZED": {
			return new UnauthorizedException(message);
		}
		case "FORBIDDEN": {
			return new ForbiddenException(message);
		}
		case "BAD_REQUEST": {
			return new BadRequestException(message);
		}
		case "SERVICE_UNAVAILABLE": {
			return new ServiceUnavailableException(message);
		}
		case "INTERNAL": {
			return new InternalServerErrorException(message);
		}
		case "NOT_FOUND": {
			const configured = options.notFoundStatus ?? HttpStatus.NOT_FOUND;
			if (configured === HttpStatus.NOT_FOUND) {
				return new NotFoundException(NOT_FOUND_DETAIL);
			}
			// Same body shape Nest's own NotFoundException produces, so a custom
			// status does not change what a client can distinguish.
			return new HttpException(
				{ statusCode: configured, message: NOT_FOUND_DETAIL, error: NOT_FOUND_DETAIL },
				configured,
			);
		}
	}
}

/**
 * Builds the right exception type for the execution context.
 *
 * The `NOT_FOUND` message is always {@link NOT_FOUND_DETAIL} — the `message`
 * argument is ignored for it, deliberately, so no call site can leak a probed
 * identifier into a 404 body.
 */
export async function createAuthorizationError(
	kind: PrincipalContextKind,
	status: AuthorizationErrorStatus,
	message?: string,
	options: AuthorizationErrorOptions = {},
): Promise<Error> {
	const text = status === "NOT_FOUND" ? NOT_FOUND_DETAIL : (message ?? status);

	if (kind === "ws") {
		const WsException = await getWsException();
		return new WsException(text);
	}
	if (kind === "rpc") {
		return new Error(text);
	}
	return httpError(status, status === "NOT_FOUND" ? NOT_FOUND_DETAIL : message, options);
}
