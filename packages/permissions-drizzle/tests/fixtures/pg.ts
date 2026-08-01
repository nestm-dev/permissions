// Connection details for the integration suites.
//
// A missing database is a **failure**, not a skip. A silently-skipped
// differential suite is worse than no suite: it turns "the compiler is sound"
// into "nobody checked", and reports green either way. `PG_SKIP=1` exists for the
// one legitimate case — someone running the unit suites on a laptop with no
// Docker — and it says so out loud.

import { sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";

/** `PG_URL`, or the repo `compose.yaml` default (port 55433). */
export const PG_URL =
	process.env["PG_URL"] ?? "postgres://nestm:nestm@localhost:55433/nestm_permissions";

/** Set `PG_SKIP=1` to skip every suite that needs a server. */
export const PG_SKIPPED = process.env["PG_SKIP"] === "1";

/** A drizzle handle plus the pool it owns, so a suite can close it. */
export interface PgHandle {
	readonly db: NodePgDatabase<Record<string, unknown>>;
	close(): Promise<void>;
}

/** Opens a connection to {@link PG_URL}. */
export function openPg(): PgHandle {
	const db = drizzle(PG_URL) as NodePgDatabase<Record<string, unknown>> & {
		$client: { end(): Promise<void> };
	};
	return {
		db,
		async close(): Promise<void> {
			await db.$client.end();
		},
	};
}

/**
 * Verifies the server is reachable, with a message that says what to run.
 *
 * Called from a `beforeAll`, so the whole file fails at once rather than
 * producing one identical connection error per test.
 */
export async function assertPostgresReachable(): Promise<void> {
	const handle = openPg();
	try {
		await handle.db.execute(sql`select 1`);
	} catch (cause) {
		throw new Error(
			`Could not reach Postgres at ${PG_URL}. The driver suites are differential — they ` +
				`assert that generated SQL selects exactly the rows Cedar authorizes — so there is ` +
				`nothing meaningful to run without a server.\n` +
				`  docker compose up -d        # from the repository root\n` +
				`  PG_URL=…                    # to point somewhere else\n` +
				`  PG_SKIP=1                   # to skip these suites deliberately`,
			{ cause },
		);
	} finally {
		await handle.close();
	}
}

/** A unique-per-worker identifier fragment, so parallel files never share a table. */
export function uniqueSuffix(label: string): string {
	return `${label}_${String(process.pid % 100_000)}_${String(Math.floor(Math.random() * 1e6))}`;
}
