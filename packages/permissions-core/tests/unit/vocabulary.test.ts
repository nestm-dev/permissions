import { describe, expect, it } from "vitest";

import { __cedarLoaded, __resetCedarLoader } from "../../src/cedar/loader.ts";
import { SchemaValidationError } from "../../src/diagnostics/errors.ts";
import { t } from "../../src/vocabulary/attr.ts";
import { defineVocabulary } from "../../src/vocabulary/define-vocabulary.ts";
import { toCedarSchemaJson } from "../../src/vocabulary/to-cedar-schema.ts";
import type { VocabularyDef } from "../../src/vocabulary/types.ts";
import { stationVocabulary } from "../fixtures/station-vocabulary.ts";

/** `defineVocabulary` takes `const D`; the failure fixtures are deliberately not const. */
function build(def: VocabularyDef): unknown {
	return defineVocabulary(def);
}

function expectSchemaError(def: VocabularyDef, match: RegExp): SchemaValidationError {
	let thrown: unknown;
	try {
		build(def);
	} catch (error) {
		thrown = error;
	}

	expect(thrown).toBeInstanceOf(SchemaValidationError);
	const error = thrown as SchemaValidationError;
	expect(error.code).toBe("SCHEMA_INVALID");
	expect(error.message).toMatch(match);
	return error;
}

describe("defineVocabulary — happy path", () => {
	it("exposes the definition and namespace verbatim", () => {
		expect(stationVocabulary.namespace).toBe("Station");
		expect(stationVocabulary.def.actions["run:dispatch"]?.resource).toEqual(["Run"]);
	});

	it("separates requestable actions from action groups", () => {
		expect(stationVocabulary.actionNames).toEqual(["run:dispatch", "run:read", "project:manage"]);
		expect(stationVocabulary.actionGroupNames).toEqual(["run:*"]);
	});

	it("qualifies entity type names with the namespace", () => {
		expect(stationVocabulary.entityTypeNames).toEqual([
			"Station::Organization",
			"Station::Role",
			"Station::Project",
			"Station::Member",
			"Station::Run",
		]);
	});

	it("builds action and entity UIDs", () => {
		expect(stationVocabulary.actionUid("run:dispatch")).toEqual({
			type: "Station::Action",
			id: "run:dispatch",
		});
		expect(stationVocabulary.entityUid({ type: "Run", id: "r1" })).toEqual({
			type: "Station::Run",
			id: "r1",
		});
	});

	it("is frozen", () => {
		expect(Object.isFrozen(stationVocabulary)).toBe(true);
	});

	it("performs no dynamic import of Cedar", () => {
		__resetCedarLoader();
		expect(__cedarLoaded()).toBe(false);

		defineVocabulary({
			namespace: "Probe",
			entities: { Widget: {} },
			actions: { "widget:read": { principal: ["Widget"], resource: ["Widget"] } },
		});

		expect(__cedarLoaded()).toBe(false);
	});
});

describe("defineVocabulary — generated Cedar schema", () => {
	const schema = stationVocabulary.cedarSchemaJson["Station"];

	it("nests everything under the namespace", () => {
		expect(Object.keys(stationVocabulary.cedarSchemaJson)).toEqual(["Station"]);
		expect(schema).toBeDefined();
	});

	it("maps memberOf to memberOfTypes and omits it when empty", () => {
		expect(schema?.entityTypes["Run"]).toMatchObject({ memberOfTypes: ["Project"] });
		expect(schema?.entityTypes["Organization"]).toEqual({});
	});

	it("maps every attribute kind", () => {
		expect(schema?.entityTypes["Run"]).toEqual({
			memberOfTypes: ["Project"],
			shape: {
				type: "Record",
				attributes: {
					project: { type: "Entity", name: "Project" },
					status: { type: "String" },
					createdBy: { type: "Entity", name: "Member" },
					attempt: { type: "Long" },
					labels: { type: "Set", element: { type: "String" } },
					startedAt: { type: "Extension", name: "datetime", required: false },
					trigger: {
						type: "Record",
						attributes: { kind: { type: "String" }, actor: { type: "String", required: false } },
					},
				},
			},
		});
	});

	it("emits appliesTo only for requestable actions", () => {
		expect(schema?.actions["run:dispatch"]?.appliesTo).toEqual({
			principalTypes: ["Member"],
			resourceTypes: ["Run"],
			context: {
				type: "Record",
				attributes: { mfa: { type: "Boolean", required: false }, reason: { type: "String" } },
			},
		});
		expect(schema?.actions["run:read"]?.appliesTo).toEqual({
			principalTypes: ["Member"],
			resourceTypes: ["Run"],
		});
		expect(schema?.actions["run:*"]).toEqual({});
	});

	it("emits group membership as an unqualified action parent", () => {
		expect(schema?.actions["run:dispatch"]?.memberOf).toEqual([{ id: "run:*" }]);
		expect(schema?.actions["project:manage"]?.memberOf).toBeUndefined();
	});

	it("is a pure function of the definition", () => {
		expect(toCedarSchemaJson(stationVocabulary.def)).toEqual(stationVocabulary.cedarSchemaJson);
	});
});

describe("defineVocabulary — action groups", () => {
	const nested = defineVocabulary({
		namespace: "Nested",
		entities: { Widget: {} },
		actions: {
			"widget:*": {},
			"widget:write:*": { memberOf: ["widget:*"] },
			"widget:read": { memberOf: ["widget:*"], principal: ["Widget"], resource: ["Widget"] },
			"widget:create": {
				memberOf: ["widget:write:*"],
				principal: ["Widget"],
				resource: ["Widget"],
			},
			"widget:delete": {
				memberOf: ["widget:write:*"],
				principal: ["Widget"],
				resource: ["Widget"],
			},
			"widget:audit": { principal: ["Widget"], resource: ["Widget"] },
		},
	});

	it("expands a group transitively, in declaration order", () => {
		expect(nested.actionsInGroup("widget:*")).toEqual([
			"widget:read",
			"widget:create",
			"widget:delete",
		]);
		expect(nested.actionsInGroup("widget:write:*")).toEqual(["widget:create", "widget:delete"]);
	});

	it("never returns groups themselves", () => {
		expect(nested.actionsInGroup("widget:*")).not.toContain("widget:write:*");
	});

	it("returns an empty list for a group with no members", () => {
		const lonely = defineVocabulary({
			namespace: "Lonely",
			entities: { Widget: {} },
			actions: { "widget:*": {} },
		});
		expect(lonely.actionsInGroup("widget:*")).toEqual([]);
	});

	it("excludes non-members", () => {
		expect(nested.actionsInGroup("widget:*")).not.toContain("widget:audit");
	});
});

describe("defineVocabulary — structural validation", () => {
	const entities = { Organization: {}, Run: {} } as const;

	it("rejects an empty namespace", () => {
		const error = expectSchemaError(
			{ namespace: "", entities: {}, actions: {} },
			/needs a non-empty namespace/,
		);
		expect(error.path).toBe("namespace");
	});

	it.each([
		["has-a-dash", /not a valid Cedar namespace/],
		["9Station", /not a valid Cedar namespace/],
		["Station::", /not a valid Cedar namespace/],
		["__cedar", /not a valid Cedar namespace/],
		["in", /not a valid Cedar namespace/],
		["Station Two", /not a valid Cedar namespace/],
	] as const)("rejects the namespace %j", (namespace, match) => {
		expectSchemaError({ namespace, entities: {}, actions: {} }, match);
	});

	it("accepts a nested namespace", () => {
		expect(() => build({ namespace: "Acme::Station", entities: {}, actions: {} })).not.toThrow();
	});

	it("rejects a non-identifier entity type name", () => {
		expectSchemaError(
			{ namespace: "S", entities: { "not-an-ident": {} }, actions: {} },
			/is not a valid Cedar identifier/,
		);
	});

	it("rejects the reserved Action entity type", () => {
		expectSchemaError(
			{ namespace: "S", entities: { Action: {} }, actions: {} },
			/"Action" is reserved by Cedar/,
		);
	});

	it("rejects an unknown memberOf target", () => {
		const error = expectSchemaError(
			{ namespace: "S", entities: { Run: { memberOf: ["Projekt"] } }, actions: {} },
			/declares memberOf "Projekt", which is not declared under "entities"/,
		);
		expect(error.path).toBe("entities.Run.memberOf[0]");
	});

	it("rejects a duplicated memberOf target", () => {
		expectSchemaError(
			{
				namespace: "S",
				entities: { Organization: {}, Run: { memberOf: ["Organization", "Organization"] } },
				actions: {},
			},
			/declares memberOf "Organization" twice/,
		);
	});

	it("rejects an unknown t.ref target", () => {
		const error = expectSchemaError(
			{
				namespace: "S",
				entities: { Run: { attrs: { owner: t.ref("Membre") } } },
				actions: {},
			},
			/references entity type "Membre"/,
		);
		expect(error.path).toBe("entities.Run.attrs.owner");
	});

	it("rejects an unknown t.ref target nested in a set", () => {
		expectSchemaError(
			{
				namespace: "S",
				entities: { Run: { attrs: { owners: t.set(t.ref("Membre")) } } },
				actions: {},
			},
			/references entity type "Membre"/,
		);
	});

	it("rejects an unknown t.ref target nested in a record", () => {
		expectSchemaError(
			{
				namespace: "S",
				entities: { Run: { attrs: { meta: t.record({ owner: t.ref("Membre") }) } } },
				actions: {},
			},
			/references entity type "Membre"/,
		);
	});

	it("rejects an unknown principal type", () => {
		expectSchemaError(
			{
				namespace: "S",
				entities,
				actions: { "run:read": { principal: ["Membre"], resource: ["Run"] } },
			},
			/declares principal type "Membre"/,
		);
	});

	it("rejects an unknown resource type", () => {
		expectSchemaError(
			{
				namespace: "S",
				entities,
				actions: { "run:read": { principal: ["Organization"], resource: ["Runn"] } },
			},
			/declares resource type "Runn"/,
		);
	});

	it("rejects a duplicated resource type", () => {
		expectSchemaError(
			{
				namespace: "S",
				entities,
				actions: { "run:read": { principal: ["Organization"], resource: ["Run", "Run"] } },
			},
			/declares resource type "Run" twice/,
		);
	});

	it("rejects an empty principal list", () => {
		expectSchemaError(
			{ namespace: "S", entities, actions: { "run:read": { principal: [], resource: ["Run"] } } },
			/declares an empty principal list/,
		);
	});

	it("rejects a half-declared action (principal without resource)", () => {
		expectSchemaError(
			{ namespace: "S", entities, actions: { "run:read": { principal: ["Organization"] } } },
			/declares principal but not resource/,
		);
	});

	it("rejects a half-declared action (resource without principal)", () => {
		expectSchemaError(
			{ namespace: "S", entities, actions: { "run:read": { resource: ["Run"] } } },
			/declares resource but not principal/,
		);
	});

	it("rejects a context on an action group", () => {
		const error = expectSchemaError(
			{ namespace: "S", entities, actions: { "run:*": { context: { mfa: t.bool() } } } },
			/action group "run:\*" declares a context/,
		);
		expect(error.path).toBe("actions.run:*.context");
	});

	it("rejects an unknown memberOf group", () => {
		expectSchemaError(
			{
				namespace: "S",
				entities,
				actions: {
					"run:read": { memberOf: ["run:*"], principal: ["Organization"], resource: ["Run"] },
				},
			},
			/declares memberOf "run:\*", which is not declared under "actions"/,
		);
	});

	it("rejects memberOf pointing at a requestable action", () => {
		expectSchemaError(
			{
				namespace: "S",
				entities,
				actions: {
					"run:read": { principal: ["Organization"], resource: ["Run"] },
					"run:write": {
						memberOf: ["run:read"],
						principal: ["Organization"],
						resource: ["Run"],
					},
				},
			},
			/is a requestable action, not an action group/,
		);
	});

	it("rejects self-membership", () => {
		expectSchemaError(
			{ namespace: "S", entities, actions: { "run:*": { memberOf: ["run:*"] } } },
			/declares itself as its own group/,
		);
	});

	it("rejects a group cycle", () => {
		expectSchemaError(
			{
				namespace: "S",
				entities,
				actions: { "a:*": { memberOf: ["b:*"] }, "b:*": { memberOf: ["a:*"] } },
			},
			/action group cycle/,
		);
	});

	it("rejects a duplicated memberOf group", () => {
		expectSchemaError(
			{
				namespace: "S",
				entities,
				actions: {
					"run:*": {},
					"run:read": {
						memberOf: ["run:*", "run:*"],
						principal: ["Organization"],
						resource: ["Run"],
					},
				},
			},
			/declares memberOf "run:\*" twice/,
		);
	});

	it("rejects an empty action id", () => {
		expectSchemaError(
			{
				namespace: "S",
				entities,
				actions: { "": { principal: ["Organization"], resource: ["Run"] } },
			},
			/action ids cannot be empty/,
		);
	});

	it("accepts action ids Cedar allows but identifiers do not", () => {
		expect(() =>
			build({
				namespace: "S",
				entities,
				actions: { "run:dispatch now!": { principal: ["Organization"], resource: ["Run"] } },
			}),
		).not.toThrow();
	});

	it("allows self-referential entity hierarchies", () => {
		expect(() =>
			build({ namespace: "S", entities: { Group: { memberOf: ["Group"] } }, actions: {} }),
		).not.toThrow();
	});

	it("tags the namespace on every error", () => {
		const error = expectSchemaError(
			{ namespace: "Station", entities: { Run: { memberOf: ["Nope"] } }, actions: {} },
			/^Station: /,
		);
		expect(error.namespace).toBe("Station");
	});
});
