import type { DetailedError, Expr } from "../cedar/binding.ts";
import type { PlanApproximationReason } from "../plan/plan.ts";

/**
 * Every failure mode this package surfaces. One flat union, discriminated on
 * {@link PermissionsError.code} rather than on `instanceof`, so callers can
 * branch across a package boundary (bundlers duplicate classes, not strings).
 */
export type PermissionsErrorCode =
	| "ENGINE_INIT"
	| "CEDAR_VERSION"
	| "SCHEMA_INVALID"
	| "POLICY_PARSE"
	| "POLICY_INVALID"
	| "POLICY_SET_NOT_PREPARED"
	| "POLICY_STORE"
	| "ENTITY_RESOLUTION"
	| "EVALUATION_FAILED"
	| "UNSUPPORTED_RESIDUAL"
	| "ERRORED_POLICY"
	| "POST_FILTER_OVERFLOW"
	/** The reference interpreter (`@nestm/permissions-core/testing`) could not answer a node. */
	| "PLAN_EVALUATION";

/** Construction options shared by every error in the taxonomy. */
export interface PermissionsErrorOptions extends ErrorOptions {
	/** Raw Cedar diagnostics (message + help + `sourceLocations`). */
	readonly details?: readonly DetailedError[];
	/** Policy scope the failure belongs to, when the operation had one. */
	readonly scope?: string;
}

/** Captures a V8 stack trace without the constructor frames, where available. */
function captureStack(error: Error, constructorOpaque: new (...args: never[]) => Error): void {
	const capture = (
		Error as unknown as {
			captureStackTrace?: (target: object, constructorOpaque?: unknown) => void;
		}
	).captureStackTrace;

	capture?.(error, constructorOpaque);
}

/**
 * Base class for every error this package throws.
 *
 * Always carries a machine-readable {@link PermissionsErrorCode}; carries
 * Cedar's `DetailedError[]` whenever the failure came from Cedar, which is what
 * lets an admin policy editor draw squiggles at the right source offsets.
 */
export class PermissionsError extends Error {
	override readonly name: string = "PermissionsError";
	/** Machine-readable discriminant. */
	readonly code: PermissionsErrorCode;
	/** Raw Cedar diagnostics, when the failure originated in Cedar. */
	declare readonly details?: readonly DetailedError[];
	/** Policy scope the failure belongs to, when the operation had one. */
	declare readonly scope?: string;

	constructor(code: PermissionsErrorCode, message: string, options: PermissionsErrorOptions = {}) {
		super(message, options.cause === undefined ? undefined : { cause: options.cause });
		this.code = code;
		if (options.details !== undefined) {
			this.details = options.details;
		}
		if (options.scope !== undefined) {
			this.scope = options.scope;
		}
		captureStack(this, new.target);
	}
}

/** Options for {@link CedarVersionError}. */
export interface CedarVersionErrorOptions extends PermissionsErrorOptions {
	/** Version string `getCedarLangVersion()` actually returned. */
	readonly actual: string;
	/** Major version this build of the package was written against. */
	readonly expectedMajor: string;
}

/**
 * The loaded `@cedar-policy/cedar-wasm` reports a Cedar language version this
 * package was not built against. Thrown by `loadCedar()`; always `CEDAR_VERSION`.
 */
export class CedarVersionError extends PermissionsError {
	override readonly name = "CedarVersionError";
	/** Version string `getCedarLangVersion()` actually returned. */
	readonly actual: string;
	/** Major version this build of the package was written against. */
	readonly expectedMajor: string;

	constructor(message: string, options: CedarVersionErrorOptions) {
		super("CEDAR_VERSION", message, options);
		this.actual = options.actual;
		this.expectedMajor = options.expectedMajor;
	}
}

/** Options for {@link SchemaValidationError}. */
export interface SchemaValidationErrorOptions extends PermissionsErrorOptions {
	/** Vocabulary namespace the problem belongs to, when known. */
	readonly namespace?: string;
	/** Dotted path into the `VocabularyDef`, e.g. `entities.Project.memberOf[0]`. */
	readonly path?: string;
}

/**
 * A vocabulary is structurally invalid (thrown by `defineVocabulary`, with
 * `path` set) or Cedar rejected the generated schema (thrown by
 * `assertVocabularyValid`, with `details` set). Always `SCHEMA_INVALID`.
 */
export class SchemaValidationError extends PermissionsError {
	override readonly name = "SchemaValidationError";
	/** Vocabulary namespace the problem belongs to, when known. */
	declare readonly namespace?: string;
	/** Dotted path into the `VocabularyDef`, e.g. `entities.Project.memberOf[0]`. */
	declare readonly path?: string;

	constructor(message: string, options: SchemaValidationErrorOptions = {}) {
		super("SCHEMA_INVALID", message, options);
		if (options.namespace !== undefined) {
			this.namespace = options.namespace;
		}
		if (options.path !== undefined) {
			this.path = options.path;
		}
	}
}

/** Options for {@link UnsupportedResidualError}. */
export interface UnsupportedResidualErrorOptions extends PermissionsErrorOptions {
	/** Policy (or template link) the offending subterm came from. */
	readonly policyId: string;
	/** Effect of that policy. */
	readonly effect: "permit" | "forbid";
	/** Why the subterm could not be pushed down. */
	readonly reason: PlanApproximationReason;
	/** The offending Cedar sub-expression, verbatim. */
	readonly expr: Expr;
	/** Resource type being planned over. */
	readonly resourceType: string;
	/** Action being planned for. */
	readonly action: string;
}

/**
 * A residual sub-expression cannot be pushed into a query, and dropping it would
 * **widen** the selected row set — i.e. return rows `check()` would deny.
 *
 * This is the fail-closed default doing its job. The options are, in order of
 * preference: rewrite the policy into a pushdown-able shape; set
 * `unsupportedResidual: 'post-filter'` for that call and pay the `O(n)`
 * re-check; or supply a function that narrows the subterm yourself. Always
 * `UNSUPPORTED_RESIDUAL`.
 */
export class UnsupportedResidualError extends PermissionsError {
	override readonly name = "UnsupportedResidualError";
	/** Policy (or template link) the offending subterm came from. */
	readonly policyId: string;
	/** Effect of that policy. */
	readonly effect: "permit" | "forbid";
	/** Why the subterm could not be pushed down. */
	readonly reason: PlanApproximationReason;
	/** The offending Cedar sub-expression, verbatim. */
	readonly expr: Expr;
	/** Resource type being planned over. */
	readonly resourceType: string;
	/** Action being planned for. */
	readonly action: string;

	constructor(message: string, options: UnsupportedResidualErrorOptions) {
		super("UNSUPPORTED_RESIDUAL", message, options);
		this.policyId = options.policyId;
		this.effect = options.effect;
		this.reason = options.reason;
		this.expr = options.expr;
		this.resourceType = options.resourceType;
		this.action = options.action;
	}
}

/** Options for {@link ErroredPolicyError}. */
export interface ErroredPolicyErrorOptions extends PermissionsErrorOptions {
	/** Ids Cedar reported in `errored[]`. */
	readonly policyIds: readonly string[];
}

/**
 * Cedar reported policies that **errored** during partial evaluation.
 *
 * An errored policy gets a `{"Value": false}` residual, so an errored `forbid`
 * vanishes from the compiled condition and the plan returns rows it was meant to
 * hide. Refusing to plan is the only safe default. Always `ERRORED_POLICY`.
 */
export class ErroredPolicyError extends PermissionsError {
	override readonly name = "ErroredPolicyError";
	/** Ids Cedar reported in `errored[]`. */
	readonly policyIds: readonly string[];

	constructor(message: string, options: ErroredPolicyErrorOptions) {
		super("ERRORED_POLICY", message, options);
		this.policyIds = options.policyIds;
	}
}

/** Options for {@link PostFilterOverflowError}. */
export interface PostFilterOverflowErrorOptions extends PermissionsErrorOptions {
	/** Rows the caller handed the post-filter. */
	readonly rows: number;
	/** Cap that was exceeded. */
	readonly maxRows: number;
}

/**
 * More rows were handed to `plan.postFilter` than its cap allows.
 *
 * The post-filter re-checks every row through Cedar, so an unbounded call is a
 * self-inflicted denial of service. Paginate before filtering, or fix the policy
 * so the plan does not need a post-filter at all. Always `POST_FILTER_OVERFLOW`.
 */
export class PostFilterOverflowError extends PermissionsError {
	override readonly name = "PostFilterOverflowError";
	/** Rows the caller handed the post-filter. */
	readonly rows: number;
	/** Cap that was exceeded. */
	readonly maxRows: number;

	constructor(message: string, options: PostFilterOverflowErrorOptions) {
		super("POST_FILTER_OVERFLOW", message, options);
		this.rows = options.rows;
		this.maxRows = options.maxRows;
	}
}

/** Narrows an unknown value to a {@link PermissionsError} across package copies. */
export function isPermissionsError(value: unknown): value is PermissionsError {
	if (typeof value !== "object" || value === null) {
		return false;
	}

	const candidate = value as { readonly code?: unknown; readonly message?: unknown };
	return (
		typeof candidate.message === "string" &&
		typeof candidate.code === "string" &&
		Object.hasOwn(PERMISSIONS_ERROR_CODES, candidate.code)
	);
}

/** Runtime mirror of {@link PermissionsErrorCode}, kept exhaustive by the type. */
const PERMISSIONS_ERROR_CODES: Readonly<Record<PermissionsErrorCode, true>> = Object.freeze({
	ENGINE_INIT: true,
	CEDAR_VERSION: true,
	SCHEMA_INVALID: true,
	POLICY_PARSE: true,
	POLICY_INVALID: true,
	POLICY_SET_NOT_PREPARED: true,
	POLICY_STORE: true,
	ENTITY_RESOLUTION: true,
	EVALUATION_FAILED: true,
	UNSUPPORTED_RESIDUAL: true,
	ERRORED_POLICY: true,
	POST_FILTER_OVERFLOW: true,
	PLAN_EVALUATION: true,
});
