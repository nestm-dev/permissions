import { describe, expect, it } from "vitest";

import * as barrel from "../../src/index.ts";
import * as planEntry from "../../src/plan.ts";
import * as testingEntry from "../../src/testing.ts";
import * as vocabularyEntry from "../../src/vocabulary.ts";

/**
 * The full runtime surface of `@nestm/permissions-core`.
 *
 * Kept as an explicit list so an accidental export shows up as a failing test
 * rather than as an API commitment nobody reviewed. Type-only exports are
 * invisible here by construction.
 */
const EXPECTED_EXPORTS = [
	"ACTION_ENTITY_TYPE",
	"CedarVersionError",
	"CompositePolicyStore",
	"DEFAULT_ENTITY_CACHE_MAX_ENTRIES",
	"DEFAULT_ENTITY_CACHE_TTL_MS",
	"DEFAULT_INSTANCE_ID_PREFIX",
	"DEFAULT_MAX_POST_FILTER_ROWS",
	"DEFAULT_MAX_SCOPES",
	"DEFAULT_PLAN_CACHE_MAX",
	"DEFAULT_PLAN_CACHE_TTL_MS",
	"DEFAULT_SCHEMA_NAME_PREFIX",
	"DEFAULT_STALE_AFTER_MS",
	"EXPR_FALSE",
	"EXPR_TRUE",
	"EntityCache",
	"ErroredPolicyError",
	"GLOBAL_POLICY_SCOPE",
	"LruCache",
	"MemoryPolicyStore",
	"NAMESPACE_SEPARATOR",
	"PACKAGE_NAME",
	"PLAN_FALSE",
	"PLAN_TRUE",
	"PSET_ID_SEPARATOR",
	"PermissionsEngine",
	"PermissionsError",
	"PlanCache",
	"PolicySetCache",
	"PostFilterOverflowError",
	"REDACTED_VALUE",
	"SHORT_HASH_LENGTH",
	"SUPPORTED_CEDAR_MAJOR",
	"SchemaCache",
	"SchemaValidationError",
	"SingleFlight",
	"TEMPLATE_SLOT_IDS",
	"UnsupportedResidualError",
	"__cedarLoaded",
	"__resetCedarLoader",
	"actionEntityTypeOf",
	"actionUid",
	"approximationDirection",
	"assertDefined",
	"assertNever",
	"assertOrderable",
	"assertValidVocabularyDef",
	"assertVocabularyValid",
	"attrSpecToCedarType",
	"attrSpecToTypeOfAttribute",
	"attrsToCedarRecordType",
	"buildPolicySet",
	"canonicalEntityGraph",
	"cedarErrorsOf",
	"clauseToExpr",
	"clausesToExpr",
	"compileResiduals",
	"composePolicyVersion",
	"containsUnknown",
	"createEngine",
	"createPostFilter",
	"defineVocabulary",
	"emitDecision",
	"entity",
	"entityGraph",
	"entityRef",
	"entityRefToUid",
	"entityTypeNamesOf",
	"entityUidEquals",
	"entityUidToRef",
	"erroredPolicyApproximation",
	"erroredPolicyDirection",
	"escapeCedarString",
	"fail",
	"flattenConjuncts",
	"flattenDisjuncts",
	"flipPolarity",
	"formatAttrPath",
	"formatDetailedErrors",
	"formatEntityRef",
	"formatEntityUid",
	"formatLikePattern",
	"formatPlanNode",
	"formatPlanValue",
	"formatPolicyText",
	"generateInstanceId",
	"invariant",
	"isActionGroupDef",
	"isBooleanLiteral",
	"isCedarFailure",
	"isGlobalScope",
	"isOptionalAttr",
	"isPermissionsError",
	"isReadOnlyPolicyStore",
	"isTemplateJson",
	"isTemplateSlotId",
	"likeTokensToPattern",
	"loadCedar",
	"normalizeEntityUid",
	"normalizeExpr",
	"parseCedarDateTime",
	"parseCedarDuration",
	"parseEntityUid",
	"parsePolicyText",
	"parsePolicyVersion",
	"planAnd",
	"planCacheKey",
	"planNot",
	"planOr",
	"planValueKindOf",
	"policyKindOf",
	"policyRecordFromText",
	"qualifyEntityType",
	"readOnlyPolicyStore",
	"redactContextKeys",
	"renderPolicyText",
	"renderVocabularySchemaText",
	"resolveEngineOptions",
	"resolveUnsupportedResidual",
	"schemaHash",
	"schemaOf",
	"sha256Hex",
	"shortHash",
	"simplifyPlanNode",
	"stableHash",
	"stableStringify",
	"t",
	"templateSlotsOf",
	"templateToJsonRecord",
	"throwCedarFailure",
	"toCedarSchemaJson",
	"toCedarValue",
	"translateExpr",
	"tryPlanValue",
	"tryTranslate",
	"unescapeCedarString",
	"unknownVarOf",
	"unqualifyEntityType",
	"unwrapAuthorization",
	"unwrapCheckParse",
	"unwrapFormatting",
	"unwrapPartialAuthorization",
	"unwrapPolicyToJson",
	"unwrapPolicyToText",
	"unwrapSchemaToText",
	"unwrapValidation",
	"validateVocabulary",
	"viewExpr",
	"walkPlanNode",
];

describe("barrel exports", () => {
	it("exports PACKAGE_NAME", () => {
		expect(barrel.PACKAGE_NAME).toBe("@nestm/permissions-core");
	});

	it("exports exactly the declared surface", () => {
		expect(Object.keys(barrel).toSorted()).toEqual(EXPECTED_EXPORTS.toSorted());
	});

	it("does not touch the Cedar WASM at import time", () => {
		expect(barrel.__cedarLoaded()).toBe(false);
	});
});

describe("subpath entries", () => {
	it("exposes ./testing", () => {
		expect(testingEntry.TESTING_ENTRY_NAME).toBe("@nestm/permissions-core/testing");
	});

	it("exposes ./plan", () => {
		expect(planEntry.PLAN_ENTRY_NAME).toBe("@nestm/permissions-core/plan");
	});

	it("exposes ./vocabulary", () => {
		expect(vocabularyEntry.VOCABULARY_ENTRY_NAME).toBe("@nestm/permissions-core/vocabulary");
	});

	it("re-exports the barrel's own bindings, not copies of them", () => {
		// The subpaths re-export; they do not re-implement. A second copy of
		// `defineVocabulary` would be a second brand, and every value crossing
		// between an application that imports `./vocabulary` and a library that
		// imports the barrel would stop typechecking.
		expect(vocabularyEntry.defineVocabulary).toBe(barrel.defineVocabulary);
		expect(vocabularyEntry.t).toBe(barrel.t);
		expect(vocabularyEntry.entity).toBe(barrel.entity);
		expect(vocabularyEntry.entityGraph).toBe(barrel.entityGraph);
		expect(vocabularyEntry.entityRef).toBe(barrel.entityRef);
		expect(vocabularyEntry.toCedarSchemaJson).toBe(barrel.toCedarSchemaJson);
	});

	it("keeps ./vocabulary and ./plan disjoint apart from their entry markers", () => {
		// Two entries exporting the same runtime binding is how a bundler ends up
		// with both graphs in a consumer that wanted one.
		const shared = Object.keys(vocabularyEntry).filter((name) => name in planEntry);
		expect(shared).toEqual([]);
	});
});
