// The Cedar seam. Every Cedar call the engine makes goes through `CedarBinding`,
// so unit tests can stub the WASM module and a future worker-thread or `/web`
// binding can be dropped in without touching call sites.
//
// The types below are *not* hand-copied: they are re-exported from the `.d.ts`
// that ships inside `@cedar-policy/cedar-wasm/nodejs`. This import is
// `import type`, so it is erased at compile time and importing this module
// never instantiates the 4.1 MiB WASM.

import type {
	AuthorizationAnswer,
	AuthorizationCall,
	CheckParseAnswer,
	FormattingAnswer,
	FormattingCall,
	PartialAuthorizationAnswer,
	PartialAuthorizationCall,
	Policy,
	PolicySet,
	PolicyToJsonAnswer,
	PolicyToTextAnswer,
	Schema,
	SchemaToTextAnswer,
	StatefulAuthorizationCall,
	Template,
	ValidationAnswer,
	ValidationCall,
} from "@cedar-policy/cedar-wasm/nodejs";

/**
 * The subset of `@cedar-policy/cedar-wasm/nodejs` this package depends on.
 *
 * Deliberately a *narrowing* of the module: anything not listed here is not
 * part of the engine's contract and cannot be relied upon by a custom binding.
 */
export interface CedarBinding {
	/** Stateless authorization. ~1.98 ms/op at 40 policies — prefer {@link statefulIsAuthorized}. */
	isAuthorized(call: AuthorizationCall): AuthorizationAnswer;
	/** Authorization against a preparsed policy set. ~0.136 ms/op — 14.6x faster. */
	statefulIsAuthorized(call: StatefulAuthorizationCall): AuthorizationAnswer;
	/** Partial evaluation; cannot use the preparse cache (no `preparsedPolicySetId` field). */
	isAuthorizedPartial(call: PartialAuthorizationCall): PartialAuthorizationAnswer;
	/** Registers a policy set under `psetId`. Re-registering the same id frees the old one. */
	preparsePolicySet(psetId: string, policies: PolicySet): CheckParseAnswer;
	/** Registers a schema under `schemaName` for use as `preparsedSchemaName`. */
	preparseSchema(schemaName: string, schema: Schema): CheckParseAnswer;
	/** Validates a policy set against a schema. */
	validate(call: ValidationCall): ValidationAnswer;
	/** Cedar text or JSON policy -> canonical `PolicyJson`. */
	policyToJson(policy: Policy): PolicyToJsonAnswer;
	/** Canonical `PolicyJson` -> Cedar text. */
	policyToText(policy: Policy): PolicyToTextAnswer;
	/** Cedar text or JSON template -> canonical `PolicyJson` (with slots). */
	templateToJson(template: Template): PolicyToJsonAnswer;
	/** Canonical template `PolicyJson` -> Cedar text. Rejects a static policy. */
	templateToText(template: Template): PolicyToTextAnswer;
	/** Cedar `SchemaJson` -> human-readable schema text. Docs and debugging only. */
	schemaToText(schema: Schema): SchemaToTextAnswer;
	/** Parse-checks a schema without registering it. */
	checkParseSchema(schema: Schema): CheckParseAnswer;
	/** Runs the Cedar policy formatter over policy text. */
	formatPolicies(call: FormattingCall): FormattingAnswer;
	/** Cedar language version, e.g. `"4.5"`. Asserted to start with `4.` on load. */
	getCedarLangVersion(): string;
}

// ---------------------------------------------------------------------------
// Cedar type re-exports
//
// Consumers (and the ORM drivers) must be able to name Cedar's own shapes
// without adding `@cedar-policy/cedar-wasm` to their own dependency list.
// ---------------------------------------------------------------------------

export type {
	// requests + answers
	AuthorizationAnswer,
	AuthorizationCall,
	AuthorizationError,
	CheckParseAnswer,
	Decision,
	Diagnostics,
	FormattingAnswer,
	FormattingCall,
	PartialAuthorizationAnswer,
	PartialAuthorizationCall,
	PolicyToJsonAnswer,
	PolicyToTextAnswer,
	ResidualResponse,
	Response,
	SchemaToTextAnswer,
	StatefulAuthorizationCall,
	ValidationAnswer,
	ValidationCall,
	ValidationError,
	ValidationSettings,
	// diagnostics
	DetailedError,
	Severity,
	SourceLabel,
	SourceLocation,
	// entities + values
	CedarValueJson,
	Context,
	Entities,
	EntityJson,
	EntityUid,
	EntityUidJson,
	FnAndArgs,
	TypeAndId,
	// policies
	ActionConstraint,
	Annotations,
	Clause,
	Effect,
	Expr,
	ExprNoExt,
	ExtFuncCall,
	PatternElem,
	Policy,
	PolicyId,
	PolicyJson,
	PolicySet,
	PrincipalConstraint,
	ResourceConstraint,
	StaticPolicySet,
	Template,
	TemplateLink,
	Var,
	// schema
	ActionEntityUID,
	ActionType,
	ApplySpec,
	AttributesOrContext,
	EntityType,
	NamespaceDefinition,
	RecordType,
	Schema,
	SchemaJson,
	StandardEntityType,
	Type,
	TypeOfAttribute,
	TypeVariant,
} from "@cedar-policy/cedar-wasm/nodejs";
