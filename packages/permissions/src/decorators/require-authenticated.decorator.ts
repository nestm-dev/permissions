import { Reflector } from "@nestjs/core";

import { METADATA_KEY } from "../permissions.constants.ts";

/**
 * Requires a resolvable principal, but no Cedar decision.
 *
 * The "logged in is enough" escape hatch for routes that genuinely have no
 * resource — `GET /me`, a health probe behind auth. Consumed by the guard in the
 * next slice; the metadata key is stable from now on.
 */
export const RequireAuthenticated = Reflector.createDecorator<void, true>({
	key: METADATA_KEY.requireAuthenticated,
	transform: () => true,
});
