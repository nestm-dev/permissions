import type { CedarBinding } from "./binding.ts";
import { CedarVersionError } from "../diagnostics/errors.ts";

/** Cedar language major version this build of the package was written against. */
export const SUPPORTED_CEDAR_MAJOR = "4";

/**
 * Registry key for the "exactly one copy of this package" tripwire.
 *
 * Two physical copies of `@nestm/permissions-core` mean two Cedar WASM
 * instances, each with its own thread-local preparse cache — which surfaces
 * much later as sporadic "preparsed policy set not found" failures under load.
 * Registering here makes the duplicate visible at load time instead.
 */
const INSTANCE_KEY: unique symbol = Symbol.for("@nestm/permissions-core/instance");

/** What a copy of this package publishes about itself on `globalThis`. */
export interface CedarInstanceRegistration {
	/** Identity of the module evaluation that registered. Differs per copy. */
	readonly instanceId: string;
	/** Cedar language version that copy loaded. */
	readonly cedarLangVersion: string;
	/** How many distinct copies have attempted to load Cedar in this realm. */
	copies: number;
}

type GlobalWithRegistry = typeof globalThis & {
	[INSTANCE_KEY]?: CedarInstanceRegistration;
};

/** Identity of *this* module evaluation. A second copy of the package gets a different one. */
const INSTANCE_ID = `permissions-core-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

let binding: Promise<CedarBinding> | undefined;
let duplicateReported = false;

/**
 * Loads the Cedar WASM binding, memoised for the lifetime of the module.
 *
 * The import is dynamic on purpose: it keeps ~4.1 MiB of WASM out of the module
 * graph until something actually authorizes, which is what lets the ORM drivers
 * and the vocabulary builder import this package for its types alone.
 *
 * @throws {@link CedarVersionError} if the loaded Cedar reports a language
 * version outside the supported major.
 */
export async function loadCedar(): Promise<CedarBinding> {
	binding ??= importCedar().catch((error: unknown) => {
		// A failed load must not poison the memo: a version mismatch is a
		// configuration error the host may fix and retry (tests do exactly this).
		binding = undefined;
		throw error;
	});

	return binding;
}

/**
 * Whether {@link loadCedar} has been called in this module instance.
 *
 * Exists so tests can assert that a code path — `defineVocabulary`, notably —
 * never reaches the WASM.
 *
 * @internal
 */
export function __cedarLoaded(): boolean {
	return binding !== undefined;
}

/**
 * Drops the memoised binding so the next {@link loadCedar} re-imports.
 *
 * Does not unload the WASM (there is no such API); the module registry keeps the
 * real instance. Test-only.
 *
 * @internal
 */
export function __resetCedarLoader(): void {
	binding = undefined;
	duplicateReported = false;
}

async function importCedar(): Promise<CedarBinding> {
	const cedar = await import("@cedar-policy/cedar-wasm/nodejs");

	const cedarLangVersion = cedar.getCedarLangVersion();

	if (!cedarLangVersion.startsWith(`${SUPPORTED_CEDAR_MAJOR}.`)) {
		throw new CedarVersionError(
			`@nestm/permissions-core supports Cedar ${SUPPORTED_CEDAR_MAJOR}.x, but the installed ` +
				`@cedar-policy/cedar-wasm reports language version ${cedarLangVersion}. ` +
				`Pin @cedar-policy/cedar-wasm to a ${SUPPORTED_CEDAR_MAJOR}.x release.`,
			{ actual: cedarLangVersion, expectedMajor: SUPPORTED_CEDAR_MAJOR },
		);
	}

	registerInstance(cedarLangVersion);

	// Rebound onto a plain object rather than returned as the namespace: the
	// namespace is a live binding whose shape is wider than `CedarBinding`, and
	// pinning the surface here is what makes the seam a real contract.
	return {
		isAuthorized: cedar.isAuthorized,
		statefulIsAuthorized: cedar.statefulIsAuthorized,
		isAuthorizedPartial: cedar.isAuthorizedPartial,
		preparsePolicySet: cedar.preparsePolicySet,
		preparseSchema: cedar.preparseSchema,
		validate: cedar.validate,
		policyToJson: cedar.policyToJson,
		policyToText: cedar.policyToText,
		templateToJson: cedar.templateToJson,
		templateToText: cedar.templateToText,
		schemaToText: cedar.schemaToText,
		checkParseSchema: cedar.checkParseSchema,
		formatPolicies: cedar.formatPolicies,
		getCedarLangVersion: cedar.getCedarLangVersion,
	};
}

function registerInstance(cedarLangVersion: string): void {
	const registry = globalThis as GlobalWithRegistry;
	const existing = registry[INSTANCE_KEY];

	if (existing === undefined) {
		registry[INSTANCE_KEY] = { instanceId: INSTANCE_ID, cedarLangVersion, copies: 1 };
		return;
	}

	if (existing.instanceId === INSTANCE_ID) {
		return;
	}

	existing.copies += 1;

	if (duplicateReported) {
		return;
	}
	duplicateReported = true;

	// Not a throw: a duplicate copy is usually a hoisting accident that still
	// mostly works, and failing hard here would break an app at boot for a
	// problem it can fix in its lockfile.
	// oxlint-disable-next-line no-console -- the tripwire has to be visible without a logger dependency
	console.error(
		`[@nestm/permissions-core] More than one copy of this package loaded Cedar in this ` +
			`process (${existing.copies} so far). Each copy owns a separate WASM instance with a ` +
			`separate preparsed-policy-set cache, which surfaces later as sporadic ` +
			`"preparsed policy set not found" errors. Deduplicate the dependency ` +
			`(pnpm dedupe / a single workspace version) before shipping.`,
	);
}
