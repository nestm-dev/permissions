// The audit hook.
//
// Two rules from core.md §7 shape everything here:
//
//   1. `onDecision` is **synchronous, never awaited, and wrapped in try/catch**.
//      An audit sink must never be able to fail or slow an authorization
//      decision — a logger that throws must not turn an `allow` into a 500.
//   2. Context is **redacted by default**. A request context is where PII lands
//      (an IP, an email, a reason string), and an audit trail that leaks it by
//      default is a liability nobody opted into.

import type { EntityRef } from "../cedar/uid.ts";
import type { CheckResult } from "../engine.ts";
import type { PolicyScopeId } from "../policy/policy-store.ts";
import type { PlanApproximation, PlanDiagnostics, QueryPlan } from "../plan/plan.ts";

/** Placeholder substituted for every context value by {@link redactContextKeys}. */
export const REDACTED_VALUE = "[redacted]";

/**
 * A completed `check()`.
 *
 * Structurally a {@link CheckResult} plus the request it answered, so a sink can
 * write one row without correlating anything.
 */
export interface CheckDecisionEvent extends CheckResult {
	readonly type: "check";
	/** Principal of the request, in vocabulary-local form. */
	readonly principal: EntityRef;
	/** Action id of the request. */
	readonly action: string;
	/** Resource of the request, in vocabulary-local form. */
	readonly resource: EntityRef;
	/** Request context after `redactContext`. Absent when the request had none. */
	readonly context?: unknown;
}

/**
 * A completed `plan()`.
 *
 * Deliberately carries the *shape* of the answer — kind, approximations,
 * diagnostics — and never the compiled `condition`. A plan tree contains bound
 * literals from the policies (ids, statuses, timestamps) and an audit sink is
 * not the place for them; a caller that wants the tree already has the plan.
 *
 * `approximations` is the field to alert on. A non-empty list means the plan is
 * not an exact translation of the policy set, and a `'permissive'` entry means
 * it selects rows `check()` would deny.
 */
export interface PlanDecisionEvent {
	readonly type: "plan";
	/** Scope the plan was compiled in. */
	readonly scope: PolicyScopeId;
	/** Principal the plan was compiled for, in vocabulary-local form. */
	readonly principal: EntityRef;
	/** Action id of the request. */
	readonly action: string;
	/** Resource type the plan filters. */
	readonly resourceType: string;
	/** Which of the three states came out. */
	readonly kind: QueryPlan<string>["kind"];
	/** Recorded departures from an exact plan. Empty for an exact plan. */
	readonly approximations: readonly PlanApproximation[];
	/** Provenance and timing. */
	readonly diagnostics: PlanDiagnostics;
	/** Request context after `redactContext`. Absent when the request had none. */
	readonly context?: unknown;
}

/**
 * Anything the engine reports to `onDecision`.
 *
 * A discriminated union on `type`. Consumers must switch on it rather than
 * assume the check shape.
 */
export type DecisionEvent = CheckDecisionEvent | PlanDecisionEvent;

/** Synchronous audit sink. Must not throw; a throw is swallowed, not surfaced. */
export type DecisionListener = (event: DecisionEvent) => void;

/** Transforms a request context before it reaches the audit sink. */
export type ContextRedactor = (context: unknown) => unknown;

/**
 * The default redactor: keeps the shape, elides every value.
 *
 * `{ mfa: true, reason: "oncall" }` becomes
 * `{ mfa: "[redacted]", reason: "[redacted]" }` — enough to see *which* context
 * fields a decision considered, never enough to leak what was in them. Only
 * top-level keys are walked; a nested object is elided whole.
 *
 * Pass your own `redactContext` to keep specific fields, and audit that choice.
 */
export function redactContextKeys(context: unknown): unknown {
	if (context === null || typeof context !== "object" || Array.isArray(context)) {
		return context === undefined ? undefined : REDACTED_VALUE;
	}

	const redacted: Record<string, string> = {};
	for (const key of Object.keys(context)) {
		redacted[key] = REDACTED_VALUE;
	}
	return redacted;
}

/**
 * Delivers one event to `listener`, swallowing everything it throws.
 *
 * The event is built lazily so that neither redaction nor event construction
 * runs when there is no listener — and so that a redactor that throws is caught
 * by the same net as a sink that throws.
 */
export function emitDecision(
	listener: DecisionListener | undefined,
	buildEvent: () => DecisionEvent,
): void {
	if (listener === undefined) {
		return;
	}

	try {
		listener(buildEvent());
	} catch {
		// Deliberately swallowed: an authorization decision has already been made
		// and returning it is more important than recording it. A sink that needs
		// delivery guarantees must own them itself (queue, retry, dead-letter).
	}
}
