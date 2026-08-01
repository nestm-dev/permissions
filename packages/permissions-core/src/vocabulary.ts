// `@nestm/permissions-core/vocabulary` — the schema-authoring surface, alone.
//
// Everything reachable from this entry is **pure TypeScript**. Importing it must
// never reach the Cedar WASM, the engine, or the policy-store SPI;
// `tests/unit/vocabulary-entry.test.ts` asserts that with the same
// `__cedarLoaded()` probe `./plan` uses.
//
// Why it exists. A vocabulary is the one artefact an application shares with
// everything that talks about its permissions: the API that enforces them, the
// admin UI that edits them, a code generator, a documentation build, a test
// fixture. Most of those consumers never authorize anything — and before this
// entry, `import { defineVocabulary } from "@nestm/permissions-core"` handed them
// the engine, the plan compiler, the policy-store SPI and a module graph whose
// only reason for existing is a 4.1 MiB WASM binary. `./plan` (D5) drew this
// exact line for the ORM drivers; this is the same line, on the other side.
//
// What is deliberately **not** here: `validateVocabulary`,
// `assertVocabularyValid`, `schemaOf` and `renderVocabularySchemaText`. Every one
// of them asks *Cedar* whether a schema is valid, and `validate-vocabulary.ts`
// imports `loadCedar` to say so — the WASM is the whole point of those functions,
// so they stay on the main barrel where the cost is expected. `defineVocabulary`
// itself is pure by design (plan delta D3): the builder does no eager
// `checkParseSchema`, and Cedar validation happens on demand and at engine
// creation.

/** Entry identity. Exported so the built entry has real runtime output. */
export const VOCABULARY_ENTRY_NAME = "@nestm/permissions-core/vocabulary" as const;

// ---------------------------------------------------------------------------
// The builder
// ---------------------------------------------------------------------------

export { assertValidVocabularyDef, defineVocabulary } from "./vocabulary/define-vocabulary.ts";

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

// ---------------------------------------------------------------------------
// Cedar schema JSON — pure, so a code generator or a docs build can have it
// ---------------------------------------------------------------------------

export {
	actionEntityTypeOf,
	attrSpecToCedarType,
	attrSpecToTypeOfAttribute,
	attrsToCedarRecordType,
	entityTypeNamesOf,
	isActionGroupDef,
	toCedarSchemaJson,
} from "./vocabulary/to-cedar-schema.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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
// Entities
// ---------------------------------------------------------------------------

// The other half of "talking about permissions without enforcing them": an
// entity graph is what a fixture, a seeding script or a test builds, and
// `entity()` is where the vocabulary's types actually pay off.
export { entity, entityGraph, toCedarValue } from "./entities/entity-builder.ts";
export type { EntityInit, ToCedarValueOptions } from "./entities/entity-builder.ts";
export type { EntityGraph } from "./entities/entity-provider.ts";

// ---------------------------------------------------------------------------
// UID helpers
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
