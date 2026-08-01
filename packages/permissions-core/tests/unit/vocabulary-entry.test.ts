import { describe, expect, it } from "vitest";

/**
 * The `@nestm/permissions-core/vocabulary` subpath.
 *
 * This file runs in its own vitest module graph — nothing here imports
 * `src/index.ts` — which is what makes the `__cedarLoaded()` probe below
 * meaningful. A vocabulary is the artefact an application shares with everything
 * that *talks about* its permissions (an admin UI, a code generator, a docs
 * build, a fixture) rather than enforcing them, and a WASM edge here would put
 * 4.1 MiB into every one of those consumers' bundles.
 *
 * Mirrors `plan-entry.test.ts`, which draws the same line for the ORM drivers.
 */

/** Everything the subpath publishes at runtime. Type-only exports are invisible here. */
const EXPECTED_VOCABULARY_EXPORTS = [
	"VOCABULARY_ENTRY_NAME",
	// builder
	"assertValidVocabularyDef",
	"defineVocabulary",
	"isOptionalAttr",
	"t",
	// Cedar schema JSON (pure)
	"actionEntityTypeOf",
	"attrSpecToCedarType",
	"attrSpecToTypeOfAttribute",
	"attrsToCedarRecordType",
	"entityTypeNamesOf",
	"isActionGroupDef",
	"toCedarSchemaJson",
	// entities
	"entity",
	"entityGraph",
	"toCedarValue",
	// uid helpers
	"ACTION_ENTITY_TYPE",
	"NAMESPACE_SEPARATOR",
	"actionUid",
	"entityRef",
	"entityRefToUid",
	"entityUidEquals",
	"entityUidToRef",
	"escapeCedarString",
	"formatEntityRef",
	"formatEntityUid",
	"normalizeEntityUid",
	"parseEntityUid",
	"qualifyEntityType",
	"unescapeCedarString",
	"unqualifyEntityType",
];

describe("@nestm/permissions-core/vocabulary", () => {
	it("exports exactly the declared surface", async () => {
		const entry = await import("../../src/vocabulary.ts");

		expect(Object.keys(entry).toSorted()).toEqual(EXPECTED_VOCABULARY_EXPORTS.toSorted());
		expect(entry.VOCABULARY_ENTRY_NAME).toBe("@nestm/permissions-core/vocabulary");
	});

	it("does not load the Cedar WASM", async () => {
		const { defineVocabulary, t, entity, entityGraph } = await import("../../src/vocabulary.ts");

		// Not just imported — *used*. `defineVocabulary` is pure by design (plan
		// delta D3: no eager `checkParseSchema`), and building a vocabulary and an
		// entity graph is the whole reason a consumer reaches for this entry.
		const vocabulary = defineVocabulary({
			namespace: "Docs",
			entities: {
				Org: {},
				Doc: { memberOf: ["Org"], attrs: { title: t.string(), archived: t.bool() } },
				User: { memberOf: ["Org"], attrs: {} },
			},
			actions: { "doc:read": { principal: ["User"], resource: ["Doc"] } },
		});
		entityGraph(
			entity(vocabulary, "Doc", "d1", {
				attrs: { title: "t", archived: false },
				parents: [{ type: "Org", id: "o1" }],
			}),
			entity(vocabulary, "Org", "o1", { attrs: {} }),
		);

		// Reaching for the loader *after* the subpath has been imported and
		// exercised: if it had pulled in the engine, this would already be `true`.
		const { __cedarLoaded } = await import("../../src/cedar/loader.ts");

		expect(__cedarLoaded()).toBe(false);
	});

	it("omits the validators, which are the WASM-touching half by definition", async () => {
		const entry: Record<string, unknown> = await import("../../src/vocabulary.ts");

		// `validateVocabulary`/`assertVocabularyValid`/`schemaOf`/
		// `renderVocabularySchemaText` all ask Cedar whether a schema is valid;
		// `validate-vocabulary.ts` imports `loadCedar` to do it. They stay on the
		// main barrel, where the cost is expected.
		for (const name of [
			"validateVocabulary",
			"assertVocabularyValid",
			"schemaOf",
			"renderVocabularySchemaText",
		]) {
			expect(entry[name], name).toBeUndefined();
		}
	});

	it("omits the engine, the policy store and the plan compiler", async () => {
		const entry: Record<string, unknown> = await import("../../src/vocabulary.ts");

		for (const name of [
			"createEngine",
			"PermissionsEngine",
			"MemoryPolicyStore",
			"CompositePolicyStore",
			"loadCedar",
			"planToSql",
			"buildPolicySet",
		]) {
			expect(entry[name], name).toBeUndefined();
		}
	});
});
