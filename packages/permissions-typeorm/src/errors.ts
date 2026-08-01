// The compiler's error taxonomy — the runtime half of the fail-closed contract.
//
// > `planToBrackets` compiles **exactly** the `PlanNode` grammar. Anything a
// > mapping does not cover raises a `PlanCompilationError` before any SQL is
// > produced. There is no configuration in which an uncompilable node becomes
// > `TRUE`.
//
// Every class here exists so a caller can tell *which* of those cases fired
// without parsing a message. They deliberately do **not** extend core's
// `PermissionsError`: that type's `code` union is closed and owned by core, and
// a driver inventing a member of someone else's union is how two packages end up
// disagreeing about what a code means. The discriminant here is `reason`, a
// string, so it survives the class duplication a bundler will happily perform
// across package boundaries — and so a consumer using both drivers can catch one
// shape rather than two.

/**
 * Why a plan could not be compiled.
 *
 * One member per throw case in the design's fail-closed table, plus the two
 * structural ones (`resource-type-mismatch`, `value-kind-mismatch`) that can only
 * come from a mapping that does not describe the table it points at. The union is
 * **identical** to `@nestm/permissions-drizzle`'s: the two drivers refuse the same
 * plans for the same reasons, and a consumer switching between them should not
 * have to re-learn the taxonomy.
 */
export type PlanCompilationReason =
	/** The plan reads an attribute the mapping does not declare. */
	| "unmapped-attribute"
	/** An `inHierarchy` node names a parent type the mapping has no strategy for. */
	| "unmapped-hierarchy"
	/** `<`/`<=`/`>`/`>=` over a value kind Cedar does not order (a string, above all). */
	| "unorderable-comparison"
	/** `contains`/`isEmpty` against a column the mapping declares as a scalar. */
	| "contains-on-scalar"
	/** An entity constant compared against a column the mapping does not declare as an entity. */
	| "entity-column-mismatch"
	/** `like` against a column whose declared collation is case-insensitive. */
	| "case-insensitive-like"
	/** The plan carries a permissive approximation and the caller did not opt in. */
	| "permissive-approximation"
	/** `plan.resourceType` is not the type the mapping describes. */
	| "resource-type-mismatch"
	/** A `PlanValue` kind the mapped column cannot hold. */
	| "value-kind-mismatch"
	/** A mapping is structurally unusable (a bad property path, a malformed hierarchy entry). */
	| "invalid-mapping";

/** Construction options shared by the taxonomy. */
export interface PlanCompilationErrorOptions extends ErrorOptions {
	/** Resource type the compilation was for. */
	readonly resourceType?: string;
	/** Attribute path the failure concerns, dotted. */
	readonly attribute?: string;
	/** Parent entity type an `inHierarchy` node named. */
	readonly parentType?: string;
}

/**
 * Base class for every refusal `planToBrackets` can make.
 *
 * A `PlanCompilationError` is always a *programming* error — a mapping that does
 * not describe the table, or a caller that has not opted into a widened plan.
 * It is never "this row does not match", and it is never recoverable by
 * substituting a weaker filter: the only sound recoveries are to fix the mapping
 * or to refuse the query.
 */
export class PlanCompilationError extends Error {
	override readonly name: string = "PlanCompilationError";
	/** Machine-readable discriminant. Stable across package/bundle duplication. */
	readonly code = "PLAN_COMPILATION" as const;
	/** Which fail-closed case fired. */
	readonly reason: PlanCompilationReason;
	/** Resource type the compilation was for, when known. */
	declare readonly resourceType?: string;
	/** Attribute path the failure concerns, when it has one. */
	declare readonly attribute?: string;
	/** Parent entity type an `inHierarchy` node named, when it has one. */
	declare readonly parentType?: string;

	constructor(
		reason: PlanCompilationReason,
		message: string,
		options: PlanCompilationErrorOptions = {},
	) {
		super(message, options.cause === undefined ? undefined : { cause: options.cause });
		this.reason = reason;
		if (options.resourceType !== undefined) {
			this.resourceType = options.resourceType;
		}
		if (options.attribute !== undefined) {
			this.attribute = options.attribute;
		}
		if (options.parentType !== undefined) {
			this.parentType = options.parentType;
		}
		captureStack(this, new.target);
	}
}

/**
 * The plan reads an attribute the mapping does not declare — or the mapping
 * names a property path the entity does not have.
 */
export class UnmappedAttributeError extends PlanCompilationError {
	override readonly name = "UnmappedAttributeError";

	constructor(message: string, options: PlanCompilationErrorOptions = {}) {
		super("unmapped-attribute", message, options);
	}
}

/**
 * An `inHierarchy` node names a parent entity type the mapping cannot answer.
 *
 * This is the one the design calls out by name, because the tempting "wrong"
 * answer is `TRUE`: Cedar's `in` is how a role grant reaches a subtree, so a
 * missing mapping looks like "no restriction" if you squint. It is the opposite —
 * an unanswerable hierarchy question means the driver has no idea which rows the
 * grant covers.
 */
export class UnmappedHierarchyError extends PlanCompilationError {
	override readonly name = "UnmappedHierarchyError";

	constructor(message: string, options: PlanCompilationErrorOptions = {}) {
		super("unmapped-hierarchy", message, options);
	}
}

/** Whether `value` is one of this package's compilation errors, across bundle copies. */
export function isPlanCompilationError(value: unknown): value is PlanCompilationError {
	return (
		value instanceof Error &&
		(value as { code?: unknown }).code === "PLAN_COMPILATION" &&
		typeof (value as { reason?: unknown }).reason === "string"
	);
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
