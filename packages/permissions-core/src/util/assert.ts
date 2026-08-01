// Invariant helpers. Every internal precondition in this package fails through
// one of these so the thrown value is always a `PermissionsError` carrying a
// machine-readable code — never a bare `Error` a caller has to string-match.

import {
	PermissionsError,
	type PermissionsErrorCode,
	type PermissionsErrorOptions,
} from "../diagnostics/errors.ts";

/**
 * Throws a {@link PermissionsError}.
 *
 * Declared `never` so it can be used as an expression in a ternary or at the end
 * of an exhaustiveness switch.
 */
export function fail(
	code: PermissionsErrorCode,
	message: string,
	options?: PermissionsErrorOptions,
): never {
	throw new PermissionsError(code, message, options);
}

/**
 * Throws {@link PermissionsError} unless `condition` is truthy.
 *
 * The `asserts` signature narrows the caller's types, so a checked value stays
 * narrowed for the rest of the scope.
 */
export function invariant(
	condition: unknown,
	code: PermissionsErrorCode,
	message: string,
	options?: PermissionsErrorOptions,
): asserts condition {
	if (!condition) {
		fail(code, message, options);
	}
}

/** Returns `value` when it is neither `null` nor `undefined`; throws otherwise. */
export function assertDefined<T>(
	value: T,
	code: PermissionsErrorCode,
	message: string,
	options?: PermissionsErrorOptions,
): NonNullable<T> {
	if (value === null || value === undefined) {
		fail(code, message, options);
	}
	return value;
}

/**
 * Exhaustiveness guard for discriminated unions.
 *
 * Reaching it is a type error at compile time and a `PermissionsError` at
 * runtime (which is what happens when untrusted JSON widens a union).
 */
export function assertNever(value: never, code: PermissionsErrorCode, message: string): never {
	fail(code, `${message}: ${String(value)}`);
}
