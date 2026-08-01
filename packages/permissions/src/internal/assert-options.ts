import { resolveEngineOptions } from "@nestm/permissions-core";
import type { PolicyStore } from "@nestm/permissions-core";

import type { PermissionsModuleOptions } from "../interfaces/permissions-module-options.interface.ts";
import { isProviderArm } from "./definition-resolver.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function assertDefinition(definition: unknown, option: string): void {
	if (!isRecord(definition)) {
		throw new TypeError(
			`PermissionsModule: \`${option}\` must be an instance or a ` +
				`{ useClass } / { useExisting } / { useFactory } definition.`,
		);
	}
	if (!isProviderArm(definition)) {
		return;
	}
	if ("useClass" in definition && typeof definition.useClass !== "function") {
		throw new TypeError(`PermissionsModule: \`${option}.useClass\` must be a class.`);
	}
	if ("useFactory" in definition && typeof definition.useFactory !== "function") {
		throw new TypeError(`PermissionsModule: \`${option}.useFactory\` must be a function.`);
	}
	if (
		"inject" in definition &&
		definition.inject !== undefined &&
		!Array.isArray(definition.inject)
	) {
		throw new TypeError(`PermissionsModule: \`${option}.inject\` must be an array of tokens.`);
	}
}

const DENIAL_DEFAULTS = new Set(["forbidden", "not-found"]);
const UNDECLARED_MODES = new Set(["deny", "allow"]);
const AUDIT_MODES = new Set(["off", "warn", "error"]);

function assertDenialOptions(options: PermissionsModuleOptions): void {
	const denial = options.denial;
	if (denial === undefined) {
		return;
	}
	if (typeof denial !== "object" || denial === null) {
		throw new TypeError("PermissionsModule: `denial` must be an object.");
	}
	if (denial.default !== undefined && !DENIAL_DEFAULTS.has(denial.default)) {
		throw new TypeError('PermissionsModule: `denial.default` must be "forbidden" or "not-found".');
	}
	if (denial.onUndeclaredRoute !== undefined && !UNDECLARED_MODES.has(denial.onUndeclaredRoute)) {
		throw new TypeError('PermissionsModule: `denial.onUndeclaredRoute` must be "deny" or "allow".');
	}
	const status = denial.notFoundStatus;
	if (status !== undefined && (!Number.isInteger(status) || status < 400 || status > 599)) {
		throw new TypeError(
			"PermissionsModule: `denial.notFoundStatus` must be an HTTP error status (400-599).",
		);
	}
	if (denial.onInvalidParam !== undefined && typeof denial.onInvalidParam !== "function") {
		throw new TypeError("PermissionsModule: `denial.onInvalidParam` must be a function.");
	}
}

function assertRouteAuditOptions(options: PermissionsModuleOptions): void {
	const audit = options.routeAudit;
	if (audit === undefined) {
		return;
	}
	if (typeof audit !== "object" || audit === null) {
		throw new TypeError("PermissionsModule: `routeAudit` must be an object.");
	}
	if (audit.mode !== undefined && !AUDIT_MODES.has(audit.mode)) {
		throw new TypeError('PermissionsModule: `routeAudit.mode` must be "off", "warn" or "error".');
	}
	if (audit.ignoreControllers !== undefined && !Array.isArray(audit.ignoreControllers)) {
		throw new TypeError("PermissionsModule: `routeAudit.ignoreControllers` must be an array.");
	}
	if (audit.additionalMetadataKeys !== undefined && !Array.isArray(audit.additionalMetadataKeys)) {
		throw new TypeError("PermissionsModule: `routeAudit.additionalMetadataKeys` must be an array.");
	}
	if (audit.ignoreRoutes !== undefined && !Array.isArray(audit.ignoreRoutes)) {
		throw new TypeError("PermissionsModule: `routeAudit.ignoreRoutes` must be an array.");
	}
	for (const pattern of audit.ignoreRoutes ?? []) {
		if (!(pattern instanceof RegExp)) {
			throw new TypeError(
				"PermissionsModule: every `routeAudit.ignoreRoutes` entry must be a RegExp matched " +
					"against `Controller.method`.",
			);
		}
	}
}

/**
 * Validates module options **synchronously**, before any asynchronous provider
 * factory runs.
 *
 * `resolveEngineOptions` is pure and never touches Cedar, so the whole engine
 * option surface can be validated at registration time — which is what turns "a
 * typo in `policySetCache.maxScopes`" from a boot-time WASM error into a
 * `forRoot()` throw with a stack pointing at the app module.
 *
 * @throws `TypeError` for a malformed provider definition or a seed used with a
 * caller-supplied store; `PermissionsError` (code `ENGINE_INIT`) for anything
 * `resolveEngineOptions` rejects.
 */
export function assertPermissionsModuleOptions(options: PermissionsModuleOptions): void {
	if (!isRecord(options)) {
		throw new TypeError("PermissionsModule.forRoot() requires an options object.");
	}

	if (options.store !== undefined) {
		assertDefinition(options.store, "store");

		// Seeds only ever populate the built-in in-memory store. Writing them into
		// a store the caller owns would mean this module performing an unrequested
		// `save()` against their database at every boot.
		if ((options.policies?.length ?? 0) > 0 || (options.links?.length ?? 0) > 0) {
			throw new TypeError(
				"PermissionsModule: `policies`/`links` seed the built-in in-memory store and cannot be " +
					"combined with `store`. Persist them through your own store instead.",
			);
		}
	}

	if (options.principalResolver !== undefined) {
		assertDefinition(options.principalResolver, "principalResolver");
	}

	if (options.contextBuilder !== undefined && typeof options.contextBuilder !== "function") {
		throw new TypeError("PermissionsModule: `contextBuilder` must be a function.");
	}

	if (options.scopeResolver !== undefined && typeof options.scopeResolver !== "function") {
		throw new TypeError("PermissionsModule: `scopeResolver` must be a function.");
	}

	assertDenialOptions(options);
	assertRouteAuditOptions(options);

	if (options.warmScopes !== undefined) {
		if (!Array.isArray(options.warmScopes)) {
			throw new TypeError("PermissionsModule: `warmScopes` must be an array of scope ids.");
		}
		for (const scope of options.warmScopes) {
			if (typeof scope !== "string") {
				throw new TypeError("PermissionsModule: every `warmScopes` entry must be a string.");
			}
		}
	}

	for (const seed of options.policies ?? []) {
		if (typeof seed?.id !== "string" || seed.id === "") {
			throw new TypeError("PermissionsModule: every seed policy needs a non-empty `id`.");
		}
		const hasText = typeof seed.text === "string";
		const hasJson = isRecord(seed.cedarJson);
		if (hasText === hasJson) {
			throw new TypeError(
				`PermissionsModule: seed policy "${seed.id}" needs exactly one of \`text\` or \`cedarJson\`.`,
			);
		}
	}

	for (const link of options.links ?? []) {
		if (typeof link?.id !== "string" || link.id === "") {
			throw new TypeError("PermissionsModule: every seed link needs a non-empty `id`.");
		}
		if (typeof link.templateId !== "string" || link.templateId === "") {
			throw new TypeError(
				`PermissionsModule: seed link "${link.id}" needs a non-empty \`templateId\`.`,
			);
		}
	}

	// The placeholder store is never used: `resolveEngineOptions` only asserts it
	// is an object, and this call is thrown away. What it buys is every other
	// engine-option check — vocabulary shape, namespace, instanceId, cache bounds
	// — running here rather than inside an async factory at boot.
	resolveEngineOptions({
		vocabulary: options.vocabulary,
		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- never read; see above
		policyStore: {} as PolicyStore,
		...options.engine,
	});
}
