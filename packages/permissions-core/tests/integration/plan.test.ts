import { afterEach, beforeAll, describe, expect, it } from "vitest";

import type { CedarBinding } from "../../src/cedar/binding.ts";
import { loadCedar } from "../../src/cedar/loader.ts";
import { entity } from "../../src/entities/entity-builder.ts";
import type { EntityGraph, EntityProvider } from "../../src/entities/entity-provider.ts";
import { PermissionsEngine, createEngine } from "../../src/engine.ts";
import type { EngineOptions } from "../../src/engine.options.ts";
import { MemoryPolicyStore } from "../../src/policy/memory-policy-store.ts";
import { policyRecordFromText } from "../../src/policy/policy-codec.ts";
import type { PolicyRecord, TemplateLinkRecord } from "../../src/policy/policy-store.ts";
import type { AttrPath, PlanNode, QueryPlan } from "../../src/plan/plan.ts";
import { stationVocabulary, type StationVocabulary } from "../fixtures/station-vocabulary.ts";

/**
 * The heart of slice 4a: every row of the pushdown table driven through **real**
 * cedar-wasm partial evaluation and asserted as an exact `PlanNode` tree.
 *
 * Structural equality, not `toMatchObject`: the whole value of this suite is
 * that a Cedar upgrade which reshapes a residual fails here rather than silently
 * changing which rows a driver selects.
 */

const TENANT = "org:1";
const FIXED_TIME = new Date("2026-07-30T00:00:00.000Z");

// --------------------------------------------------------------------------
// Entities — principal side only. The resource is the unknown.
// --------------------------------------------------------------------------

const organization = entity(stationVocabulary, "Organization", "o1", { attrs: {} });
const adminRole = entity(stationVocabulary, "Role", "admin", { attrs: {} });

function member(id: string, roles: readonly string[]): ReturnType<typeof entity> {
	return entity(stationVocabulary, "Member", id, {
		attrs: { organization: { type: "Organization", id: "o1" }, identitySubject: `sub-${id}` },
		parents: [
			...roles.map((role) => ({ type: "Role", id: role })),
			{ type: "Organization", id: "o1" },
		],
	});
}

const MEMBERS: Readonly<Record<string, readonly string[]>> = { m1: [], m2: ["admin"] };

function makeProvider(): EntityProvider<StationVocabulary> {
	return {
		async resolvePrincipal(request): Promise<EntityGraph> {
			const roles = MEMBERS[request.principal.id] ?? [];
			return [
				member(request.principal.id, roles),
				...(roles.includes("admin") ? [adminRole] : []),
				organization,
			];
		},
		async resolveResource(request): Promise<EntityGraph> {
			// Only reachable from the post-filter path, where a concrete run exists.
			const reference = request.resource;
			if (reference === undefined || reference.type !== "Run") {
				return [];
			}
			return [
				entity(stationVocabulary, "Run", reference.id, {
					attrs: {
						project: { type: "Project", id: "p1" },
						status: reference.id === "r1" ? "queued" : "archived",
						createdBy: { type: "Member", id: "m1" },
						attempt: 1,
						labels: ["nightly"],
						startedAt: FIXED_TIME,
						trigger: { kind: "manual" },
					},
					parents: [{ type: "Project", id: "p1" }],
				}),
				entity(stationVocabulary, "Project", "p1", {
					attrs: { organization: { type: "Organization", id: "o1" }, archived: false },
					parents: [{ type: "Organization", id: "o1" }],
				}),
				organization,
			];
		},
	};
}

// --------------------------------------------------------------------------
// Harness
// --------------------------------------------------------------------------

let cedar: CedarBinding;
let instanceCounter = 0;
const engines: PermissionsEngine<StationVocabulary>[] = [];

const READ = 'action == Station::Action::"run:read"';

function policy(id: string, text: string, scope: string = TENANT): PolicyRecord {
	return policyRecordFromText(cedar, { id, scope, text, updatedAt: FIXED_TIME });
}

/** One permit whose condition is `when { <condition> }`, and nothing else. */
function onePermit(condition: string): PolicyRecord {
	return policy("p:under-test", `permit(principal, ${READ}, resource) when { ${condition} };`);
}

async function makeEngine(
	policies: readonly PolicyRecord[],
	overrides: Partial<EngineOptions<StationVocabulary>> = {},
	links: readonly TemplateLinkRecord[] = [],
): Promise<PermissionsEngine<StationVocabulary>> {
	instanceCounter += 1;
	const engine = await createEngine<StationVocabulary>({
		vocabulary: stationVocabulary,
		policyStore: new MemoryPolicyStore({ policies: [...policies], links: [...links] }),
		entityProvider: makeProvider(),
		instanceId: `plan-it-${String(instanceCounter)}`,
		cedar,
		...overrides,
	});
	engines.push(engine);
	return engine;
}

const planRead = {
	scope: TENANT,
	principal: { type: "Member", id: "m1" },
	action: "run:read",
	resourceType: "Run",
} as const;

/** Plans one policy's condition and returns the compiled tree. */
async function conditionOf(
	condition: string,
	overrides: Partial<EngineOptions<StationVocabulary>> = {},
): Promise<PlanNode> {
	const engine = await makeEngine([onePermit(condition)], overrides);
	const plan = await engine.plan(planRead);

	if (plan.kind !== "CONDITIONAL") {
		throw new Error(`expected a CONDITIONAL plan, got ${plan.kind}`);
	}
	return plan.condition;
}

function attr(name: string): AttrPath {
	return { root: "resource", path: [name] };
}

beforeAll(async () => {
	cedar = await loadCedar();
});

afterEach(async () => {
	while (engines.length > 0) {
		await engines.pop()?.dispose();
	}
});

// --------------------------------------------------------------------------
// Comparison operators
// --------------------------------------------------------------------------

describe("pushdown — comparisons", () => {
	it("== on a string attribute", async () => {
		await expect(conditionOf('resource.status == "done"')).resolves.toEqual({
			op: "cmp",
			cmp: "eq",
			attr: attr("status"),
			value: { kind: "string", value: "done" },
		});
	});

	it("!= arrives as !(==) and is recovered as `ne`", async () => {
		await expect(conditionOf('resource.status != "done"')).resolves.toEqual({
			op: "cmp",
			cmp: "ne",
			attr: attr("status"),
			value: { kind: "string", value: "done" },
		});
	});

	it("< and <= come through directly", async () => {
		await expect(conditionOf("resource.attempt < 5")).resolves.toEqual({
			op: "cmp",
			cmp: "lt",
			attr: attr("attempt"),
			value: { kind: "long", value: 5n },
		});
		await expect(conditionOf("resource.attempt <= 5")).resolves.toEqual({
			op: "cmp",
			cmp: "lte",
			attr: attr("attempt"),
			value: { kind: "long", value: 5n },
		});
	});

	it("> and >= arrive negation-normalised and are recovered", async () => {
		// core.md §0 finding 19: Cedar emits `>` as `!(x <= k)`. Without the
		// pushdown no plan would ever contain `gt`.
		await expect(conditionOf("resource.attempt > 5")).resolves.toEqual({
			op: "cmp",
			cmp: "gt",
			attr: attr("attempt"),
			value: { kind: "long", value: 5n },
		});
		await expect(conditionOf("resource.attempt >= 5")).resolves.toEqual({
			op: "cmp",
			cmp: "gte",
			attr: attr("attempt"),
			value: { kind: "long", value: 5n },
		});
	});

	it("a long is carried as a bigint", async () => {
		const node = await conditionOf("resource.attempt == 42");

		expect(node).toMatchObject({ value: { kind: "long", value: 42n } });
		expect(typeof (node as { value: { value: unknown } }).value.value).toBe("bigint");
	});

	it("a datetime constant becomes a Date, through the guarded optional attribute", async () => {
		// Erratum 7: the `has` guard is mandatory for `validateOnLoad` to accept an
		// optional attribute — and it is exactly the shape that stops a forbid from
		// erroring and vanishing.
		await expect(
			conditionOf('resource has startedAt && resource.startedAt > datetime("2026-01-01")'),
		).resolves.toEqual({
			op: "and",
			nodes: [
				{ op: "exists", attr: attr("startedAt") },
				{
					op: "cmp",
					cmp: "gt",
					attr: attr("startedAt"),
					value: { kind: "datetime", value: new Date("2026-01-01T00:00:00.000Z") },
				},
			],
		});
	});
});

// --------------------------------------------------------------------------
// Hierarchy and type
// --------------------------------------------------------------------------

describe("pushdown — hierarchy and type", () => {
	it("`resource is Run` folds to true against the planned type", async () => {
		const engine = await makeEngine([
			policy(
				"p:typed",
				`permit(principal, ${READ}, resource is Station::Run) when { resource.status == "a" };`,
			),
		]);

		const plan = await engine.plan(planRead);

		expect(plan.kind).toBe("CONDITIONAL");
		expect(plan.kind === "CONDITIONAL" && plan.condition).toEqual({
			op: "cmp",
			cmp: "eq",
			attr: attr("status"),
			value: { kind: "string", value: "a" },
		});
	});

	it("`resource is Project` folds to false, leaving nothing to select", async () => {
		// `validateOnLoad: false` because Cedar's validator already rejects this
		// policy ("unable to find an applicable action given the policy scope
		// constraints") — defence in depth. The point here is that the *compiler*
		// also folds it, which is what protects a scope loaded with the validator off.
		const engine = await makeEngine(
			[policy("p:typed", `permit(principal, ${READ}, resource is Station::Project);`)],
			{ validateOnLoad: false },
		);

		expect((await engine.plan(planRead)).kind).toBe("ALWAYS_DENY");
	});

	it('`resource in Project::"p1"` becomes inHierarchy with a null attr', async () => {
		const engine = await makeEngine([
			policy("p:scoped", `permit(principal, ${READ}, resource in Station::Project::"p1");`),
		]);

		const plan = await engine.plan(planRead);

		expect(plan.kind === "CONDITIONAL" && plan.condition).toEqual({
			op: "inHierarchy",
			attr: null,
			parent: { type: "Project", id: "p1" },
		});
	});

	it("a TEMPLATE LINK produces the same inHierarchy node", async () => {
		// The role-grant primitive: partial evaluation honours template links
		// (core.md §0 finding 22), so a grant compiles to exactly the same filter as
		// the equivalent static policy.
		const engine = await makeEngine(
			[policy("role:reader", `permit(principal == ?principal, ${READ}, resource in ?resource);`)],
			{},
			[
				{
					id: "grant:m1-p1",
					scope: TENANT,
					templateId: "role:reader",
					values: {
						"?principal": { type: "Member", id: "m1" },
						"?resource": { type: "Project", id: "p1" },
					},
					updatedAt: FIXED_TIME,
				},
			],
		);

		const plan = await engine.plan(planRead);

		expect(plan.kind === "CONDITIONAL" && plan.condition).toEqual({
			op: "inHierarchy",
			attr: null,
			parent: { type: "Project", id: "p1" },
		});
		expect(plan.diagnostics.residualPolicyIds).toEqual(["grant:m1-p1"]);
	});

	it("an attribute-rooted `in` carries the attribute", async () => {
		// Cedar does accept `in` over an entity-typed attribute; verified live.
		await expect(conditionOf('resource.project in Station::Project::"p1"')).resolves.toEqual({
			op: "inHierarchy",
			attr: attr("project"),
			parent: { type: "Project", id: "p1" },
		});
	});

	it("an entity constant loses the namespace qualification", async () => {
		await expect(conditionOf('resource.createdBy == Station::Member::"m1"')).resolves.toEqual({
			op: "cmp",
			cmp: "eq",
			attr: attr("createdBy"),
			// Vocabulary-local, matching `EntityRef` everywhere else in the package.
			value: { kind: "entity", value: { type: "Member", id: "m1" } },
		});
	});
});

// --------------------------------------------------------------------------
// Sets, patterns, presence
// --------------------------------------------------------------------------

describe("pushdown — sets, patterns and presence", () => {
	it("a set literal containing the attribute becomes `in`", async () => {
		await expect(conditionOf('["queued", "running"].contains(resource.status)')).resolves.toEqual({
			op: "in",
			attr: attr("status"),
			values: [
				{ kind: "string", value: "queued" },
				{ kind: "string", value: "running" },
			],
		});
	});

	it("a set-valued attribute containing a constant becomes `contains`", async () => {
		await expect(conditionOf('resource.labels.contains("nightly")')).resolves.toEqual({
			op: "contains",
			attr: attr("labels"),
			value: { kind: "string", value: "nightly" },
		});
	});

	it("`like` carries TOKENS, with literal %/_/* preserved", async () => {
		// Re-serialising these to a string is how a literal `%` in a policy becomes
		// a wildcard in SQL. The escaped `\*` must arrive as a *literal* asterisk.
		await expect(conditionOf('resource.status like "a\\*b*_%c"')).resolves.toEqual({
			op: "like",
			attr: attr("status"),
			pattern: [
				{ literal: "a" },
				{ literal: "*" },
				{ literal: "b" },
				{ wildcard: true },
				{ literal: "_" },
				{ literal: "%" },
				{ literal: "c" },
			],
		});
	});

	it("`has` becomes exists", async () => {
		await expect(conditionOf("resource has startedAt")).resolves.toEqual({
			op: "exists",
			attr: attr("startedAt"),
		});
	});

	it("`isEmpty` on a set-valued attribute", async () => {
		await expect(conditionOf("resource.labels.isEmpty()")).resolves.toEqual({
			op: "isEmpty",
			attr: attr("labels"),
		});
	});
});

// --------------------------------------------------------------------------
// Boolean structure
// --------------------------------------------------------------------------

describe("pushdown — boolean structure", () => {
	it("flattens a conjunction into an n-ary and", async () => {
		await expect(
			conditionOf('resource.status == "a" && resource.attempt < 3 && resource.labels.isEmpty()'),
		).resolves.toEqual({
			op: "and",
			nodes: [
				{ op: "cmp", cmp: "eq", attr: attr("status"), value: { kind: "string", value: "a" } },
				{ op: "cmp", cmp: "lt", attr: attr("attempt"), value: { kind: "long", value: 3n } },
				{ op: "isEmpty", attr: attr("labels") },
			],
		});
	});

	it("preserves an or nested inside an and", async () => {
		await expect(
			conditionOf('(resource.status == "a" || resource.status == "b") && resource.attempt < 3'),
		).resolves.toEqual({
			op: "and",
			nodes: [
				{
					op: "or",
					nodes: [
						{ op: "cmp", cmp: "eq", attr: attr("status"), value: { kind: "string", value: "a" } },
						{ op: "cmp", cmp: "eq", attr: attr("status"), value: { kind: "string", value: "b" } },
					],
				},
				{ op: "cmp", cmp: "lt", attr: attr("attempt"), value: { kind: "long", value: 3n } },
			],
		});
	});

	it("rewrites if-then-else as or(and(if, then), and(!if, else))", async () => {
		await expect(
			conditionOf(
				'if resource.attempt == 1 then resource.status == "a" else resource.status == "b"',
			),
		).resolves.toEqual({
			op: "or",
			nodes: [
				{
					op: "and",
					nodes: [
						{ op: "cmp", cmp: "eq", attr: attr("attempt"), value: { kind: "long", value: 1n } },
						{ op: "cmp", cmp: "eq", attr: attr("status"), value: { kind: "string", value: "a" } },
					],
				},
				{
					op: "and",
					nodes: [
						// `!(attempt == 1)` is pushed through to `attempt != 1`.
						{ op: "cmp", cmp: "ne", attr: attr("attempt"), value: { kind: "long", value: 1n } },
						{ op: "cmp", cmp: "eq", attr: attr("status"), value: { kind: "string", value: "b" } },
					],
				},
			],
		});
	});

	it("an `unless` clause becomes a negation", async () => {
		const engine = await makeEngine([
			policy(
				"p:unless",
				`permit(principal, ${READ}, resource) unless { resource.status == "secret" };`,
			),
		]);

		const plan = await engine.plan(planRead);

		expect(plan.kind === "CONDITIONAL" && plan.condition).toEqual({
			op: "cmp",
			cmp: "ne",
			attr: attr("status"),
			value: { kind: "string", value: "secret" },
		});
	});

	it("assembles OR(permits) AND NOT(OR(forbids))", async () => {
		const engine = await makeEngine([
			policy("p:a", `permit(principal, ${READ}, resource) when { resource.status == "a" };`),
			policy("p:b", `permit(principal, ${READ}, resource) when { resource.status == "b" };`),
			policy("f:x", `forbid(principal, ${READ}, resource) when { resource.labels.contains("x") };`),
		]);

		const plan = await engine.plan(planRead);

		expect(plan.kind === "CONDITIONAL" && plan.condition).toEqual({
			op: "and",
			nodes: [
				{
					op: "or",
					nodes: [
						{ op: "cmp", cmp: "eq", attr: attr("status"), value: { kind: "string", value: "a" } },
						{ op: "cmp", cmp: "eq", attr: attr("status"), value: { kind: "string", value: "b" } },
					],
				},
				{
					op: "not",
					node: { op: "contains", attr: attr("labels"), value: { kind: "string", value: "x" } },
				},
			],
		});
	});
});

// --------------------------------------------------------------------------
// Context folding and the determined states
// --------------------------------------------------------------------------

describe("context folding and determined plans", () => {
	const DISPATCH = 'action == Station::Action::"run:dispatch"';

	const planDispatch = {
		scope: TENANT,
		principal: { type: "Member", id: "m1" },
		action: "run:dispatch",
		resourceType: "Run",
	} as const;

	it("folds a satisfied context condition away entirely", async () => {
		const engine = await makeEngine([
			policy(
				"p:ctx",
				`permit(principal, ${DISPATCH}, resource) when { context.reason == "oncall" && resource.status == "queued" };`,
			),
		]);

		const plan = await engine.plan({ ...planDispatch, context: { reason: "oncall" } });

		expect(plan.kind === "CONDITIONAL" && plan.condition).toEqual({
			op: "cmp",
			cmp: "eq",
			attr: attr("status"),
			value: { kind: "string", value: "queued" },
		});
	});

	it("folds an unsatisfied context condition to ALWAYS_DENY", async () => {
		const engine = await makeEngine([
			policy(
				"p:ctx",
				`permit(principal, ${DISPATCH}, resource) when { context.reason == "oncall" && resource.status == "queued" };`,
			),
		]);

		const plan = await engine.plan({ ...planDispatch, context: { reason: "curiosity" } });

		expect(plan.kind).toBe("ALWAYS_DENY");
		expect(plan.diagnostics.residualPolicyIds).toEqual([]);
	});

	it("re-derives ALWAYS_ALLOW when the only residual is a satisfied type test", async () => {
		// Cedar leaves `resource is Run` as a residual — it cannot know the type of
		// an unknown — so `decision` is null and the compiler has to fold the type
		// test against the planned type itself. This is §5.3 step 6 doing real work,
		// not belt-and-braces.
		const engine = await makeEngine([
			policy(
				"p:admin",
				`permit(principal in Station::Role::"admin", ${READ}, resource is Station::Run);`,
			),
		]);

		const plan = await engine.plan({ ...planRead, principal: { type: "Member", id: "m2" } });

		expect(plan.kind).toBe("ALWAYS_ALLOW");
		expect(plan.diagnostics.residualPolicyIds).toEqual(["p:admin"]);
		expect(plan.approximations).toEqual([]);
	});

	it("takes ALWAYS_ALLOW straight from Cedar when nothing is left unknown", async () => {
		const engine = await makeEngine([
			policy("p:admin", `permit(principal in Station::Role::"admin", ${READ}, resource);`),
		]);

		const plan = await engine.plan({ ...planRead, principal: { type: "Member", id: "m2" } });

		expect(plan.kind).toBe("ALWAYS_ALLOW");
		// The determined case: `nontrivialResiduals` is empty and the three states
		// come from `decision` directly (core.md §0 finding 18).
		expect(plan.diagnostics.residualPolicyIds).toEqual([]);
	});

	it("returns ALWAYS_DENY for a principal no policy reaches", async () => {
		const engine = await makeEngine([
			policy(
				"p:admin",
				`permit(principal in Station::Role::"admin", ${READ}, resource is Station::Run);`,
			),
		]);

		const plan = await engine.plan(planRead);

		expect(plan.kind).toBe("ALWAYS_DENY");
		expect(plan.diagnostics.residualPolicyIds).toEqual([]);
	});

	it("folds a principal attribute into a constant", async () => {
		// This is why the plan cache keys on the whole entity graph and not just on
		// ancestor uids: `principal.organization` becomes a literal in the filter.
		await expect(conditionOf("resource.project in principal.organization")).resolves.toEqual({
			op: "inHierarchy",
			attr: attr("project"),
			parent: { type: "Organization", id: "o1" },
		});
	});
});

// --------------------------------------------------------------------------
// The fail-closed contract
// --------------------------------------------------------------------------

describe("fail-closed contract", () => {
	const NESTED = 'resource.trigger.kind == "manual"';

	it("throws UNSUPPORTED_RESIDUAL for an untranslatable permit, naming the expression", async () => {
		const engine = await makeEngine([onePermit(NESTED)]);

		let thrown: unknown;
		try {
			await engine.plan(planRead);
		} catch (error) {
			thrown = error;
		}

		expect(thrown).toMatchObject({
			code: "UNSUPPORTED_RESIDUAL",
			policyId: "p:under-test",
			effect: "permit",
			reason: "nested-attribute",
			resourceType: "Run",
			action: "run:read",
			scope: TENANT,
		});
		// The **innermost** offending sub-expression, verbatim: `resource.trigger.kind`,
		// not the whole comparison. Pointing at the nested access is what tells an
		// operator which part of the policy to rewrite.
		expect((thrown as { expr: unknown }).expr).toEqual({
			".": {
				left: { ".": { left: { unknown: [{ Value: "resource" }] }, attr: "trigger" } },
				attr: "kind",
			},
		});
	});

	it("approximates an untranslatable forbid restrictively, with a warning", async () => {
		const engine = await makeEngine([
			policy("p:ok", `permit(principal, ${READ}, resource) when { resource.status == "a" };`),
			policy("f:nested", `forbid(principal, ${READ}, resource) when { ${NESTED} };`),
		]);

		const plan = await engine.plan(planRead);

		// The forbid widened to `true`; `NOT(true)` blocks every row. Over-blocking,
		// never over-sharing.
		expect(plan.kind).toBe("ALWAYS_DENY");
		expect(plan.approximations).toEqual([
			expect.objectContaining({
				policyId: "f:nested",
				effect: "forbid",
				direction: "restrictive",
				reason: "nested-attribute",
			}),
		]);
		expect(plan.diagnostics.explain()).toContain("! restrictive:");
	});

	it("widens and post-filters when asked, and the post-filter agrees with check()", async () => {
		const engine = await makeEngine([onePermit(NESTED)], { unsupportedResidual: "post-filter" });

		const plan = await engine.plan(planRead);

		expect(plan.kind).toBe("CONDITIONAL");
		expect(plan.approximations[0]).toMatchObject({ direction: "permissive" });

		const postFilter = plan.kind === "CONDITIONAL" ? plan.postFilter : undefined;
		const rows = [{ id: "r1" }, { id: "r2" }];
		const kept = await postFilter?.(rows, {
			rowToResource: (row) => ({ type: "Run", id: row.id }),
		});

		// Both fixture runs have `trigger.kind == "manual"`, so both survive — and
		// the answer is Cedar's own, row by row.
		expect(kept).toEqual(rows);
		for (const row of rows) {
			expect(
				(
					await engine.check({
						scope: TENANT,
						principal: { type: "Member", id: "m1" },
						action: "run:read",
						resource: { type: "Run", id: row.id },
					})
				).allowed,
			).toBe(true);
		}
	});

	it("caps the post-filter rather than melting the database", async () => {
		const engine = await makeEngine([onePermit(NESTED)], {
			unsupportedResidual: "post-filter",
			maxPostFilterRows: 1,
		});

		const plan = await engine.plan(planRead);
		const postFilter = plan.kind === "CONDITIONAL" ? plan.postFilter : undefined;

		await expect(
			postFilter?.([{ id: "r1" }, { id: "r2" }], {
				rowToResource: (row) => ({ type: "Run", id: row.id }),
			}),
		).rejects.toMatchObject({ code: "POST_FILTER_OVERFLOW" });
	});

	it.each([
		["arithmetic", "resource.attempt + 1 == 5", "arithmetic"],
		["containsAll", 'resource.labels.containsAll(["a"])', "unsupported-operator"],
		["containsAny", 'resource.labels.containsAny(["a"])', "unsupported-operator"],
		["a record literal", 'resource.trigger == { kind: "manual" }', "unsupported-value"],
		["unknown on both sides", "resource.status == resource.trigger.kind", "nested-attribute"],
		["row identity", 'resource == Station::Run::"r1"', "entity-identity"],
	])("refuses %s in a permit", async (_label, condition, reason) => {
		// `validateOnLoad: false` because some of these are also type errors; the
		// point here is the *plan compiler's* refusal, not the validator's.
		const engine = await makeEngine([onePermit(condition)], { validateOnLoad: false });

		await expect(engine.plan(planRead)).rejects.toMatchObject({
			code: "UNSUPPORTED_RESIDUAL",
			reason,
		});
	});
});

// --------------------------------------------------------------------------
// Errored policies — the sharpest edge
// --------------------------------------------------------------------------

describe("errored policies", () => {
	/**
	 * An unguarded optional attribute on the **known** side.
	 *
	 * Erratum 7: `validateOnLoad` (default on) refuses this shape precisely
	 * because it is what makes a forbid error and vanish — so constructing the
	 * case requires turning the validator off deliberately.
	 */
	const UNGUARDED_FORBID = `forbid(principal, action == Station::Action::"run:dispatch", resource) when { context.mfa == false };`;

	const planDispatch = {
		scope: TENANT,
		principal: { type: "Member", id: "m1" },
		action: "run:dispatch",
		resourceType: "Run",
		context: { reason: "oncall" },
	} as const;

	async function erroredEngine(
		overrides: Partial<EngineOptions<StationVocabulary>> = {},
	): Promise<PermissionsEngine<StationVocabulary>> {
		return makeEngine(
			[
				policy(
					"p:dispatch",
					`permit(principal, action == Station::Action::"run:dispatch", resource) when { resource.status == "queued" };`,
				),
				policy("f:mfa", UNGUARDED_FORBID),
			],
			{ validateOnLoad: false, ...overrides },
		);
	}

	it("throws ERRORED_POLICY by default", async () => {
		const engine = await erroredEngine();

		let thrown: unknown;
		try {
			await engine.plan(planDispatch);
		} catch (error) {
			thrown = error;
		}

		expect(thrown).toMatchObject({ code: "ERRORED_POLICY", policyIds: ["f:mfa"], scope: TENANT });
		expect((thrown as Error).message).toContain("silently disappeared");
	});

	it("returns ALWAYS_DENY under 'deny-all'", async () => {
		const engine = await erroredEngine({ onErroredPolicy: "deny-all" });

		const plan = await engine.plan(planDispatch);

		expect(plan.kind).toBe("ALWAYS_DENY");
		expect(plan.diagnostics.erroredPolicyIds).toEqual(["f:mfa"]);
		expect(plan.approximations[0]).toMatchObject({
			policyId: "f:mfa",
			effect: "forbid",
			direction: "permissive",
			reason: "errored-policy",
		});
	});

	it("compiles without the vanished forbid under 'ignore', and says so", async () => {
		const engine = await erroredEngine({ onErroredPolicy: "ignore" });

		const plan = await engine.plan(planDispatch);

		// The forbid is genuinely gone from the filter. This is the unsafe mode; the
		// approximation is the only trace of it.
		expect(plan.kind === "CONDITIONAL" && plan.condition).toEqual({
			op: "cmp",
			cmp: "eq",
			attr: attr("status"),
			value: { kind: "string", value: "queued" },
		});
		expect(plan.approximations[0]).toMatchObject({ direction: "permissive" });
	});

	it("the guarded form validates and plans cleanly", async () => {
		// The same rule written safely, with `validateOnLoad` left on.
		const engine = await makeEngine([
			policy(
				"p:dispatch",
				`permit(principal, action == Station::Action::"run:dispatch", resource) when { context has mfa && context.mfa == true && resource.status == "queued" };`,
			),
		]);

		const plan = await engine.plan({ ...planDispatch, context: { reason: "r", mfa: true } });

		expect(plan.kind).toBe("CONDITIONAL");
		expect(plan.diagnostics.erroredPolicyIds).toEqual([]);
	});
});

// --------------------------------------------------------------------------
// Caching against the real binding
// --------------------------------------------------------------------------

describe("plan cache", () => {
	it("hits on the second identical call and misses after a policy write", async () => {
		const store = new MemoryPolicyStore({
			policies: [
				policy("p:a", `permit(principal, ${READ}, resource) when { resource.status == "a" };`),
			],
		});
		instanceCounter += 1;
		const engine = await createEngine<StationVocabulary>({
			vocabulary: stationVocabulary,
			policyStore: store,
			entityProvider: makeProvider(),
			instanceId: `plan-it-${String(instanceCounter)}`,
			cedar,
		});
		engines.push(engine);

		const first = await engine.plan(planRead);
		const second = await engine.plan(planRead);

		expect(first.diagnostics.cache).toBe("miss");
		expect(second.diagnostics.cache).toBe("hit");
		expect(second.kind === "CONDITIONAL" && second.condition).toEqual(
			first.kind === "CONDITIONAL" ? first.condition : undefined,
		);

		// The watch event drops the plan; the next call recompiles against the new
		// policy set and produces a different filter.
		await store.save([
			policy("p:a", `permit(principal, ${READ}, resource) when { resource.status == "b" };`),
		]);

		const third = await engine.plan(planRead);

		expect(third.diagnostics.cache).toBe("miss");
		expect(third.kind === "CONDITIONAL" && third.condition).toEqual({
			op: "cmp",
			cmp: "eq",
			attr: attr("status"),
			value: { kind: "string", value: "b" },
		});
		expect(engine.stats().planCache).toMatchObject({ hits: 1, misses: 2 });
	});

	it("does not share a plan between two principals with different graphs", async () => {
		const engine = await makeEngine([onePermit("resource.project in principal.organization")]);

		const forM1 = await engine.plan(planRead);
		const forM2 = await engine.plan({ ...planRead, principal: { type: "Member", id: "m2" } });

		expect(forM1.diagnostics.cache).toBe("miss");
		expect(forM2.diagnostics.cache).toBe("miss");
	});
});

// --------------------------------------------------------------------------
// Shape guarantees
// --------------------------------------------------------------------------

describe("plan shape", () => {
	it("is frozen, carries the resource type on every arm and explains itself", async () => {
		const engine = await makeEngine([onePermit('resource.status == "a"')]);

		const plan: QueryPlan<"Run"> = await engine.plan(planRead);

		expect(Object.isFrozen(plan)).toBe(true);
		expect(plan.resourceType).toBe("Run");
		expect(plan.diagnostics.policySetVersion).toMatch(/^g\d+:s\d+$/);
		expect(plan.diagnostics.durationMs).toBeGreaterThanOrEqual(0);
		expect(plan.diagnostics.explain()).toContain("run:read");
	});

	it("is structurally cloneable once the functions are stripped", async () => {
		const engine = await makeEngine([onePermit('resource.status == "a"')]);
		const plan = await engine.plan(planRead);

		const { diagnostics, ...rest } = plan;
		const plainDiagnostics = {
			residualPolicyIds: diagnostics.residualPolicyIds,
			erroredPolicyIds: diagnostics.erroredPolicyIds,
			policySetVersion: diagnostics.policySetVersion,
			cache: diagnostics.cache,
			durationMs: diagnostics.durationMs,
		};

		expect(() => structuredClone({ ...rest, diagnostics: plainDiagnostics })).not.toThrow();
	});
});
