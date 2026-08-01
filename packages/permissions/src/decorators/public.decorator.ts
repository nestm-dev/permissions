import { Reflector } from "@nestjs/core";

import { METADATA_KEY } from "../permissions.constants.ts";

/**
 * Marks a route (or a whole controller) as reachable without authorization.
 *
 * Applied to a class it is inherited by every handler — and, once the real guard
 * lands, a handler that declares its own `@RequirePermission()` wins over an
 * inherited `@Public()`, because a class-level marker must never silently defeat
 * an explicit route-level requirement.
 */
export const Public = Reflector.createDecorator<void, true>({
	key: METADATA_KEY.public,
	transform: () => true,
});
