import { Injectable } from "@nestjs/common";
import { EntityProvider } from "@nestm/permissions";
import { entity, entityRef } from "@nestm/permissions-core";
import type { FeatureEntityProvider } from "@nestm/permissions";
import type { EntityGraph, EntityResolutionRequest } from "@nestm/permissions-core";

import { RunsRepository } from "../runs/runs.repository.ts";
import { ORGANIZATION_ID, vocabulary, type StationVocabulary } from "./vocabulary.ts";

/**
 * Contributes the resource half of the entity graph: the run being acted on,
 * plus the project it belongs to (which the `role:reader` grant traverses).
 *
 * Discovered container-wide, so listing it in any module's `providers` is
 * enough; `PermissionsModule.forFeature({ entityProviders: [...] })` is the
 * shorthand. Every method is optional — a tenancy module contributes
 * organisations, this one contributes runs, and neither knows about the other.
 */
@EntityProvider()
@Injectable()
export class RunEntityProvider implements FeatureEntityProvider<StationVocabulary> {
	constructor(private readonly runs: RunsRepository) {}

	resolveResource({ resource }: EntityResolutionRequest<StationVocabulary>): EntityGraph {
		if (resource?.type !== "Run") {
			return [];
		}
		const run = this.runs.findById(resource.id);
		if (run === undefined) {
			// An unknown id resolves to nothing. Cedar then sees an attribute-less,
			// parent-less entity and every permit that reads an attribute fails —
			// which denies, and is exactly the behaviour you want for a probe.
			return [];
		}

		const project = entityRef("Project", run.projectId);
		return [
			entity(vocabulary, "Organization", ORGANIZATION_ID, { attrs: {} }),
			entity(vocabulary, "Project", run.projectId, {
				attrs: {},
				parents: [entityRef("Organization", ORGANIZATION_ID)],
			}),
			entity(vocabulary, "Run", run.id, {
				attrs: { project, status: run.status },
				parents: [project],
			}),
		];
	}
}
