import { beforeAll, describe, expect, it } from "vitest";

import type { CedarBinding, Entities, SchemaJson } from "../../src/cedar/binding.ts";
import { unwrapAuthorization } from "../../src/cedar/answers.ts";
import { SUPPORTED_CEDAR_MAJOR, __cedarLoaded, loadCedar } from "../../src/cedar/loader.ts";
import { t } from "../../src/vocabulary/attr.ts";
import { defineVocabulary } from "../../src/vocabulary/define-vocabulary.ts";
import {
	assertVocabularyValid,
	renderVocabularySchemaText,
	validateVocabulary,
} from "../../src/vocabulary/validate-vocabulary.ts";
import { stationVocabulary } from "../fixtures/station-vocabulary.ts";

let cedar: CedarBinding;

beforeAll(async () => {
	cedar = await loadCedar();
});

describe("loadCedar", () => {
	it("resolves a binding with every method the engine uses", () => {
		for (const method of [
			"isAuthorized",
			"statefulIsAuthorized",
			"isAuthorizedPartial",
			"preparsePolicySet",
			"preparseSchema",
			"validate",
			"policyToJson",
			"policyToText",
			"templateToJson",
			"schemaToText",
			"checkParseSchema",
			"formatPolicies",
			"getCedarLangVersion",
		] as const) {
			expect(typeof cedar[method]).toBe("function");
		}
	});

	it("reports a supported Cedar language version", () => {
		expect(cedar.getCedarLangVersion()).toMatch(new RegExp(`^${SUPPORTED_CEDAR_MAJOR}\\.`));
	});

	it("memoises the binding", async () => {
		expect(__cedarLoaded()).toBe(true);
		expect(await loadCedar()).toBe(cedar);
	});

	it("registers itself on globalThis exactly once", () => {
		const registration = (globalThis as unknown as Record<symbol, { copies: number } | undefined>)[
			Symbol.for("@nestm/permissions-core/instance")
		];

		expect(registration?.copies).toBe(1);
	});
});

describe("generated schema against real Cedar", () => {
	it("parses", () => {
		expect(cedar.checkParseSchema(stationVocabulary.cedarSchemaJson)).toEqual({
			type: "success",
		});
	});

	it("renders as Cedar schema text with the group membership intact", () => {
		const text = stationVocabulary.toCedarSchemaText(cedar);

		expect(text).toContain("namespace Station {");
		expect(text).toContain("entity Run in [Project]");
		expect(text).toContain('action "run:*";');
		expect(text).toContain('action "run:dispatch" in [Action::"run:*"]');
		expect(text).toContain("mfa?:");
		expect(text).toContain("startedAt?:");
	});

	it("renders the same text through the async convenience", async () => {
		await expect(renderVocabularySchemaText(stationVocabulary)).resolves.toBe(
			stationVocabulary.toCedarSchemaText(cedar),
		);
	});

	it("registers with preparseSchema", () => {
		expect(cedar.preparseSchema("station-test", stationVocabulary.cedarSchemaJson)).toEqual({
			type: "success",
		});
	});
});

describe("validateVocabulary", () => {
	it("returns ok for a well-formed vocabulary", async () => {
		await expect(validateVocabulary(stationVocabulary, cedar)).resolves.toEqual({ ok: true });
	});

	it("loads Cedar itself when no binding is passed", async () => {
		await expect(validateVocabulary(stationVocabulary)).resolves.toEqual({ ok: true });
	});

	it("returns Cedar's DetailedError[] for a broken schema", async () => {
		// Structurally valid JSON that only Cedar can reject: `Nope` is undeclared.
		const broken: SchemaJson<string> = {
			Broken: {
				entityTypes: { Run: { memberOfTypes: ["Nope"] } },
				actions: {},
			},
		};

		const result = await validateVocabulary(broken, cedar);

		expect(result.ok).toBe(false);
		if (result.ok) {
			throw new Error("unreachable");
		}
		expect(result.errors).not.toHaveLength(0);
		expect(result.errors[0]?.message).toContain("Nope");
		expect(result.errors[0]).toHaveProperty("help");
		expect(result.errors[0]).toHaveProperty("sourceLocations");
	});

	it("rejects an undeclared action group only at the Cedar layer", async () => {
		// `defineVocabulary` catches this structurally, so the only way to reach
		// Cedar's own diagnostic is to hand it the raw schema.
		const result = await validateVocabulary(
			{
				Broken: {
					entityTypes: { Run: {} },
					actions: {
						"run:read": {
							memberOf: [{ id: "run:*" }],
							appliesTo: { principalTypes: ["Run"], resourceTypes: ["Run"] },
						},
					},
				},
			},
			cedar,
		);

		expect(result.ok).toBe(false);
	});

	it("assertVocabularyValid throws a SchemaValidationError carrying the diagnostics", async () => {
		await expect(
			assertVocabularyValid(
				{ Broken: { entityTypes: { Run: { memberOfTypes: ["Nope"] } }, actions: {} } },
				cedar,
			),
		).rejects.toMatchObject({
			name: "SchemaValidationError",
			code: "SCHEMA_INVALID",
			details: expect.arrayContaining([expect.objectContaining({ message: expect.any(String) })]),
		});
	});

	it("assertVocabularyValid resolves for the station vocabulary", async () => {
		await expect(assertVocabularyValid(stationVocabulary, cedar)).resolves.toBeUndefined();
	});
});

describe("isAuthorized smoke test", () => {
	const uid = stationVocabulary.entityUid.bind(stationVocabulary);

	const entities: Entities = [
		{ uid: uid({ type: "Organization", id: "o1" }), attrs: {}, parents: [] },
		{
			uid: uid({ type: "Member", id: "m1" }),
			attrs: {
				organization: { __entity: { type: "Station::Organization", id: "o1" } },
				identitySubject: "auth0|abc",
			},
			parents: [uid({ type: "Organization", id: "o1" })],
		},
		{
			uid: uid({ type: "Project", id: "p1" }),
			attrs: {
				organization: { __entity: { type: "Station::Organization", id: "o1" } },
				archived: false,
			},
			parents: [uid({ type: "Organization", id: "o1" })],
		},
		{
			uid: uid({ type: "Run", id: "r1" }),
			attrs: {
				project: { __entity: { type: "Station::Project", id: "p1" } },
				status: "queued",
				createdBy: { __entity: { type: "Station::Member", id: "m1" } },
				attempt: 1,
				labels: ["nightly"],
				trigger: { kind: "manual" },
			},
			parents: [uid({ type: "Project", id: "p1" })],
		},
	];

	function authorize(policies: Record<string, string>) {
		return unwrapAuthorization(
			cedar.isAuthorized({
				principal: uid({ type: "Member", id: "m1" }),
				action: stationVocabulary.actionUid("run:dispatch"),
				resource: uid({ type: "Run", id: "r1" }),
				context: { reason: "manual" },
				schema: stationVocabulary.cedarSchemaJson,
				validateRequest: true,
				policies: { staticPolicies: policies },
				entities,
			}),
			{ code: "EVALUATION_FAILED", message: "authorization failed" },
		);
	}

	it("allows on a matching permit", () => {
		const response = authorize({
			p1: `permit(
				principal in Station::Organization::"o1",
				action == Station::Action::"run:dispatch",
				resource
			) when { resource.status == "queued" };`,
		});

		expect(response.decision).toBe("allow");
		expect(response.diagnostics.reason).toEqual(["p1"]);
		expect(response.diagnostics.errors).toEqual([]);
	});

	it("denies by default when nothing permits", () => {
		const response = authorize({});

		expect(response.decision).toBe("deny");
		expect(response.diagnostics.reason).toEqual([]);
	});

	it("lets a forbid override a permit", () => {
		const response = authorize({
			p1: `permit(principal, action == Station::Action::"run:dispatch", resource);`,
			f1: `forbid(principal, action == Station::Action::"run:dispatch", resource)
				when { resource.status == "queued" };`,
		});

		expect(response.decision).toBe("deny");
		expect(response.diagnostics.reason).toEqual(["f1"]);
	});

	it("honours an action group in a policy", () => {
		const response = authorize({
			p1: `permit(principal, action in Station::Action::"run:*", resource);`,
		});

		expect(response.decision).toBe("allow");
		expect(stationVocabulary.actionsInGroup("run:*")).toContain("run:dispatch");
	});
});

describe("schema validation of policies", () => {
	it("accepts a policy that matches the vocabulary", () => {
		const answer = cedar.validate({
			schema: stationVocabulary.cedarSchemaJson,
			policies: {
				staticPolicies: {
					ok: `permit(principal is Station::Member, action == Station::Action::"run:dispatch", resource is Station::Run);`,
				},
			},
		});

		expect(answer.type).toBe("success");
		if (answer.type !== "success") {
			throw new Error("unreachable");
		}
		expect(answer.validationErrors).toEqual([]);
	});

	it("flags a policy pairing an action with the wrong resource type", () => {
		const answer = cedar.validate({
			schema: stationVocabulary.cedarSchemaJson,
			policies: {
				staticPolicies: {
					bad: `permit(principal is Station::Member, action == Station::Action::"run:dispatch", resource is Station::Project);`,
				},
			},
		});

		expect(answer.type).toBe("success");
		if (answer.type !== "success") {
			throw new Error("unreachable");
		}
		expect(answer.validationErrors).not.toHaveLength(0);
	});
});

describe("a vocabulary built at runtime", () => {
	it("survives the Cedar round-trip", async () => {
		const vocabulary = defineVocabulary({
			namespace: "Acme::Billing",
			entities: {
				Tenant: {},
				Invoice: { memberOf: ["Tenant"], attrs: { total: t.long(), tenant: t.ref("Tenant") } },
			},
			actions: {
				"invoice:*": {},
				"invoice:read": { memberOf: ["invoice:*"], principal: ["Tenant"], resource: ["Invoice"] },
			},
		});

		await expect(validateVocabulary(vocabulary, cedar)).resolves.toEqual({ ok: true });
		expect(vocabulary.toCedarSchemaText(cedar)).toContain("namespace Acme::Billing {");
	});
});
