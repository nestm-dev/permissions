// cedar-wasm never throws: every entry point returns a `{ type: "success" }` /
// `{ type: "failure" }` union. Left unnarrowed, that union is exactly how a
// failure gets read as a success — so nothing in this package touches an answer
// without going through one of the helpers below.

import type {
	AuthorizationAnswer,
	CheckParseAnswer,
	DetailedError,
	FormattingAnswer,
	PartialAuthorizationAnswer,
	PolicyJson,
	PolicyToJsonAnswer,
	PolicyToTextAnswer,
	ResidualResponse,
	Response,
	SchemaToTextAnswer,
	ValidationAnswer,
} from "./binding.ts";
import { PermissionsError, type PermissionsErrorCode } from "../diagnostics/errors.ts";

/** The failure arm shared by every cedar-wasm answer union. */
export interface CedarFailureAnswer {
	readonly type: "failure";
	readonly errors: DetailedError[];
}

/** Everything a thrown {@link PermissionsError} needs that the answer itself does not carry. */
export interface AnswerContext {
	/** Taxonomy code to raise on failure. */
	readonly code: PermissionsErrorCode;
	/** Human-readable prefix, e.g. `"Cedar rejected the generated schema"`. */
	readonly message: string;
	/** Policy scope the operation belonged to, when it had one. */
	readonly scope?: string;
}

/** True when a cedar-wasm answer is the failure arm. */
export function isCedarFailure(answer: { type: string }): answer is CedarFailureAnswer {
	return answer.type === "failure";
}

/** Flattens `DetailedError[]` into a single line, `related` entries included. */
export function formatDetailedErrors(errors: readonly DetailedError[]): string {
	return errors.map((error) => error.message).join("; ");
}

/** Turns a cedar-wasm failure arm into a thrown {@link PermissionsError}. */
export function throwCedarFailure(answer: CedarFailureAnswer, context: AnswerContext): never {
	throw new PermissionsError(
		context.code,
		`${context.message}: ${formatDetailedErrors(answer.errors)}`,
		{ details: answer.errors, ...(context.scope === undefined ? {} : { scope: context.scope }) },
	);
}

/** Throws unless the parse/preparse succeeded. Returns nothing — success carries no payload. */
export function unwrapCheckParse(answer: CheckParseAnswer, context: AnswerContext): void {
	if (isCedarFailure(answer)) {
		throwCedarFailure(answer, context);
	}
}

/** `isAuthorized` / `statefulIsAuthorized` answer -> Cedar `Response`. */
export function unwrapAuthorization(answer: AuthorizationAnswer, context: AnswerContext): Response {
	if (isCedarFailure(answer)) {
		throwCedarFailure(answer, context);
	}
	return answer.response;
}

/** `isAuthorizedPartial` answer -> Cedar `ResidualResponse`. */
export function unwrapPartialAuthorization(
	answer: PartialAuthorizationAnswer,
	context: AnswerContext,
): ResidualResponse {
	if (isCedarFailure(answer)) {
		throwCedarFailure(answer, context);
	}
	return answer.response;
}

/** `policyToJson` / `templateToJson` answer -> canonical `PolicyJson`. */
export function unwrapPolicyToJson(answer: PolicyToJsonAnswer, context: AnswerContext): PolicyJson {
	if (isCedarFailure(answer)) {
		throwCedarFailure(answer, context);
	}
	return answer.json;
}

/** `policyToText` answer -> Cedar policy text. */
export function unwrapPolicyToText(answer: PolicyToTextAnswer, context: AnswerContext): string {
	if (isCedarFailure(answer)) {
		throwCedarFailure(answer, context);
	}
	return answer.text;
}

/** `schemaToText` answer -> Cedar schema text. Warnings are dropped by design. */
export function unwrapSchemaToText(answer: SchemaToTextAnswer, context: AnswerContext): string {
	if (isCedarFailure(answer)) {
		throwCedarFailure(answer, context);
	}
	return answer.text;
}

/** `formatPolicies` answer -> formatted policy text. */
export function unwrapFormatting(answer: FormattingAnswer, context: AnswerContext): string {
	if (isCedarFailure(answer)) {
		throwCedarFailure(answer, context);
	}
	return answer.formatted_policy;
}

/** The success arm of `validate` — note that per-policy errors live *inside* it. */
export type CedarValidationReport = Extract<ValidationAnswer, { type: "success" }>;

/**
 * `validate` answer -> the validation report.
 *
 * Only a *parse* failure throws. A schema-valid parse whose policies fail
 * validation is a success arm with a non-empty `validationErrors` — the caller
 * decides whether that is fatal.
 */
export function unwrapValidation(
	answer: ValidationAnswer,
	context: AnswerContext,
): CedarValidationReport {
	if (isCedarFailure(answer)) {
		throwCedarFailure(answer, context);
	}
	return answer;
}

/** Cedar diagnostics for a failed answer, or an empty list when it succeeded. */
export function cedarErrorsOf(answer: { type: string }): readonly DetailedError[] {
	return isCedarFailure(answer) ? answer.errors : [];
}
