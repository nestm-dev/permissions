import { describe, expect, it, vi } from "vitest";

import type { Expr } from "../../src/cedar/binding.ts";
import { UnsupportedResidualError } from "../../src/diagnostics/errors.ts";
import {
	approximationDirection,
	erroredPolicyApproximation,
	erroredPolicyDirection,
	resolveUnsupportedResidual,
	type ResolveUnsupportedInput,
} from "../../src/plan/approximation.ts";
import { flipPolarity } from "../../src/plan/expr-to-plan.ts";
import { PLAN_FALSE, PLAN_TRUE } from "../../src/plan/plan-node.ts";
import type {
	PlanApproximationDirection,
	PlanApproximationReason,
	UnsupportedResidualContext,
} from "../../src/plan/plan.ts";

/**
 * Every reason the compiler can produce, plus the two it reserves. The matrix
 * below runs the full cross product, so adding a member to the union without
 * adding it here fails the exhaustiveness assertion at the bottom.
 */
const REASONS: readonly PlanApproximationReason[] = [
	"nested-attribute",
	"arithmetic",
	"unknown-both-sides",
	"extension-on-unknown",
	"unsupported-operator",
	"unsupported-value",
	"non-literal-hierarchy",
	"entity-identity",
	"wrong-unknown-root",
	"errored-policy",
	"unmapped-hierarchy",
	"other",
];

const EFFECTS = ["permit", "forbid"] as const;

/** `not`-depths 0..3, i.e. the polarity each depth produces. */
const DEPTHS = [0, 1, 2, 3] as const;

function polarityAtDepth(depth: number): 1 | -1 {
	let polarity: 1 | -1 = 1;
	for (let level = 0; level < depth; level += 1) {
		polarity = flipPolarity(polarity);
	}
	return polarity;
}

const OFFENDING: Expr = { "+": { left: { Value: 1 }, right: { Value: 2 } } };

function input(overrides: Partial<ResolveUnsupportedInput> = {}): ResolveUnsupportedInput {
	return {
		policyId: "p1",
		effect: "permit",
		reason: "arithmetic",
		expr: OFFENDING,
		polarity: 1,
		scope: "org:1",
		action: "run:read",
		resourceType: "Run",
		policy: "error",
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// The algebra
// ---------------------------------------------------------------------------

describe("approximationDirection", () => {
	// The four cases spelled out longhand, derived from the assembled condition
	// `OR(permits) AND NOT(OR(forbids))` with the subterm replaced by `true`.
	it("widens a permit at positive polarity", () => {
		expect(approximationDirection("permit", 1)).toBe("permissive");
	});

	it("narrows a permit at negative polarity", () => {
		// `permit ... unless { X }` becomes `!X`; `!true` is `false`, which drops
		// the permit. Over-blocking, therefore safe.
		expect(approximationDirection("permit", -1)).toBe("restrictive");
	});

	it("narrows the result for a forbid at positive polarity", () => {
		// A wider forbid, negated, is a narrower result. This is the one case where
		// substituting `true` is both necessary and safe.
		expect(approximationDirection("forbid", 1)).toBe("restrictive");
	});

	it("widens the result for a forbid at negative polarity", () => {
		// `forbid ... unless { X }` with `X` dropped deletes the forbid entirely.
		// This is the CVE the whole file exists to prevent.
		expect(approximationDirection("forbid", -1)).toBe("permissive");
	});

	it("is exactly the XOR of effect and polarity, at every depth", () => {
		for (const effect of EFFECTS) {
			for (const depth of DEPTHS) {
				const polarity = polarityAtDepth(depth);
				const expected: PlanApproximationDirection =
					(effect === "permit") === (polarity === 1) ? "permissive" : "restrictive";

				expect(
					approximationDirection(effect, polarity),
					`${effect} at depth ${String(depth)}`,
				).toBe(expected);
			}
		}
	});

	it("flips with every enclosing not", () => {
		expect(DEPTHS.map((depth) => approximationDirection("permit", polarityAtDepth(depth)))).toEqual(
			["permissive", "restrictive", "permissive", "restrictive"],
		);
		expect(DEPTHS.map((depth) => approximationDirection("forbid", polarityAtDepth(depth)))).toEqual(
			["restrictive", "permissive", "restrictive", "permissive"],
		);
	});
});

describe("erroredPolicyDirection", () => {
	// An errored policy is replaced by `false`, which is `true` at flipped
	// polarity — so the safety verdict is the mirror image of the usual one.
	it("treats an errored forbid as permissive", () => {
		expect(erroredPolicyDirection("forbid")).toBe("permissive");
	});

	it("treats an errored permit as restrictive", () => {
		expect(erroredPolicyDirection("permit")).toBe("restrictive");
	});
});

// ---------------------------------------------------------------------------
// The exhaustive matrix
// ---------------------------------------------------------------------------

describe("resolveUnsupportedResidual — exhaustive (effect x depth 0..3 x reason)", () => {
	it("substitutes true and records a restrictive approximation whenever it is safe", () => {
		let restrictive = 0;

		for (const effect of EFFECTS) {
			for (const depth of DEPTHS) {
				for (const reason of REASONS) {
					const polarity = polarityAtDepth(depth);
					if (approximationDirection(effect, polarity) !== "restrictive") {
						continue;
					}
					restrictive += 1;

					// `'error'` is the *default* policy, and it is deliberately not
					// consulted here: a restrictive approximation is safe, so making a
					// plan fail because of one would be fail-closed theatre.
					const resolution = resolveUnsupportedResidual(
						input({ effect, polarity, reason, policy: "error" }),
					);

					expect(resolution.node, `${effect}/${String(depth)}/${reason}`).toEqual(PLAN_TRUE);
					expect(resolution.postFilter).toBe(false);
					expect(resolution.approximation).toMatchObject({
						policyId: "p1",
						effect,
						direction: "restrictive",
						reason,
						expr: OFFENDING,
					});
					expect(resolution.approximation.message).toContain("fewer rows");
				}
			}
		}

		// 2 effects x 2 safe depths x 12 reasons.
		expect(restrictive).toBe(48);
	});

	it("throws UNSUPPORTED_RESIDUAL whenever the substitution would widen", () => {
		let permissive = 0;

		for (const effect of EFFECTS) {
			for (const depth of DEPTHS) {
				for (const reason of REASONS) {
					const polarity = polarityAtDepth(depth);
					if (approximationDirection(effect, polarity) !== "permissive") {
						continue;
					}
					permissive += 1;

					let thrown: unknown;
					try {
						resolveUnsupportedResidual(input({ effect, polarity, reason, policy: "error" }));
					} catch (error) {
						thrown = error;
					}

					expect(thrown, `${effect}/${String(depth)}/${reason}`).toBeInstanceOf(
						UnsupportedResidualError,
					);
					expect(thrown).toMatchObject({
						code: "UNSUPPORTED_RESIDUAL",
						policyId: "p1",
						effect,
						reason,
						expr: OFFENDING,
						resourceType: "Run",
						action: "run:read",
						scope: "org:1",
					});
					// The offending expression has to be *in the message*: an operator
					// telling their user "your plan failed" needs to know which policy.
					expect((thrown as Error).message).toContain(JSON.stringify(OFFENDING));
				}
			}
		}

		expect(permissive).toBe(48);
	});

	it("covers every reason in the union", () => {
		expect(new Set(REASONS).size).toBe(REASONS.length);
		// A reason added to `PlanApproximationReason` without being added here would
		// make this assignment a compile error.
		const exhaustive: Record<PlanApproximationReason, true> = Object.fromEntries(
			REASONS.map((reason) => [reason, true]),
		) as Record<PlanApproximationReason, true>;
		expect(Object.keys(exhaustive)).toHaveLength(12);
	});
});

// ---------------------------------------------------------------------------
// Policy application
// ---------------------------------------------------------------------------

describe("resolveUnsupportedResidual — UnsupportedResidualPolicy", () => {
	it("'post-filter' widens to true and asks for a post-filter", () => {
		const resolution = resolveUnsupportedResidual(input({ policy: "post-filter" }));

		expect(resolution.node).toEqual(PLAN_TRUE);
		expect(resolution.postFilter).toBe(true);
		expect(resolution.approximation.direction).toBe("permissive");
		expect(resolution.approximation.message).toContain("rows the policy does not allow");
	});

	it("hands a function the full context and honours a returned node", () => {
		const decide = vi.fn<(context: UnsupportedResidualContext) => typeof PLAN_FALSE>(
			() => PLAN_FALSE,
		);
		const resolution = resolveUnsupportedResidual(
			input({ policy: decide, reason: "nested-attribute" }),
		);

		expect(decide).toHaveBeenCalledWith({
			policyId: "p1",
			effect: "permit",
			direction: "permissive",
			reason: "nested-attribute",
			expr: OFFENDING,
			polarity: 1,
			scope: "org:1",
			action: "run:read",
			resourceType: "Run",
		});
		// A caller-supplied `false` drops the offending permit, which is a *narrowing*
		// — but it is still recorded, because the caller decided it, not the compiler.
		expect(resolution.node).toEqual(PLAN_FALSE);
		expect(resolution.postFilter).toBe(false);
		expect(resolution.approximation.direction).toBe("permissive");
	});

	it("honours a function returning 'error'", () => {
		expect(() => resolveUnsupportedResidual(input({ policy: () => "error" }))).toThrow(
			UnsupportedResidualError,
		);
	});

	it("honours a function returning 'post-filter'", () => {
		expect(resolveUnsupportedResidual(input({ policy: () => "post-filter" })).postFilter).toBe(
			true,
		);
	});

	it("never consults the function for a restrictive approximation", () => {
		const decide = vi.fn(() => PLAN_FALSE);

		const resolution = resolveUnsupportedResidual(
			input({ effect: "forbid", polarity: 1, policy: decide }),
		);

		expect(decide).not.toHaveBeenCalled();
		expect(resolution.node).toEqual(PLAN_TRUE);
	});
});

describe("erroredPolicyApproximation", () => {
	it("names the disappearing forbid explicitly", () => {
		const approximation = erroredPolicyApproximation("f1", "forbid", { Value: false });

		expect(approximation).toMatchObject({
			policyId: "f1",
			effect: "forbid",
			direction: "permissive",
			reason: "errored-policy",
		});
		expect(approximation.message).toContain("rows it was meant to hide will be returned");
	});

	it("records an errored permit as restrictive", () => {
		expect(erroredPolicyApproximation("p1", "permit", { Value: false })).toMatchObject({
			direction: "restrictive",
			reason: "errored-policy",
		});
	});
});
