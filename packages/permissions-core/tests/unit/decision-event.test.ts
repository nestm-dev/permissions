import { describe, expect, it, vi } from "vitest";

import {
	REDACTED_VALUE,
	emitDecision,
	redactContextKeys,
	type CheckDecisionEvent,
	type DecisionEvent,
} from "../../src/diagnostics/decision-event.ts";

function checkEvent(overrides: Partial<CheckDecisionEvent> = {}): DecisionEvent {
	return {
		type: "check",
		allowed: true,
		decision: "allow",
		determiningPolicyIds: ["p:1"],
		policyErrors: [],
		scope: "org:1",
		policySetVersion: "g0:s1",
		durationMs: 0,
		cache: "hit",
		principal: { type: "Member", id: "m1" },
		action: "run:read",
		resource: { type: "Run", id: "r1" },
		...overrides,
	};
}

describe("redactContextKeys", () => {
	it("keeps the keys and elides every value", () => {
		expect(redactContextKeys({ mfa: true, reason: "oncall" })).toEqual({
			mfa: REDACTED_VALUE,
			reason: REDACTED_VALUE,
		});
	});

	it("does not walk into nested objects", () => {
		expect(redactContextKeys({ actor: { email: "a@b.c" } })).toEqual({ actor: REDACTED_VALUE });
	});

	it("elides a non-object context whole", () => {
		expect(redactContextKeys("oncall")).toBe(REDACTED_VALUE);
		expect(redactContextKeys(42)).toBe(REDACTED_VALUE);
		expect(redactContextKeys([1, 2])).toBe(REDACTED_VALUE);
		expect(redactContextKeys(null)).toBe(REDACTED_VALUE);
	});

	it("leaves undefined alone so an absent context stays absent", () => {
		expect(redactContextKeys(undefined)).toBeUndefined();
	});

	it("keeps an empty context empty", () => {
		expect(redactContextKeys({})).toEqual({});
	});
});

describe("emitDecision", () => {
	it("delivers the built event", () => {
		const listener = vi.fn();
		const event = checkEvent();

		emitDecision(listener, () => event);

		expect(listener).toHaveBeenCalledExactlyOnceWith(event);
	});

	it("does not build the event when there is no listener", () => {
		const build = vi.fn(() => checkEvent());

		emitDecision(undefined, build);

		expect(build).not.toHaveBeenCalled();
	});

	it("swallows a listener that throws", () => {
		const listener = vi.fn(() => {
			throw new Error("audit sink is down");
		});

		expect(() => {
			emitDecision(listener, () => checkEvent());
		}).not.toThrow();
		expect(listener).toHaveBeenCalledTimes(1);
	});

	it("swallows a redactor that throws while the event is being built", () => {
		const listener = vi.fn();

		expect(() => {
			emitDecision(listener, () => {
				throw new Error("redactor exploded");
			});
		}).not.toThrow();
		expect(listener).not.toHaveBeenCalled();
	});
});

describe("DecisionEvent", () => {
	it("discriminates on `type` so the Phase 4 plan arm can be added without a break", () => {
		const event = checkEvent();

		// The switch a consumer must write today still compiles unchanged once the
		// `'plan'` arm lands; a consumer that reads `event.allowed` directly does not.
		const described = event.type === "check" ? `${event.action}:${String(event.allowed)}` : "plan";

		expect(described).toBe("run:read:true");
	});
});
