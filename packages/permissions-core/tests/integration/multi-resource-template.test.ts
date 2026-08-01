// One template, many resource types — the station role-template shape.
//
// A station role is ONE Cedar template that names every action the role grants,
// even though those actions declare *different* resource types in the schema:
//
//   permit(principal == ?principal,
//          action in [Station::Action::"project:manage",
//                     Station::Action::"run:read",
//                     Station::Action::"run:dispatch"],
//          resource in ?resource);
//
// `project:manage` declares `resource: Project`; the two `run:*` actions declare
// `resource: Run`. These tests pin what Cedar 4.12 actually does with that.

import { afterEach, beforeAll, describe, expect, it } from "vitest";

import type { CedarBinding } from "../../src/cedar/binding.ts";
import { loadCedar } from "../../src/cedar/loader.ts";
import { entity } from "../../src/entities/entity-builder.ts";
import type { EntityGraph, EntityProvider } from "../../src/entities/entity-provider.ts";
import { PermissionsEngine, createEngine } from "../../src/engine.ts";
import { MemoryPolicyStore } from "../../src/policy/memory-policy-store.ts";
import { policyRecordFromText } from "../../src/policy/policy-codec.ts";
import { buildPolicySet } from "../../src/policy/policy-set-builder.ts";
import type { PolicyRecord, TemplateLinkRecord } from "../../src/policy/policy-store.ts";
import { defineVocabulary } from "../../src/vocabulary/define-vocabulary.ts";
import { stationVocabulary, type StationVocabulary } from "../fixtures/station-vocabulary.ts";

const TENANT = "org:1";
const FIXED_TIME = new Date("2026-07-30T00:00:00.000Z");

/** Actions spanning two declared resource types: `Project` and `Run`. */
const MULTI_TYPE_ACTIONS =
	`[Station::Action::"project:manage", ` +
	`Station::Action::"run:read", ` +
	`Station::Action::"run:dispatch"]`;

const ROLE_IN = `permit(principal == ?principal, action in ${MULTI_TYPE_ACTIONS}, resource in ?resource);`;
const ROLE_UNCONSTRAINED = `permit(principal == ?principal, action in ${MULTI_TYPE_ACTIONS}, resource);`;
const ROLE_EQ = `permit(principal == ?principal, action in ${MULTI_TYPE_ACTIONS}, resource == ?resource);`;

/** Split per resource type — the alternative shape. */
const ROLE_SPLIT_PROJECT = `permit(principal == ?principal, action in [Station::Action::"project:manage"], resource in ?resource);`;
const ROLE_SPLIT_RUN = `permit(principal == ?principal, action in [Station::Action::"run:read", Station::Action::"run:dispatch"], resource in ?resource);`;

/** Five resource types x five verbs = the 25-action role template station would write. */
const RESOURCE_TYPES = ["Organization", "Project", "Run", "Secret", "Webhook"] as const;
const VERBS = ["read", "create", "update", "delete", "manage"] as const;

/** A `when` clause over an attribute only one of the resource types declares. */
const ROLE_WITH_WHEN = `permit(principal == ?principal, action in ${MULTI_TYPE_ACTIONS}, resource in ?resource) when { resource.status == "queued" };`;

// --------------------------------------------------------------------------
// Entities: Run -> Project -> Organization, so Run::"r1" in Organization::"o1".
// --------------------------------------------------------------------------

const organization = entity(stationVocabulary, "Organization", "o1", { attrs: {} });

const project = entity(stationVocabulary, "Project", "p1", {
	attrs: { organization: { type: "Organization", id: "o1" }, archived: false },
	parents: [{ type: "Organization", id: "o1" }],
});

const member = entity(stationVocabulary, "Member", "m1", {
	attrs: { organization: { type: "Organization", id: "o1" }, identitySubject: "sub-m1" },
	parents: [{ type: "Organization", id: "o1" }],
});

const run = entity(stationVocabulary, "Run", "r1", {
	attrs: {
		project: { type: "Project", id: "p1" },
		status: "queued",
		createdBy: { type: "Member", id: "m1" },
		attempt: 1,
		labels: [],
		trigger: { kind: "manual" },
	},
	parents: [{ type: "Project", id: "p1" }],
});

const provider: EntityProvider<StationVocabulary> = {
	async resolvePrincipal(): Promise<EntityGraph> {
		return [member, organization];
	},
	async resolveResource(request): Promise<EntityGraph> {
		const ref = request.resource;
		if (ref === undefined) {
			return [];
		}
		if (ref.type === "Run") {
			return [run, project, organization];
		}
		if (ref.type === "Project") {
			return [project, organization];
		}
		return [organization];
	},
};

// --------------------------------------------------------------------------
// Harness
// --------------------------------------------------------------------------

let cedar: CedarBinding;
let instanceCounter = 0;
const engines: PermissionsEngine<StationVocabulary>[] = [];

beforeAll(async () => {
	cedar = await loadCedar();
});

afterEach(async () => {
	while (engines.length > 0) {
		await engines.pop()?.dispose();
	}
});

function template(id: string, text: string): PolicyRecord {
	return policyRecordFromText(cedar, { id, scope: TENANT, text, updatedAt: FIXED_TIME });
}

function grant(
	id: string,
	templateId: string,
	resource: { readonly type: string; readonly id: string },
): TemplateLinkRecord {
	return {
		id,
		scope: TENANT,
		templateId,
		values: { "?principal": { type: "Member", id: "m1" }, "?resource": resource },
		updatedAt: FIXED_TIME,
	};
}

/** Runs Cedar's validator over one template (no links), exactly as the engine would. */
function validateTemplate(text: string, links: readonly TemplateLinkRecord[] = []) {
	const set = buildPolicySet(
		{
			scope: TENANT,
			version: "g1:s1",
			policies: [template("role:member", text)],
			links,
		},
		{ namespace: stationVocabulary.namespace },
	);
	return cedar.validate({ schema: stationVocabulary.cedarSchemaJson, policies: set });
}

async function makeEngine(
	store: MemoryPolicyStore,
	overrides: { validateOnLoad?: boolean; validateRequests?: boolean } = {},
): Promise<PermissionsEngine<StationVocabulary>> {
	instanceCounter += 1;
	const engine = await createEngine<StationVocabulary>({
		vocabulary: stationVocabulary,
		policyStore: store,
		entityProvider: provider,
		instanceId: `multi-type-${String(instanceCounter)}`,
		cedar,
		...overrides,
	});
	engines.push(engine);
	return engine;
}

// --------------------------------------------------------------------------

describe("validator: one template, many declared resource types", () => {
	it("accepts `resource in ?resource` with no errors and no warnings", () => {
		expect(validateTemplate(ROLE_IN)).toStrictEqual({
			type: "success",
			validationErrors: [],
			validationWarnings: [],
			otherWarnings: [],
		});
	});

	it("accepts an unconstrained `resource` scope", () => {
		expect(validateTemplate(ROLE_UNCONSTRAINED)).toMatchObject({
			type: "success",
			validationErrors: [],
			validationWarnings: [],
		});
	});

	it("accepts `resource == ?resource`", () => {
		expect(validateTemplate(ROLE_EQ)).toMatchObject({
			type: "success",
			validationErrors: [],
			validationWarnings: [],
		});
	});

	it("rejects a `when` clause over an attribute only one resource type declares", () => {
		const answer = validateTemplate(ROLE_WITH_WHEN);

		// The scope is permissive, but the *condition* is typechecked against the
		// union of every named action's resource type — so `resource.status` is an
		// error on `Project`, which has no `status`.
		expect(answer).toMatchObject({ type: "success" });
		expect(answer.type === "success" && answer.validationErrors).toMatchObject([
			{
				policyId: "role:member",
				error: {
					message:
						"for policy `role:member`, attribute `status` on entity type `Station::Project` not found",
					help: "did you mean `archived`?",
				},
			},
		]);
	});

	it("rejects a link whose slots make every named action unreachable", () => {
		// `Member` is never a declared resource, so no action in the list applies.
		const answer = validateTemplate(ROLE_IN, [
			grant("grant:bad", "role:member", { type: "Member", id: "m2" }),
		]);

		expect(answer.type === "success" && answer.validationErrors).toMatchObject([
			{
				policyId: "grant:bad",
				error: {
					message:
						"for policy `grant:bad`, unable to find an applicable action given the policy scope constraints",
				},
			},
		]);
	});

	it("accepts 25 actions across 5 declared resource types — station's real scale", () => {
		// The fixture vocabulary has 3 actions over 2 types, which proves the
		// mechanism but not the size. Station's largest role names ~25 actions whose
		// declared resource types differ, and "does it still validate at that width"
		// is the question the migration's one-template-per-role design turns on.
		const wide = defineVocabulary({
			namespace: "Wide",
			entities: {
				Organization: {},
				Member: { memberOf: ["Organization"], attrs: {} },
				Project: { memberOf: ["Organization"], attrs: {} },
				Run: { memberOf: ["Project"], attrs: {} },
				Secret: { memberOf: ["Project"], attrs: {} },
				Webhook: { memberOf: ["Organization"], attrs: {} },
			},
			actions: Object.fromEntries(
				RESOURCE_TYPES.flatMap((type) =>
					VERBS.map((verb) => [
						`${type.toLowerCase()}:${verb}`,
						{ principal: ["Member"], resource: [type] },
					]),
				),
			),
		});

		const names = RESOURCE_TYPES.flatMap((type) =>
			VERBS.map((verb) => `Wide::Action::"${type.toLowerCase()}:${verb}"`),
		);
		expect(names).toHaveLength(25);

		const set = buildPolicySet(
			{
				scope: TENANT,
				version: "g1:s1",
				policies: [
					policyRecordFromText(cedar, {
						id: "role:admin",
						scope: TENANT,
						text: `permit(principal == ?principal, action in [${names.join(", ")}], resource in ?resource);`,
						updatedAt: FIXED_TIME,
					}),
				],
				links: [
					{
						id: "grant:wide",
						scope: TENANT,
						templateId: "role:admin",
						values: {
							"?principal": { type: "Member", id: "m1" },
							"?resource": { type: "Organization", id: "o1" },
						},
						updatedAt: FIXED_TIME,
					},
				],
			},
			{ namespace: wide.namespace },
		);

		// Clean: no errors, no warnings, at 25 actions over 5 resource types, with a
		// link whose `?resource` type is none of them.
		expect(cedar.validate({ schema: wide.cedarSchemaJson, policies: set })).toStrictEqual({
			type: "success",
			validationErrors: [],
			validationWarnings: [],
			otherWarnings: [],
		});
	});

	it("accepts a link that makes only *some* named actions reachable", () => {
		// `?resource = Run::"r1"`: `project:manage` can never apply (a Project is
		// never `in` a Run), but the two `run:*` actions can — and one reachable
		// action is enough for the validator.
		expect(
			validateTemplate(ROLE_IN, [grant("grant:run", "role:member", { type: "Run", id: "r1" })]),
		).toMatchObject({ type: "success", validationErrors: [] });
	});
});

describe("authorization: links to a multi-resource-type template", () => {
	for (const validateRequests of [false, true]) {
		it(`allows every named action under the linked ancestor (validateRequests: ${String(validateRequests)})`, async () => {
			const store = new MemoryPolicyStore({
				policies: [template("role:member", ROLE_IN)],
				// One link, scoped at the Organization — an ancestor of both Project
				// and Run, though `Organization` is not a declared resource type for
				// *any* of the named actions.
				links: [grant("grant:m1-o1", "role:member", { type: "Organization", id: "o1" })],
			});
			const engine = await makeEngine(store, { validateOnLoad: true, validateRequests });

			// `run:dispatch` declares `resource: Run`, and the link's `?resource` is an
			// `Organization` — Cedar resolves `Run::"r1" in Organization::"o1"` through
			// the entity graph and allows.
			expect(
				await engine.check({
					scope: TENANT,
					principal: { type: "Member", id: "m1" },
					action: "run:dispatch",
					resource: { type: "Run", id: "r1" },
					context: { reason: "manual" },
				}),
			).toMatchObject({ allowed: true, determiningPolicyIds: ["grant:m1-o1"], policyErrors: [] });

			// ...and so does the action whose declared type is `Project`.
			expect(
				await engine.check({
					scope: TENANT,
					principal: { type: "Member", id: "m1" },
					action: "project:manage",
					resource: { type: "Project", id: "p1" },
				}),
			).toMatchObject({ allowed: true, determiningPolicyIds: ["grant:m1-o1"], policyErrors: [] });

			await expect(engine.validatePolicies(TENANT)).resolves.toMatchObject({
				ok: true,
				errors: [],
				warnings: [],
			});
		});
	}

	it("denies a resource outside the linked ancestor", async () => {
		const store = new MemoryPolicyStore({
			policies: [template("role:member", ROLE_IN)],
			// Linked at the Run, so `project:manage` on `Project::"p1"` cannot match:
			// a Project is never `in` a Run.
			links: [grant("grant:m1-r1", "role:member", { type: "Run", id: "r1" })],
		});
		const engine = await makeEngine(store, { validateOnLoad: true, validateRequests: true });

		expect(
			await engine.check({
				scope: TENANT,
				principal: { type: "Member", id: "m1" },
				action: "run:read",
				resource: { type: "Run", id: "r1" },
			}),
		).toMatchObject({ allowed: true, determiningPolicyIds: ["grant:m1-r1"] });

		expect(
			await engine.check({
				scope: TENANT,
				principal: { type: "Member", id: "m1" },
				action: "project:manage",
				resource: { type: "Project", id: "p1" },
			}),
		).toMatchObject({ allowed: false, determiningPolicyIds: [] });
	});

	it("`resource == ?resource` matches only the linked entity itself", async () => {
		const store = new MemoryPolicyStore({
			policies: [template("role:member", ROLE_EQ)],
			links: [grant("grant:m1-r1", "role:member", { type: "Run", id: "r1" })],
		});
		const engine = await makeEngine(store, { validateOnLoad: true, validateRequests: true });

		expect(
			await engine.check({
				scope: TENANT,
				principal: { type: "Member", id: "m1" },
				action: "run:read",
				resource: { type: "Run", id: "r1" },
			}),
		).toMatchObject({ allowed: true, determiningPolicyIds: ["grant:m1-r1"] });

		// No ancestor walk with `==`, so the Project-typed action can never match.
		expect(
			await engine.check({
				scope: TENANT,
				principal: { type: "Member", id: "m1" },
				action: "project:manage",
				resource: { type: "Project", id: "p1" },
			}),
		).toMatchObject({ allowed: false, determiningPolicyIds: [] });
	});

	it("behaves identically when the template is split per resource type", async () => {
		const store = new MemoryPolicyStore({
			policies: [
				template("role:member-project", ROLE_SPLIT_PROJECT),
				template("role:member-run", ROLE_SPLIT_RUN),
			],
			// Two links instead of one — same Organization scope.
			links: [
				grant("grant:project", "role:member-project", { type: "Organization", id: "o1" }),
				grant("grant:run", "role:member-run", { type: "Organization", id: "o1" }),
			],
		});
		const engine = await makeEngine(store, { validateOnLoad: true, validateRequests: true });

		expect(
			await engine.check({
				scope: TENANT,
				principal: { type: "Member", id: "m1" },
				action: "run:dispatch",
				resource: { type: "Run", id: "r1" },
				context: { reason: "manual" },
			}),
			// Only the determining policy id differs from the single-template case.
		).toMatchObject({ allowed: true, determiningPolicyIds: ["grant:run"], policyErrors: [] });

		expect(
			await engine.check({
				scope: TENANT,
				principal: { type: "Member", id: "m1" },
				action: "project:manage",
				resource: { type: "Project", id: "p1" },
			}),
		).toMatchObject({ allowed: true, determiningPolicyIds: ["grant:project"], policyErrors: [] });
	});
});

describe("validateRequests is the only guard against a mistyped action/resource pair", () => {
	it("allows a schema-invalid pairing when validateRequests is off", async () => {
		const store = new MemoryPolicyStore({
			policies: [template("role:member", ROLE_IN)],
			links: [grant("grant:m1-o1", "role:member", { type: "Organization", id: "o1" })],
		});
		const engine = await makeEngine(store, { validateOnLoad: true, validateRequests: false });

		// `project:manage` declares `resource: Project`. A `Run` is not a Project —
		// but it *is* `in Organization::"o1"`, so the permissive scope matches and
		// Cedar allows. `check()` would not compile; `checkUnsafe()` does.
		expect(
			await engine.checkUnsafe({
				scope: TENANT,
				principal: { type: "Member", id: "m1" },
				action: "project:manage",
				resource: { type: "Run", id: "r1" },
			}),
		).toMatchObject({ allowed: true, determiningPolicyIds: ["grant:m1-o1"] });
	});

	it("throws on the same pairing when validateRequests is on", async () => {
		const store = new MemoryPolicyStore({
			policies: [template("role:member", ROLE_IN)],
			links: [grant("grant:m1-o1", "role:member", { type: "Organization", id: "o1" })],
		});
		const engine = await makeEngine(store, { validateOnLoad: true, validateRequests: true });

		await expect(
			engine.checkUnsafe({
				scope: TENANT,
				principal: { type: "Member", id: "m1" },
				action: "project:manage",
				resource: { type: "Run", id: "r1" },
			}),
		).rejects.toThrow(
			'resource type `Station::Run` is not valid for `Station::Action::"project:manage"`',
		);
	});
});
