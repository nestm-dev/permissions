import type { Type } from "@nestjs/common";

/**
 * Boot-time coverage check: every route must declare what it enforces.
 *
 * Opt-in (`mode: "off"` by default) because turning it on in `"error"` mode
 * makes an undecorated controller a **boot failure**, which is exactly what you
 * want in CI and exactly what you do not want to inflict on someone installing
 * the package to try one route.
 */
export interface RouteAuditOptions {
	/**
	 * - `"off"` — never scan (default).
	 * - `"warn"` — log undeclared routes once at bootstrap.
	 * - `"error"` — refuse to boot.
	 */
	readonly mode?: "off" | "warn" | "error";
	/** Controllers to skip, by class, exact class name, or name pattern. */
	readonly ignoreControllers?: readonly (string | RegExp | Type<unknown>)[];
	/** Patterns matched against `Controller.method`. */
	readonly ignoreRoutes?: readonly RegExp[];
	/**
	 * Extra metadata keys that also count as "declared".
	 *
	 * The migration seam: an application that already has its own route-authz
	 * decorator lists its key here, and during the cutover both families satisfy
	 * the audit.
	 */
	readonly additionalMetadataKeys?: readonly (string | symbol)[];
}

/** One route the audit found without a declaration. */
export interface UndeclaredRoute {
	/** Controller class name. */
	readonly controller: string;
	/** Handler method name. */
	readonly method: string;
	/** HTTP verb, when the handler carries one. */
	readonly httpMethod: string | undefined;
	/** Full path, controller prefix included. */
	readonly path: string;
	/** `GET /organizations/:id → OrgController.find`. */
	readonly label: string;
}
