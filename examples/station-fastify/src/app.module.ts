import { Module } from "@nestjs/common";
import { PermissionsModule } from "@nestm/permissions";

import { principalResolver } from "./authorization/identity.ts";
import { LINKS, POLICIES } from "./authorization/policies.ts";
import { RunEntityProvider } from "./authorization/run-entity.provider.ts";
import { SCOPE, vocabulary } from "./authorization/vocabulary.ts";
import { RunsController } from "./runs/runs.controller.ts";
import { RunsRepository } from "./runs/runs.repository.ts";

@Module({
	imports: [
		PermissionsModule.forRoot({
			vocabulary,
			// No `store`: the seeds below populate the built-in in-memory one. Swap
			// in `store: { useClass: DrizzlePolicyStore }` and the seeds become rows
			// an admin UI edits at runtime — nothing else in this file changes.
			policies: POLICIES,
			links: LINKS,
			principalResolver,
			// This example serves one tenant, so the scope is constant. A real
			// multi-tenant app derives it from the URL, either here or per route with
			// `scopeFrom: { kind: "param", param: "organizationId", prefix: "org:" }`.
			scopeResolver: () => SCOPE,
			// Preload the scope so the first request does not pay for the load.
			warmScopes: [SCOPE],
			denial: {
				// A denial is a 403 here so the example is legible. A multi-tenant API
				// that must not leak which tenants exist sets "not-found", or declares
				// a `scope` gate per route — see the README's 404-vs-403 section.
				default: "forbidden",
			},
			// Refuse to boot if any route forgets to declare what it enforces.
			routeAudit: { mode: "error" },
			hooks: {
				onDecision: (record) => {
					// oxlint-disable-next-line no-console -- this is the example's audit log
					console.log(
						`[authz] ${record.route ?? "?"} ${record.allowed ? "allow" : `deny(${record.denial?.reason ?? "?"})`}` +
							` principal=${record.principal?.id ?? "-"} action=${record.action ?? "-"}` +
							` scope=${record.scope} ${String(record.durationMs)}ms`,
					);
				},
			},
		}),
	],
	controllers: [RunsController],
	providers: [RunsRepository, RunEntityProvider],
})
export class AppModule {}
