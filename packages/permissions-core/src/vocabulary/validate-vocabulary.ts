import type { CedarBinding, DetailedError, Schema } from "../cedar/binding.ts";
import { cedarErrorsOf, unwrapSchemaToText } from "../cedar/answers.ts";
import { loadCedar } from "../cedar/loader.ts";
import { SchemaValidationError } from "../diagnostics/errors.ts";
import type { AnyVocabulary } from "./types.ts";

/** Outcome of validating a schema against Cedar itself. */
export type VocabularyValidationResult =
	{ readonly ok: true } | { readonly ok: false; readonly errors: readonly DetailedError[] };

/** Anything `validateVocabulary` accepts: a built vocabulary or a raw Cedar schema. */
export type ValidatableSchema = AnyVocabulary | Schema;

function isVocabulary(value: ValidatableSchema): value is AnyVocabulary {
	return typeof value === "object" && value !== null && "cedarSchemaJson" in value;
}

/** The Cedar schema behind either input form. */
export function schemaOf(value: ValidatableSchema): Schema {
	return isVocabulary(value) ? value.cedarSchemaJson : value;
}

/**
 * Runs Cedar's own `checkParseSchema` over a vocabulary's generated schema.
 *
 * `defineVocabulary` deliberately does not do this (delta D3: the builder must
 * stay WASM-free so a browser bundle importing a vocabulary does not pull in
 * 4.1 MiB). This is the on-demand half — call it in a test, a CLI or a boot
 * check; `PermissionsEngine.create()` calls it unconditionally.
 *
 * @param vocabulary a built vocabulary, or a raw Cedar schema (text or JSON).
 * @param binding an already-loaded Cedar binding; loaded on demand when omitted.
 */
export async function validateVocabulary(
	vocabulary: ValidatableSchema,
	binding?: CedarBinding,
): Promise<VocabularyValidationResult> {
	const cedar = binding ?? (await loadCedar());
	const answer = cedar.checkParseSchema(schemaOf(vocabulary));

	if (answer.type === "success") {
		return { ok: true };
	}

	return { ok: false, errors: cedarErrorsOf(answer) };
}

/**
 * {@link validateVocabulary}, but throws instead of returning a result.
 *
 * @throws {@link SchemaValidationError} carrying Cedar's `DetailedError[]` in
 * `details`, which is what lets an admin UI draw squiggles at the right offsets.
 */
export async function assertVocabularyValid(
	vocabulary: ValidatableSchema,
	binding?: CedarBinding,
): Promise<void> {
	const result = await validateVocabulary(vocabulary, binding);

	if (result.ok) {
		return;
	}

	const namespace = isVocabulary(vocabulary) ? vocabulary.namespace : undefined;

	throw new SchemaValidationError(
		`Cedar rejected the schema${namespace === undefined ? "" : ` for namespace "${namespace}"`}: ` +
			result.errors.map((error) => error.message).join("; "),
		{
			details: result.errors,
			...(namespace === undefined ? {} : { namespace }),
		},
	);
}

/**
 * Renders a vocabulary as Cedar schema text, loading Cedar on demand.
 *
 * The convenience wrapper around `vocabulary.toCedarSchemaText(binding)`, which
 * takes its binding explicitly so the `Vocabulary` interface stays WASM-free.
 */
export async function renderVocabularySchemaText(
	vocabulary: ValidatableSchema,
	binding?: CedarBinding,
): Promise<string> {
	const cedar = binding ?? (await loadCedar());

	return unwrapSchemaToText(cedar.schemaToText(schemaOf(vocabulary)), {
		code: "SCHEMA_INVALID",
		message: "Cedar could not render the schema",
	});
}
