// Connection details for the integration suites.
//
// A missing database is a **failure**, not a skip. A silently-skipped
// differential suite is worse than no suite: it turns "the compiler is sound"
// into "nobody checked", and reports green either way. `PG_SKIP=1` exists for the
// one legitimate case — someone running the unit suites on a laptop with no
// Docker — and it says so out loud.
//
// Everything this package creates lives in a **unique Postgres schema** per
// worker process, never in `public`. The Drizzle driver's suites run against the
// same server with prefixed tables in `public`, so a shared name would make one
// suite's teardown the other's flaky failure.

import { DataSource } from "typeorm";

/** `PG_URL`, or the repo `compose.yaml` default (port 55433). */
export const PG_URL =
	process.env["PG_URL"] ?? "postgres://nestm:nestm@localhost:55433/nestm_permissions";

/** Set `PG_SKIP=1` to skip every suite that needs a server. */
export const PG_SKIPPED = process.env["PG_SKIP"] === "1";

/** A unique-per-worker identifier fragment, so parallel files never share a name. */
export function uniqueSuffix(label: string): string {
	return `${label}_${String(process.pid % 100_000)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
}

/**
 * Verifies the server is reachable, with a message that says what to run.
 *
 * Called from a `beforeAll`, so the whole file fails at once rather than
 * producing one identical connection error per test.
 */
export async function assertPostgresReachable(): Promise<void> {
	const probe = new DataSource({ type: "postgres", url: PG_URL, extra: { max: 1 } });
	try {
		await probe.initialize();
		await probe.query("select 1");
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
		if (probe.isInitialized) {
			await probe.destroy();
		}
	}
}

/** Opens a bare `DataSource` with no entities, for fixture DDL and raw probes. */
export async function openRawDataSource(): Promise<DataSource> {
	const dataSource = new DataSource({ type: "postgres", url: PG_URL, extra: { max: 4 } });
	await dataSource.initialize();
	return dataSource;
}
