import { describe, expect, it, vi } from "vitest";

import type { Expr, PolicyJson, ResidualResponse } from "../../src/cedar/binding.ts";
import { ErroredPolicyError, UnsupportedResidualError } from "../../src/diagnostics/errors.ts";
import {
	compileResiduals,
	type CompileResidualsOptions,
} from "../../src/plan/compile-residuals.ts";
import { PLAN_FALSE, PLAN_TRUE } from "../../src/plan/plan-node.ts";
import type { AttrPath, PlanNode } from "../../src/plan/plan.ts";

const UNKNOWN: Expr = { unknown: [{ Value: "resource" }] };

function attr(name: string, base: Expr = UNKNOWN): Expr {
	return { ".": { left: base, attr: name } };
}

const STATUS: AttrPath = { root: "resource", path: ["status"] };

function eqExpr(value: string): Expr {
	return { "==": { left: attr("status"), right: { Value: value } } };
}

function eqNode(value: string): PlanNode {
	return { op: "cmp", cmp: "eq", attr: STATUS, value: { kind: "string", value } };
}

/** A residual policy exactly as Cedar shapes it: constraints flattened to `All`. */
function residual(effect: "permit" | "forbid", body: Expr): PolicyJson {
	return {
		effect,
		principal: { op: "All" },
		action: { op: "All" },
		resource: { op: "All" },
		conditions: [{ kind: "when", body }],
	};
}

function response(overrides: Partial<ResidualResponse> = {}): ResidualResponse {
	return {
		decision: null,
		satisfied: [],
		errored: [],
		mayBeDetermining: [],
		mustBeDetermining: [],
		residuals: {},
		nontrivialResiduals: [],
		...overrides,
	};
}

function options(overrides: Partial<CompileResidualsOptions> = {}): CompileResidualsOptions {
	return {
		resourceType: "Run",
		namespace: "Station",
		scope: "org:1",
		action: "run:read",
		unsupportedResidual: "error",
		onErroredPolicy: "error",
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// The three states
// ---------------------------------------------------------------------------

describe("compileResiduals — the three states", () => {
	it("maps decision 'allow' straight to ALWAYS_ALLOW", () => {
		// core.md §5.1: the mapping is direct, nothing is inferred from residuals.
		const compiled = compileResiduals(
			response({
				decision: "allow",
				satisfied: ["p1"],
				residuals: { p1: residual("permit", { Value: true }) },
			}),
			options(),
		);

		expect(compiled).toMatchObject({
			kind: "ALWAYS_ALLOW",
			condition: PLAN_TRUE,
			postFilter: false,
		});
	});

	it("maps decision 'deny' straight to ALWAYS_DENY", () => {
		expect(compileResiduals(response({ decision: "deny" }), options())).toMatchObject({
			kind: "ALWAYS_DENY",
			condition: PLAN_FALSE,
		});
	});

	it("compiles residuals when the decision is null", () => {
		const compiled = compileResiduals(
			response({
				residuals: { p1: residual("permit", eqExpr("done")) },
				nontrivialResiduals: ["p1"],
			}),
			options(),
		);

		expect(compiled.kind).toBe("CONDITIONAL");
		expect(compiled.condition).toEqual(eqNode("done"));
		expect(compiled.residualPolicyIds).toEqual(["p1"]);
	});
});

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

describe("compileResiduals — assembly", () => {
	it("ors the permits", () => {
		const compiled = compileResiduals(
			response({
				residuals: {
					p1: residual("permit", eqExpr("a")),
					p2: residual("permit", eqExpr("b")),
				},
			}),
			options(),
		);

		expect(compiled.condition).toEqual({ op: "or", nodes: [eqNode("a"), eqNode("b")] });
	});

	it("negates the or of the forbids and ands it in", () => {
		const compiled = compileResiduals(
			response({
				residuals: {
					f1: residual("forbid", eqExpr("secret")),
					p1: residual("permit", eqExpr("a")),
				},
			}),
			options(),
		);

		expect(compiled.condition).toEqual({
			op: "and",
			// `!(status == "secret")` is pushed through to `status != "secret"`.
			nodes: [
				eqNode("a"),
				{ op: "cmp", cmp: "ne", attr: STATUS, value: { kind: "string", value: "secret" } },
			],
		});
	});

	it("is deterministic in policy-id order, not hash-map order", () => {
		const forward = compileResiduals(
			response({
				residuals: { a: residual("permit", eqExpr("a")), b: residual("permit", eqExpr("b")) },
			}),
			options(),
		);
		const backward = compileResiduals(
			response({
				residuals: { b: residual("permit", eqExpr("b")), a: residual("permit", eqExpr("a")) },
			}),
			options(),
		);

		expect(backward.condition).toEqual(forward.condition);
	});

	it("ands the clauses of one policy and reads `unless` as a negation", () => {
		const policy: PolicyJson = {
			effect: "permit",
			principal: { op: "All" },
			action: { op: "All" },
			resource: { op: "All" },
			conditions: [
				{ kind: "when", body: eqExpr("a") },
				{ kind: "unless", body: eqExpr("b") },
			],
		};

		expect(compileResiduals(response({ residuals: { p1: policy } }), options()).condition).toEqual({
			op: "and",
			nodes: [
				eqNode("a"),
				{ op: "cmp", cmp: "ne", attr: STATUS, value: { kind: "string", value: "b" } },
			],
		});
	});

	it('strips Cedar\'s `{"Value":true} &&` residual prefix', () => {
		const wrapped: Expr = {
			"&&": {
				left: { Value: true },
				right: { "&&": { left: { Value: true }, right: eqExpr("a") } },
			},
		};

		expect(
			compileResiduals(response({ residuals: { p1: residual("permit", wrapped) } }), options())
				.condition,
		).toEqual(eqNode("a"));
	});
});

// ---------------------------------------------------------------------------
// Simplification and re-derivation
// ---------------------------------------------------------------------------

describe("compileResiduals — simplification", () => {
	it("re-derives ALWAYS_ALLOW when the condition bottoms out at true", () => {
		// Belt and braces on top of Cedar's own `decision`: a permit that folded to
		// `true` with no forbids means every row.
		expect(
			compileResiduals(
				response({ residuals: { p1: residual("permit", { Value: true }) } }),
				options(),
			),
		).toMatchObject({ kind: "ALWAYS_ALLOW", condition: PLAN_TRUE });
	});

	it("re-derives ALWAYS_DENY when there are no permits at all", () => {
		expect(compileResiduals(response({ residuals: {} }), options())).toMatchObject({
			kind: "ALWAYS_DENY",
			condition: PLAN_FALSE,
		});
	});

	it("re-derives ALWAYS_DENY when a forbid folded to true", () => {
		expect(
			compileResiduals(
				response({
					residuals: {
						f1: residual("forbid", { Value: true }),
						p1: residual("permit", eqExpr("a")),
					},
				}),
				options(),
			),
		).toMatchObject({ kind: "ALWAYS_DENY" });
	});

	it("drops a permit that folded to false", () => {
		expect(
			compileResiduals(
				response({
					residuals: {
						p1: residual("permit", { Value: false }),
						p2: residual("permit", eqExpr("a")),
					},
				}),
				options(),
			).condition,
		).toEqual(eqNode("a"));
	});

	it("folds `resource is T` against the planned type", () => {
		const isRun: Expr = { is: { left: UNKNOWN, entity_type: "Station::Run" } };
		const isProject: Expr = { is: { left: UNKNOWN, entity_type: "Station::Project" } };

		expect(
			compileResiduals(
				response({
					residuals: { p1: residual("permit", { "&&": { left: isRun, right: eqExpr("a") } }) },
				}),
				options(),
			).condition,
		).toEqual(eqNode("a"));

		expect(
			compileResiduals(response({ residuals: { p1: residual("permit", isProject) } }), options()),
		).toMatchObject({ kind: "ALWAYS_DENY" });
	});
});

// ---------------------------------------------------------------------------
// Errored policies
// ---------------------------------------------------------------------------

describe("compileResiduals — onErroredPolicy", () => {
	// The verified trap: an errored policy gets a `{"Value":false}` residual, so
	// an errored *forbid* is already gone before compilation starts.
	const erroredForbid = response({
		errored: ["f1"],
		residuals: {
			f1: residual("forbid", { Value: false }),
			p1: residual("permit", eqExpr("ok")),
		},
		nontrivialResiduals: ["p1"],
	});

	it("throws ERRORED_POLICY by default", () => {
		let thrown: unknown;
		try {
			compileResiduals(erroredForbid, options());
		} catch (error) {
			thrown = error;
		}

		expect(thrown).toBeInstanceOf(ErroredPolicyError);
		expect(thrown).toMatchObject({ code: "ERRORED_POLICY", policyIds: ["f1"], scope: "org:1" });
		expect((thrown as Error).message).toContain("silently disappeared");
	});

	it("returns ALWAYS_DENY under 'deny-all', with the approximation recorded", () => {
		const compiled = compileResiduals(erroredForbid, options({ onErroredPolicy: "deny-all" }));

		expect(compiled).toMatchObject({ kind: "ALWAYS_DENY", condition: PLAN_FALSE });
		expect(compiled.approximations).toHaveLength(1);
		expect(compiled.approximations[0]).toMatchObject({
			policyId: "f1",
			effect: "forbid",
			direction: "permissive",
			reason: "errored-policy",
		});
		expect(compiled.erroredPolicyIds).toEqual(["f1"]);
	});

	it("compiles what is left under 'ignore', recording the vanished forbid", () => {
		const compiled = compileResiduals(erroredForbid, options({ onErroredPolicy: "ignore" }));

		// The forbid is genuinely absent — this is the unsafe mode, and the
		// approximation is the only trace of it.
		expect(compiled.kind).toBe("CONDITIONAL");
		expect(compiled.condition).toEqual(eqNode("ok"));
		expect(compiled.approximations).toEqual([
			expect.objectContaining({
				policyId: "f1",
				direction: "permissive",
				reason: "errored-policy",
			}),
		]);
	});

	it("records an errored permit as merely restrictive", () => {
		const compiled = compileResiduals(
			response({
				errored: ["p1"],
				residuals: {
					p1: residual("permit", { Value: false }),
					p2: residual("permit", eqExpr("a")),
				},
			}),
			options({ onErroredPolicy: "ignore" }),
		);

		expect(compiled.approximations[0]).toMatchObject({ direction: "restrictive" });
	});

	it("still gates on errored[] when Cedar returned a determined decision", () => {
		// A policy can error *and* the request still resolve to deny; the gate has
		// to come first or the errored forbid would be invisible.
		expect(() =>
			compileResiduals(
				response({
					decision: "deny",
					errored: ["f1"],
					residuals: { f1: residual("forbid", { Value: false }) },
				}),
				options(),
			),
		).toThrow(ErroredPolicyError);
	});
});

// ---------------------------------------------------------------------------
// The fail-closed contract, end to end
// ---------------------------------------------------------------------------

describe("compileResiduals — unsupportedResidual", () => {
	const nested: Expr = {
		"==": { left: attr("kind", attr("trigger")), right: { Value: "manual" } },
	};

	it("throws for an untranslatable permit at positive polarity", () => {
		let thrown: unknown;
		try {
			compileResiduals(response({ residuals: { p1: residual("permit", nested) } }), options());
		} catch (error) {
			thrown = error;
		}

		expect(thrown).toBeInstanceOf(UnsupportedResidualError);
		expect(thrown).toMatchObject({ policyId: "p1", effect: "permit", reason: "nested-attribute" });
	});

	it("approximates an untranslatable forbid at positive polarity restrictively", () => {
		const compiled = compileResiduals(
			response({
				residuals: {
					f1: residual("forbid", nested),
					p1: residual("permit", eqExpr("a")),
				},
			}),
			options(),
		);

		// The forbid widened to `true`, so `NOT(true)` blocks everything.
		expect(compiled).toMatchObject({ kind: "ALWAYS_DENY" });
		expect(compiled.approximations[0]).toMatchObject({
			policyId: "f1",
			direction: "restrictive",
			reason: "nested-attribute",
		});
	});

	it("approximates an untranslatable permit under a `not` restrictively", () => {
		const compiled = compileResiduals(
			response({
				residuals: {
					p1: residual("permit", { "&&": { left: eqExpr("a"), right: { "!": { arg: nested } } } }),
				},
			}),
			options(),
		);

		// `!true` is `false`, so this permit contributes nothing. Safe, and recorded.
		expect(compiled).toMatchObject({ kind: "ALWAYS_DENY" });
		expect(compiled.approximations[0]).toMatchObject({ direction: "restrictive" });
	});

	it("throws for an untranslatable forbid under a `not` — the classic vulnerability", () => {
		expect(() =>
			compileResiduals(
				response({ residuals: { f1: residual("forbid", { "!": { arg: nested } }) } }),
				options(),
			),
		).toThrow(UnsupportedResidualError);
	});

	it("stays CONDITIONAL when a widened plan bottoms out at true", () => {
		// `ALWAYS_ALLOW` has no `postFilter` field, so downgrading here would drop
		// the only thing making the widened plan sound: the caller would return
		// every row. "Select everything, then re-check" is the honest shape.
		const compiled = compileResiduals(
			response({ residuals: { p1: residual("permit", nested) } }),
			options({ unsupportedResidual: "post-filter" }),
		);

		expect(compiled).toMatchObject({ kind: "CONDITIONAL", condition: PLAN_TRUE, postFilter: true });
		expect(compiled.approximations[0]).toMatchObject({ direction: "permissive" });
	});

	it("still reports ALWAYS_ALLOW when nothing was widened", () => {
		expect(
			compileResiduals(
				response({ residuals: { p1: residual("permit", { Value: true }) } }),
				options({ unsupportedResidual: "post-filter" }),
			),
		).toMatchObject({ kind: "ALWAYS_ALLOW", postFilter: false });
	});

	it("drops the post-filter when the plan selects nothing anyway", () => {
		const compiled = compileResiduals(
			response({
				residuals: {
					p1: residual("permit", nested),
					f1: residual("forbid", { Value: true }),
				},
			}),
			options({ unsupportedResidual: "post-filter" }),
		);

		expect(compiled).toMatchObject({ kind: "ALWAYS_DENY", postFilter: false });
	});

	it("keeps postFilter on a CONDITIONAL plan that still needs one", () => {
		const compiled = compileResiduals(
			response({
				residuals: {
					p1: residual("permit", { "&&": { left: eqExpr("a"), right: nested } }),
				},
			}),
			options({ unsupportedResidual: "post-filter" }),
		);

		expect(compiled).toMatchObject({ kind: "CONDITIONAL", postFilter: true });
		expect(compiled.condition).toEqual(eqNode("a"));
	});

	it("consults a function with the whole context", () => {
		const decide = vi.fn(() => PLAN_FALSE);

		const compiled = compileResiduals(
			response({ residuals: { p1: residual("permit", nested) } }),
			options({ unsupportedResidual: decide }),
		);

		expect(decide).toHaveBeenCalledWith(
			expect.objectContaining({
				policyId: "p1",
				effect: "permit",
				direction: "permissive",
				reason: "nested-attribute",
				polarity: 1,
				scope: "org:1",
				action: "run:read",
				resourceType: "Run",
			}),
		);
		expect(compiled).toMatchObject({ kind: "ALWAYS_DENY" });
	});
});
