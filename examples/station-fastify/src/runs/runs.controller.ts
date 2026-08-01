import { Controller, Get, Param, Post } from "@nestjs/common";
import {
	CurrentPrincipal,
	QueryPlan,
	RequireAuthenticated,
	RequirePermission,
} from "@nestm/permissions";
import type { ResolvedPrincipal } from "@nestm/permissions";

import { applyPlan } from "./plan-filter.ts";
import { runIdSchema } from "./run-id.schema.ts";
import { RunsRepository, type Run } from "./runs.repository.ts";

/** The one run the dispatch route acts on, named at declaration time. */
const NIGHTLY_RUN = "run-1";

@Controller("runs")
export class RunsController {
	constructor(private readonly runs: RunsRepository) {}

	/**
	 * **Query plan.** No resource is named, so the guard asks Cedar *which rows*
	 * this principal may read and stashes the answer. `ALWAYS_DENY` never reaches
	 * the handler — the guard already refused it with 403, which is more honest
	 * than an empty list.
	 */
	@Get()
	@RequirePermission("run:read", { kind: "unspecified", type: "Run" })
	list(@QueryPlan() plan: QueryPlan): {
		kind: string;
		condition: unknown;
		approximations: number;
		runs: readonly Run[];
	} {
		return {
			kind: plan.kind,
			condition: plan.kind === "CONDITIONAL" ? plan.condition : undefined,
			approximations: plan.approximations.length,
			runs: applyPlan(plan, this.runs.all()),
		};
	}

	/**
	 * **Param resource.** The id comes from the URL and is validated *in the
	 * guard*, because pipes have not run yet. A malformed id is a 400; a
	 * well-formed one the caller may not read is a 403.
	 */
	@Get(":runId")
	@RequirePermission("run:read", {
		kind: "param",
		param: "runId",
		type: "Run",
		parseAs: runIdSchema,
	})
	find(@Param("runId") runId: string): Run | { error: string } {
		return this.runs.findById(runId) ?? { error: "Run not found." };
	}

	/**
	 * **Literal resource.** The route always acts on the same entity, so the
	 * declaration names it and nothing is read from the request at all.
	 */
	@Post("nightly/dispatch")
	@RequirePermission("run:dispatch", { kind: "literal", type: "Run", id: NIGHTLY_RUN })
	dispatch(): { dispatched: string } {
		return { dispatched: NIGHTLY_RUN };
	}

	/** **No decision at all** — just a resolvable principal. */
	@Get("whoami/me")
	@RequireAuthenticated()
	me(@CurrentPrincipal() principal: ResolvedPrincipal): {
		principal: string;
		entities: number;
	} {
		return { principal: principal.ref.id, entities: principal.entities.length };
	}
}
