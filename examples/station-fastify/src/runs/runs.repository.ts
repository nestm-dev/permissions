import { Injectable } from "@nestjs/common";

/** The two projects this example knows. */
export const PROJECTS = { nightly: "nightly", release: "release" } as const;

/** One row of the "database". */
export interface Run {
	readonly id: string;
	readonly projectId: string;
	readonly status: "queued" | "running" | "archived";
}

const ROWS: readonly Run[] = [
	{ id: "run-1", projectId: PROJECTS.nightly, status: "queued" },
	{ id: "run-2", projectId: PROJECTS.nightly, status: "running" },
	{ id: "run-3", projectId: PROJECTS.nightly, status: "archived" },
	{ id: "run-4", projectId: PROJECTS.release, status: "queued" },
];

/** A stand-in for whatever your ORM is. */
@Injectable()
export class RunsRepository {
	all(): readonly Run[] {
		return ROWS;
	}

	findById(id: string): Run | undefined {
		return ROWS.find((run) => run.id === id);
	}
}
