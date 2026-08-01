import { Inject, Injectable, Logger, RequestMethod } from "@nestjs/common";
import { DiscoveryService, MetadataScanner, Reflector } from "@nestjs/core";
import type { OnApplicationBootstrap, Type } from "@nestjs/common";

import { METADATA_KEY } from "../permissions.constants.ts";
import { PERMISSIONS_MODULE_OPTIONS } from "../permissions.tokens.ts";
import { loadOptionalModule } from "../utils/execution-context.util.ts";
import type { PermissionsModuleOptions } from "../interfaces/permissions-module-options.interface.ts";
import type {
	RouteAuditOptions,
	UndeclaredRoute,
} from "../interfaces/route-audit-options.interface.ts";

/**
 * The two metadata keys Nest writes on a route handler.
 *
 * They live in `@nestjs/common/constants`, which is a **deep import into
 * framework internals**. Their values have been the literals below since Nest 5
 * and Nest's own `@Get()` writes exactly those, so the fallback is not a guess —
 * but the import is still wrapped, because a package that refuses to load
 * because an internal path moved is a worse failure than one that reads a
 * string constant.
 */
export const FALLBACK_ROUTE_METADATA_KEYS = { path: "path", method: "method" } as const;

/** Resolved metadata keys, and where they came from. */
export interface RouteMetadataKeys {
	readonly path: string;
	readonly method: string;
	readonly source: "nest" | "fallback";
}

let cachedKeys: RouteMetadataKeys | undefined;

/** Test seam: drops the memoised keys. */
export function __resetRouteMetadataKeys(): void {
	cachedKeys = undefined;
}

/**
 * Reads `PATH_METADATA`/`METHOD_METADATA` from Nest, falling back to their
 * literal values when the deep import is unavailable.
 *
 * @param load injection point for the deep import; the default is the real one.
 */
export async function loadRouteMetadataKeys(
	load: (name: string) => Promise<Record<string, unknown>> = loadOptionalModule,
): Promise<RouteMetadataKeys> {
	if (cachedKeys !== undefined) {
		return cachedKeys;
	}
	try {
		const constants = await load("@nestjs/common/constants");
		const path = constants.PATH_METADATA;
		const method = constants.METHOD_METADATA;
		if (typeof path === "string" && typeof method === "string") {
			cachedKeys = { path, method, source: "nest" };
			return cachedKeys;
		}
	} catch {
		// Deliberately silent: the fallback is correct, and warning about a Nest
		// internal on every boot would be noise nobody can act on.
	}
	cachedKeys = { ...FALLBACK_ROUTE_METADATA_KEYS, source: "fallback" };
	return cachedKeys;
}

const HTTP_METHOD_NAMES: Readonly<Record<number, string>> = Object.fromEntries(
	Object.entries(RequestMethod)
		.filter(([, value]) => typeof value === "number")
		.map(([name, value]) => [value as number, name]),
);

function firstSegment(value: unknown): string {
	const candidate = Array.isArray(value) ? value[0] : value;
	return typeof candidate === "string" ? candidate : "";
}

function joinPath(controllerPath: unknown, handlerPath: unknown): string {
	const parts = [firstSegment(controllerPath), firstSegment(handlerPath)]
		.map((part) => part.replaceAll(/^\/+|\/+$/g, ""))
		.filter((part) => part !== "");
	return `/${parts.join("/")}`;
}

function matchesController(pattern: string | RegExp | Type<unknown>, metatype: Function): boolean {
	if (typeof pattern === "string") {
		return metatype.name === pattern;
	}
	if (pattern instanceof RegExp) {
		return pattern.test(metatype.name);
	}
	return (pattern as unknown) === (metatype as unknown);
}

/**
 * Refuses to start the application while a route enforces nothing.
 *
 * Generalises station's `route-authorization.audit.ts`. Two improvements over
 * it: the report names the actual endpoint (`GET /organizations/:id →
 * OrgController.find`, not just `OrgController.find`), and
 * `additionalMetadataKeys` lets an application whose own route-authz decorator
 * predates this package count as declared during the cutover.
 *
 * Off by default. `"warn"` logs, `"error"` throws from `onApplicationBootstrap`
 * — which is what makes an undecorated endpoint fail CI (any pipeline step that
 * boots the app) rather than reach production.
 */
@Injectable()
export class RouteAuthorizationAudit implements OnApplicationBootstrap {
	private readonly logger = new Logger(RouteAuthorizationAudit.name);
	private keys: RouteMetadataKeys = { ...FALLBACK_ROUTE_METADATA_KEYS, source: "fallback" };

	constructor(
		private readonly discovery: DiscoveryService,
		private readonly metadataScanner: MetadataScanner,
		private readonly reflector: Reflector,
		@Inject(PERMISSIONS_MODULE_OPTIONS) private readonly options: PermissionsModuleOptions,
	) {}

	/** The effective audit configuration. */
	get auditOptions(): RouteAuditOptions {
		return this.options.routeAudit ?? {};
	}

	async onApplicationBootstrap(): Promise<void> {
		const mode = this.auditOptions.mode ?? "off";
		if (mode === "off") {
			return;
		}

		this.keys = await loadRouteMetadataKeys();
		const undeclared = this.findUndeclaredRoutes();
		if (undeclared.length === 0) {
			this.logger.log("Route authorization audit passed: every route declares what it enforces.");
			return;
		}

		const report = undeclared.map((route) => route.label).join("\n  ");
		const message =
			"Every route must declare @RequirePermission(), @RequireAuthenticated() or @Public(). " +
			`Undeclared:\n  ${report}`;

		if (mode === "error") {
			throw new Error(message);
		}
		this.logger.warn(message);
	}

	/**
	 * Every route handler carrying none of the recognised declarations.
	 *
	 * Public so a test — or an application's own boot check — can assert the list
	 * instead of parsing a log line.
	 */
	findUndeclaredRoutes(): UndeclaredRoute[] {
		const options = this.auditOptions;
		const undeclared: UndeclaredRoute[] = [];

		for (const wrapper of this.discovery.getControllers()) {
			const { instance, metatype } = wrapper;
			if (!instance || !metatype) {
				continue;
			}
			if (options.ignoreControllers?.some((pattern) => matchesController(pattern, metatype))) {
				continue;
			}

			const prototype: unknown = Object.getPrototypeOf(instance);
			if (typeof prototype !== "object" || prototype === null) {
				continue;
			}
			const controllerPath: unknown = Reflect.getMetadata(this.keys.path, metatype);

			for (const methodName of this.metadataScanner.getAllMethodNames(prototype)) {
				// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- walking an arbitrary controller prototype is the point
				const handler: unknown = (prototype as Record<string, unknown>)[methodName];
				if (typeof handler !== "function") {
					continue;
				}
				// Only route handlers carry path metadata.
				const handlerPath: unknown = Reflect.getMetadata(this.keys.path, handler);
				if (handlerPath === undefined) {
					continue;
				}

				const label = `${metatype.name}.${methodName}`;
				if (options.ignoreRoutes?.some((pattern) => pattern.test(label))) {
					continue;
				}
				if (this.isDeclared(handler, metatype, options)) {
					continue;
				}

				const rawMethod: unknown = Reflect.getMetadata(this.keys.method, handler);
				const httpMethod = typeof rawMethod === "number" ? HTTP_METHOD_NAMES[rawMethod] : undefined;
				const path = joinPath(controllerPath, handlerPath);

				undeclared.push({
					controller: metatype.name,
					method: methodName,
					httpMethod,
					path,
					label: `${httpMethod ?? "?"} ${path} → ${label}`,
				});
			}
		}

		return undeclared;
	}

	/**
	 * A route counts as declared if it carries any recognised marker.
	 *
	 * `getAllAndOverride` rather than `get`, so a controller-level declaration
	 * covers its handlers — the audit asks "is this route's authorization
	 * decided somewhere", not "does this method repeat it".
	 */
	private isDeclared(handler: Function, metatype: Function, options: RouteAuditOptions): boolean {
		const targets = [handler, metatype];
		const keys: readonly (string | symbol)[] = [
			METADATA_KEY.requirePermission,
			METADATA_KEY.public,
			METADATA_KEY.requireAuthenticated,
			...(options.additionalMetadataKeys ?? []),
		];
		return keys.some(
			(key) => this.reflector.getAllAndOverride<unknown>(key, targets) !== undefined,
		);
	}
}
