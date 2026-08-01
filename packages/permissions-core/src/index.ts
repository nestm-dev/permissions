// Public barrel for `@nestm/permissions-core`.
//
// Two invariants this package must never break:
//   1. zero NestJS imports or dependencies — enforced by
//      scripts/assert-core-framework-free.mjs (which greps this very directory
//      for the framework scope, so do not name it here) and by the
//      `core-framework-free` CI job;
//   2. the Cedar WASM import stays lazy (`loadCedar()` is the only reachable
//      `import("@cedar-policy/cedar-wasm/nodejs")`), so the vocabulary builder
//      and the ORM drivers never instantiate it.

/** Package identity. Exported so the built barrel has real runtime output. */
export const PACKAGE_NAME = "@nestm/permissions-core" as const;

// ---------------------------------------------------------------------------
// Cedar binding — the WASM seam
// ---------------------------------------------------------------------------

export type { CedarBinding } from "./cedar/binding.ts";
export {
	loadCedar,
	SUPPORTED_CEDAR_MAJOR,
	__cedarLoaded,
	__resetCedarLoader,
	type CedarInstanceRegistration,
} from "./cedar/loader.ts";

// ---------------------------------------------------------------------------
// Cedar answer narrowing
// ---------------------------------------------------------------------------

export {
	cedarErrorsOf,
	formatDetailedErrors,
	isCedarFailure,
	throwCedarFailure,
	unwrapAuthorization,
	unwrapCheckParse,
	unwrapFormatting,
	unwrapPartialAuthorization,
	unwrapPolicyToJson,
	unwrapPolicyToText,
	unwrapSchemaToText,
	unwrapValidation,
	type AnswerContext,
	type CedarFailureAnswer,
	type CedarValidationReport,
} from "./cedar/answers.ts";

// ---------------------------------------------------------------------------
// Entity references and Cedar UIDs
// ---------------------------------------------------------------------------

export {
	ACTION_ENTITY_TYPE,
	NAMESPACE_SEPARATOR,
	actionUid,
	entityRef,
	entityRefToUid,
	entityUidEquals,
	entityUidToRef,
	escapeCedarString,
	formatEntityRef,
	formatEntityUid,
	normalizeEntityUid,
	parseEntityUid,
	qualifyEntityType,
	unescapeCedarString,
	unqualifyEntityType,
	type EntityRef,
} from "./cedar/uid.ts";

// ---------------------------------------------------------------------------
// Error taxonomy
// ---------------------------------------------------------------------------

export {
	CedarVersionError,
	ErroredPolicyError,
	PermissionsError,
	PostFilterOverflowError,
	SchemaValidationError,
	UnsupportedResidualError,
	isPermissionsError,
	type CedarVersionErrorOptions,
	type ErroredPolicyErrorOptions,
	type PermissionsErrorCode,
	type PermissionsErrorOptions,
	type PostFilterOverflowErrorOptions,
	type SchemaValidationErrorOptions,
	type UnsupportedResidualErrorOptions,
} from "./diagnostics/errors.ts";

// ---------------------------------------------------------------------------
// Audit hook
// ---------------------------------------------------------------------------

export {
	REDACTED_VALUE,
	emitDecision,
	redactContextKeys,
	type CheckDecisionEvent,
	type ContextRedactor,
	type DecisionEvent,
	type DecisionListener,
	type PlanDecisionEvent,
} from "./diagnostics/decision-event.ts";

// ---------------------------------------------------------------------------
// Vocabulary — the typed builder
// ---------------------------------------------------------------------------

export { isOptionalAttr, t } from "./vocabulary/attr.ts";
export type {
	BoolAttr,
	ExtAttr,
	LongAttr,
	OptionalAttr,
	RecordAttr,
	RefAttr,
	SetAttr,
	StringAttr,
} from "./vocabulary/attr.ts";

export { assertValidVocabularyDef, defineVocabulary } from "./vocabulary/define-vocabulary.ts";

export {
	actionEntityTypeOf,
	attrSpecToCedarType,
	attrSpecToTypeOfAttribute,
	attrsToCedarRecordType,
	entityTypeNamesOf,
	isActionGroupDef,
	toCedarSchemaJson,
} from "./vocabulary/to-cedar-schema.ts";

export {
	assertVocabularyValid,
	renderVocabularySchemaText,
	schemaOf,
	validateVocabulary,
	type ValidatableSchema,
	type VocabularyValidationResult,
} from "./vocabulary/validate-vocabulary.ts";

export type {
	ActionDef,
	ActionGroupNameOf,
	ActionGroupOf,
	ActionNameOf,
	ActionOf,
	AnyActionNameOf,
	AnyAttrSpec,
	AnyVocabulary,
	AttrKind,
	AttrSpec,
	AttrSpecRecord,
	AttrValueOf,
	AttrsFor,
	AttrsToObject,
	ContextFor,
	DefOf,
	EmptyContext,
	EntityDef,
	EntityNameOf,
	EntityNameOfDef,
	ExtensionName,
	ExtensionValue,
	ExtensionValueMap,
	PrincipalOf,
	PrincipalTypeFor,
	ResourceOf,
	ResourceTypeFor,
	Simplify,
	Vocabulary,
	VocabularyDef,
} from "./vocabulary/types.ts";

// ---------------------------------------------------------------------------
// Policy store SPI
// ---------------------------------------------------------------------------

export {
	GLOBAL_POLICY_SCOPE,
	TEMPLATE_SLOT_IDS,
	composePolicyVersion,
	isGlobalScope,
	isTemplateSlotId,
	parsePolicyVersion,
	type PolicyBundle,
	type PolicyChangeEvent,
	type PolicyChangeListener,
	type PolicyChangeReason,
	type PolicyKind,
	type PolicyRecord,
	type PolicyScopeId,
	type PolicyStore,
	type TemplateLinkRecord,
	type TemplateSlotId,
	type Unsubscribe,
} from "./policy/policy-store.ts";

export { MemoryPolicyStore, type MemoryPolicyStoreSeed } from "./policy/memory-policy-store.ts";

export {
	CompositePolicyStore,
	type CompositePolicyStoreOptions,
} from "./policy/composite-policy-store.ts";

export {
	isReadOnlyPolicyStore,
	readOnlyPolicyStore,
	type ReadOnlyPolicyStore,
	type ReadOnlyPolicyStoreOptions,
} from "./policy/read-only-policy-store.ts";

// ---------------------------------------------------------------------------
// Policy text <-> JSON
// ---------------------------------------------------------------------------

export {
	formatPolicyText,
	isTemplateJson,
	parsePolicyText,
	policyKindOf,
	policyRecordFromText,
	renderPolicyText,
	templateSlotsOf,
	templateToJsonRecord,
	type FormatPolicyTextOptions,
	type ParsePolicyTextOptions,
	type PolicyRecordFromTextInput,
} from "./policy/policy-codec.ts";

export { buildPolicySet, type BuildPolicySetOptions } from "./policy/policy-set-builder.ts";

// ---------------------------------------------------------------------------
// Runtime caches
// ---------------------------------------------------------------------------

export {
	DEFAULT_MAX_SCOPES,
	DEFAULT_STALE_AFTER_MS,
	PSET_ID_SEPARATOR,
	PolicySetCache,
	type PolicySetCacheOptions,
	type PolicySetCacheStats,
	type PolicySetEntryView,
	type PolicySetHandle,
} from "./runtime/policy-set-cache.ts";

export {
	DEFAULT_SCHEMA_NAME_PREFIX,
	SchemaCache,
	schemaHash,
	type SchemaCacheOptions,
} from "./runtime/schema-cache.ts";

export {
	DEFAULT_PLAN_CACHE_MAX,
	DEFAULT_PLAN_CACHE_TTL_MS,
	PlanCache,
	canonicalEntityGraph,
	planCacheKey,
	type PlanCacheKeyInput,
	type PlanCacheOptions,
	type PlanCacheStats,
} from "./runtime/plan-cache.ts";

// ---------------------------------------------------------------------------
// Query plans
//
// The AST types and pure utilities are *also* published on the
// `@nestm/permissions-core/plan` subpath, which is what a driver imports: that
// entry is loadable without the Cedar WASM, this one is not.
// ---------------------------------------------------------------------------

export type {
	AttrPath,
	AttrRoot,
	LikeToken,
	OnErroredPolicy,
	PlanApproximation,
	PlanApproximationDirection,
	PlanApproximationReason,
	PlanCmp,
	PlanDiagnostics,
	PlanNode,
	PlanValue,
	PlanValueKind,
	PostFilter,
	PostFilterOptions,
	QueryPlan,
	QueryPlanBase,
	UnsupportedResidualContext,
	UnsupportedResidualPolicy,
} from "./plan/plan.ts";

export {
	PLAN_FALSE,
	PLAN_TRUE,
	assertOrderable,
	formatAttrPath,
	formatLikePattern,
	formatPlanNode,
	formatPlanValue,
	likeTokensToPattern,
	planAnd,
	planNot,
	planOr,
	planValueKindOf,
	simplifyPlanNode,
	walkPlanNode,
	type LikePatternOptions,
	type PlanNodeVisitor,
	type PlanNodeVisitorResult,
	type SimplifyOptions,
} from "./plan/plan-node.ts";

export {
	approximationDirection,
	erroredPolicyApproximation,
	erroredPolicyDirection,
	resolveUnsupportedResidual,
	type ResolveUnsupportedInput,
	type UnsupportedResolution,
} from "./plan/approximation.ts";

export {
	compileResiduals,
	type CompileResidualsOptions,
	type CompiledPlan,
} from "./plan/compile-residuals.ts";

export {
	EXPR_FALSE,
	EXPR_TRUE,
	clauseToExpr,
	clausesToExpr,
	containsUnknown,
	flattenConjuncts,
	flattenDisjuncts,
	isBooleanLiteral,
	normalizeExpr,
	unknownVarOf,
	viewExpr,
	type BinaryExprOp,
	type ExprView,
	type UnaryExprOp,
} from "./plan/expr-normalize.ts";

export {
	flipPolarity,
	parseCedarDateTime,
	parseCedarDuration,
	tryPlanValue,
	tryTranslate,
	translateExpr,
	type PlanOutcome,
	type PlanRejection,
	type PlanTarget,
	type PlanTranslation,
	type TranslateOptions,
	type UnsupportedSubterm,
} from "./plan/expr-to-plan.ts";

export {
	DEFAULT_MAX_POST_FILTER_ROWS,
	createPostFilter,
	type CreatePostFilterOptions,
	type PostFilterCheck,
} from "./plan/post-filter.ts";

// ---------------------------------------------------------------------------
// Entity model
// ---------------------------------------------------------------------------

export type {
	EntityGraph,
	EntityProvider,
	EntityResolutionRequest,
} from "./entities/entity-provider.ts";

export { entity, entityGraph, toCedarValue } from "./entities/entity-builder.ts";
export type { EntityInit, ToCedarValueOptions } from "./entities/entity-builder.ts";

export {
	DEFAULT_ENTITY_CACHE_MAX_ENTRIES,
	DEFAULT_ENTITY_CACHE_TTL_MS,
	EntityCache,
	type EntityCacheOptions,
	type EntityCacheStats,
} from "./entities/entity-cache.ts";

// ---------------------------------------------------------------------------
// The engine
// ---------------------------------------------------------------------------

export {
	PermissionsEngine,
	createEngine,
	type CheckRequest,
	type CheckResult,
	type EngineStats,
	type PlanRequest,
	type PolicyEvaluationError,
	type PolicyValidationIssue,
	type PolicyValidationReport,
	type UnsafeCheckRequest,
} from "./engine.ts";

export {
	DEFAULT_INSTANCE_ID_PREFIX,
	generateInstanceId,
	resolveEngineOptions,
	type EngineOptions,
	type EntityCacheTuning,
	type PlanCacheTuning,
	type PolicySetCacheTuning,
	type ResolvedEngineOptions,
} from "./engine.options.ts";

// ---------------------------------------------------------------------------
// Internal utilities
//
// Exported because the ORM driver packages and the NestJS module need the exact
// same LRU/single-flight/hash semantics the engine uses; duplicating them is how
// two caches end up disagreeing about what "stale" means.
// ---------------------------------------------------------------------------

export {
	LruCache,
	type LruCacheOptions,
	type LruEvictionListener,
	type LruEvictionReason,
} from "./util/lru.ts";

export { SingleFlight } from "./util/single-flight.ts";

export {
	SHORT_HASH_LENGTH,
	sha256Hex,
	shortHash,
	stableHash,
	stableStringify,
} from "./util/hash.ts";

export { assertDefined, assertNever, fail, invariant } from "./util/assert.ts";

// ---------------------------------------------------------------------------
// Cedar type re-exports
//
// So consumers can name Cedar's own shapes without depending on
// `@cedar-policy/cedar-wasm` themselves.
// ---------------------------------------------------------------------------

export type {
	ActionConstraint,
	ActionEntityUID,
	ActionType,
	Annotations,
	ApplySpec,
	AttributesOrContext,
	AuthorizationAnswer,
	AuthorizationCall,
	AuthorizationError,
	CedarValueJson,
	CheckParseAnswer,
	Clause,
	Context,
	Decision,
	DetailedError,
	Diagnostics,
	Effect,
	Entities,
	EntityJson,
	EntityType,
	EntityUid,
	EntityUidJson,
	Expr,
	ExprNoExt,
	ExtFuncCall,
	FnAndArgs,
	FormattingAnswer,
	FormattingCall,
	NamespaceDefinition,
	PartialAuthorizationAnswer,
	PartialAuthorizationCall,
	PatternElem,
	Policy,
	PolicyId,
	PolicyJson,
	PolicySet,
	PolicyToJsonAnswer,
	PolicyToTextAnswer,
	PrincipalConstraint,
	RecordType,
	ResidualResponse,
	ResourceConstraint,
	Response,
	Schema,
	SchemaJson,
	SchemaToTextAnswer,
	Severity,
	SourceLabel,
	SourceLocation,
	StandardEntityType,
	StatefulAuthorizationCall,
	StaticPolicySet,
	Template,
	TemplateLink,
	Type,
	TypeAndId,
	TypeOfAttribute,
	TypeVariant,
	ValidationAnswer,
	ValidationCall,
	ValidationError,
	ValidationSettings,
	Var,
} from "./cedar/binding.ts";
