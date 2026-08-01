// Text <-> JSON for policies and templates.
//
// The store's canonical form is `PolicyJson`; humans and admin UIs work in Cedar
// text. These helpers are the only sanctioned bridge, and every failure they
// surface is a `POLICY_PARSE` carrying Cedar's own `DetailedError[]` — offsets
// included, so an editor can draw squiggles where the parser actually stopped.

import type { CedarBinding, PolicyJson } from "../cedar/binding.ts";
import {
	isCedarFailure,
	throwCedarFailure,
	unwrapFormatting,
	unwrapPolicyToJson,
	unwrapPolicyToText,
	type AnswerContext,
} from "../cedar/answers.ts";
import { fail } from "../util/assert.ts";
import {
	GLOBAL_POLICY_SCOPE,
	TEMPLATE_SLOT_IDS,
	isTemplateSlotId,
	type PolicyKind,
	type PolicyRecord,
	type PolicyScopeId,
	type TemplateSlotId,
} from "./policy-store.ts";

/** Options shared by the parsing helpers. */
export interface ParsePolicyTextOptions {
	/**
	 * Forces the parser arm.
	 *
	 * Omit it to auto-detect: the text is parsed as a static policy first and as
	 * a template only if that fails, so a template is never mistaken for a policy
	 * with a stray `?` in a string literal.
	 */
	readonly kind?: PolicyKind;
	/** Scope reported on the thrown error, for diagnostics. */
	readonly scope?: PolicyScopeId;
}

/** Options for {@link formatPolicyText}, mirroring Cedar's `FormattingCall`. */
export interface FormatPolicyTextOptions {
	/** Maximum line width before the formatter wraps. */
	readonly lineWidth?: number;
	/** Indent width in spaces. */
	readonly indentWidth?: number;
}

function parseContext(scope: PolicyScopeId | undefined, message: string): AnswerContext {
	return { code: "POLICY_PARSE", message, ...(scope === undefined ? {} : { scope }) };
}

/**
 * The slots a policy declares, in canonical order.
 *
 * Cedar only allows slots in a policy's scope (the `principal` and `resource`
 * constraints), never inside a condition, so those two constraints are the whole
 * search space. Pure: no Cedar binding required.
 *
 * @throws `PermissionsError` with code `POLICY_INVALID` for a slot name Cedar
 * could not have produced.
 */
export function templateSlotsOf(json: PolicyJson): readonly TemplateSlotId[] {
	const declared = new Set<TemplateSlotId>();

	for (const [variable, constraint] of [
		["principal", json.principal],
		["resource", json.resource],
	] as const) {
		if (!("slot" in constraint)) {
			continue;
		}
		const slot: string = constraint.slot;
		if (!isTemplateSlotId(slot)) {
			fail(
				"POLICY_INVALID",
				`The ${variable} constraint declares the slot "${slot}"; Cedar only accepts ` +
					`"?principal" and "?resource".`,
			);
		}
		declared.add(slot);
	}

	return TEMPLATE_SLOT_IDS.filter((slot) => declared.has(slot));
}

/** Whether `json` is a template (declares at least one slot). */
export function isTemplateJson(json: PolicyJson): boolean {
	return templateSlotsOf(json).length > 0;
}

/** `'template'` when `json` declares slots, `'static'` otherwise. */
export function policyKindOf(json: PolicyJson): PolicyKind {
	return isTemplateJson(json) ? "template" : "static";
}

/**
 * Cedar policy or template text -> canonical `PolicyJson`.
 *
 * @throws `PermissionsError` with code `POLICY_PARSE`, carrying Cedar's
 * diagnostics.
 */
export function parsePolicyText(
	binding: CedarBinding,
	text: string,
	options: ParsePolicyTextOptions = {},
): PolicyJson {
	if (options.kind === "template") {
		return templateToJsonRecord(binding, text, options);
	}

	const asStatic = binding.policyToJson(text);
	if (!isCedarFailure(asStatic)) {
		return asStatic.json;
	}

	if (options.kind === "static") {
		return throwCedarFailure(
			asStatic,
			parseContext(options.scope, "Cedar rejected the static policy text"),
		);
	}

	// Auto-detect: a template fails the static parse with a dedicated diagnostic,
	// so the second attempt is the only way to tell "is a template" from
	// "is broken". A genuinely broken input fails both, and the static
	// diagnostics are the ones that point at the syntax error.
	const asTemplate = binding.templateToJson(text);
	if (!isCedarFailure(asTemplate)) {
		return asTemplate.json;
	}

	return throwCedarFailure(
		asStatic,
		parseContext(options.scope, "Cedar rejected the policy text as both a policy and a template"),
	);
}

/**
 * Cedar **template** text -> canonical `PolicyJson`.
 *
 * Rejects a static policy: Cedar requires a template to declare at least one of
 * `?principal` / `?resource`.
 *
 * @throws `PermissionsError` with code `POLICY_PARSE`.
 */
export function templateToJsonRecord(
	binding: CedarBinding,
	text: string,
	options: Pick<ParsePolicyTextOptions, "scope"> = {},
): PolicyJson {
	return unwrapPolicyToJson(
		binding.templateToJson(text),
		parseContext(options.scope, "Cedar rejected the template text"),
	);
}

/**
 * Canonical `PolicyJson` -> Cedar text, for policies and templates alike.
 *
 * The arm is chosen from the JSON itself: `policyToText` rejects a template and
 * `templateToText` rejects a static policy, so dispatching on
 * {@link templateSlotsOf} is what makes this total.
 *
 * @throws `PermissionsError` with code `POLICY_PARSE`.
 */
export function renderPolicyText(
	binding: CedarBinding,
	json: PolicyJson,
	options: Pick<ParsePolicyTextOptions, "scope"> = {},
): string {
	const context = parseContext(options.scope, "Cedar rejected the policy JSON");

	return isTemplateJson(json)
		? unwrapPolicyToText(binding.templateToText(json), context)
		: unwrapPolicyToText(binding.policyToText(json), context);
}

/**
 * Runs Cedar's own formatter over policy text. Templates are accepted.
 *
 * @throws `PermissionsError` with code `POLICY_PARSE`.
 */
export function formatPolicyText(
	binding: CedarBinding,
	text: string,
	options: FormatPolicyTextOptions = {},
): string {
	return unwrapFormatting(
		binding.formatPolicies({
			policyText: text,
			...(options.lineWidth === undefined ? {} : { lineWidth: options.lineWidth }),
			...(options.indentWidth === undefined ? {} : { indentWidth: options.indentWidth }),
		}),
		parseContext(undefined, "Cedar could not format the policy text"),
	);
}

/** Input for {@link policyRecordFromText}. */
export interface PolicyRecordFromTextInput {
	/** Cedar policy id. */
	readonly id: string;
	/** Cedar policy or template text. */
	readonly text: string;
	/** Target scope. Defaults to the global scope (`''`). */
	readonly scope?: PolicyScopeId;
	/** Forces the parser arm; inferred from the parsed JSON when omitted. */
	readonly kind?: PolicyKind;
	/** Free-text description for admin UIs. */
	readonly description?: string;
	/** Cedar annotations to mirror onto the record. */
	readonly annotations?: Readonly<Record<string, string>>;
	/** Defaults to `true`. */
	readonly enabled?: boolean;
	/** Defaults to `new Date()`. */
	readonly updatedAt?: Date;
}

/**
 * Convenience: Cedar text -> a ready-to-`save()` {@link PolicyRecord}.
 *
 * `kind` is inferred from the parsed JSON when not given, so a template text
 * always produces `kind: 'template'` and can never be stored as a static policy
 * the builder would then refuse to link.
 */
export function policyRecordFromText(
	binding: CedarBinding,
	input: PolicyRecordFromTextInput,
): PolicyRecord {
	const scope = input.scope ?? GLOBAL_POLICY_SCOPE;
	const cedarJson = parsePolicyText(binding, input.text, {
		scope,
		...(input.kind === undefined ? {} : { kind: input.kind }),
	});

	const record: {
		id: string;
		scope: PolicyScopeId;
		kind: PolicyKind;
		cedarJson: PolicyJson;
		description?: string;
		annotations?: Readonly<Record<string, string>>;
		enabled: boolean;
		updatedAt: Date;
	} = {
		id: input.id,
		scope,
		kind: input.kind ?? policyKindOf(cedarJson),
		cedarJson,
		enabled: input.enabled ?? true,
		updatedAt: input.updatedAt ?? new Date(),
	};

	if (input.description !== undefined) {
		record.description = input.description;
	}
	if (input.annotations !== undefined) {
		record.annotations = { ...input.annotations };
	}

	return record;
}
