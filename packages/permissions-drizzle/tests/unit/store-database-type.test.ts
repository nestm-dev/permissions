// The constructor's `db` parameter, as a type.
//
// Most of this file is compile-time only. `pnpm run typecheck` is the assertion;
// the runtime `expect`s exist so the file is a test rather than a fixture.
//
// Why it matters. Two shapes this package's own README asks for did not fit the
// old `NodePgDatabase<Record<string, unknown>>` parameter:
//
//   * an application handle typed over its **own** schema —
//     `drizzle(pool, { schema })` is `NodePgDatabase<typeof schema>`, and
//     TypeScript refuses that generic substitution however structurally
//     compatible the two are;
//   * a `transaction()` handle, which is what the README's RLS section tells
//     consumers to build the store over, because `set_config(…, true)` is
//     transaction-local and a store on a different pooled connection reads zero
//     rows.
//
// Both were reachable only through `as unknown as ConstructorParameters<typeof
// DrizzlePolicyStore>[0]` — a cast that would equally have accepted a number, at
// the one call site where the wrong handle means "this tenant's policies are
// invisible" rather than a crash.

import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import {
	pgTable,
	text,
	type PgDatabase,
	type PgQueryResultHKT,
	type PgTransaction,
} from "drizzle-orm/pg-core";
import { describe, expect, expectTypeOf, it } from "vitest";

import { createPermissionsSchema, type PermissionsSchema } from "../../src/schema.ts";
import {
	DrizzlePolicyStore,
	type DrizzlePolicyStoreDatabase,
	type DrizzlePolicyStoreExecution,
	type DrizzlePolicyStoreExecutor,
} from "../../src/store/drizzle-policy-store.ts";

/** An application's own drizzle schema — the thing that makes the generic differ. */
const appSchema = {
	users: pgTable("store_db_type_users", { id: text("id").primaryKey() }),
};

/** `drizzle(pool, { schema: appSchema })`. Station's `StationDatabase`. */
type AppDatabase = NodePgDatabase<typeof appSchema>;

/** The parameter type the constructor used to declare. */
type LegacyParameter = NodePgDatabase<Record<string, unknown>>;

/**
 * A transaction handle as a driver-agnostic helper hands it out.
 *
 * Station's `withOrganizationContext(db, organizationId, body)` is exactly this:
 * the callback parameter is typed against `PgTransaction`/`PgDatabase`, not
 * against one driver's `NodePgDatabase`, because the helper predates and outlives
 * any single driver choice.
 */
type PortableTransaction = PgTransaction<PgQueryResultHKT, Record<string, unknown>>;

/** `true` when `A` is assignable to `B`. Spelled out so a negative is assertable. */
type Assignable<A, B> = [A] extends [B] ? true : false;

describe("DrizzlePolicyStore's database parameter", () => {
	it("accepts a transaction handle typed by a driver-agnostic helper", () => {
		// The gap, reduced to its two assertions. `PgTransaction` is what a helper
		// like station's `withOrganizationContext` gives its callback, and it is not
		// a `NodePgDatabase` — so the documented RLS wiring was reachable only
		// through a cast.
		expectTypeOf<Assignable<PortableTransaction, LegacyParameter>>().toEqualTypeOf<false>();
		expectTypeOf<
			Assignable<PortableTransaction, DrizzlePolicyStoreDatabase>
		>().toEqualTypeOf<true>();
	});

	it("accepts the PgDatabase supertype itself", () => {
		// The same shape one level up: a data-access layer that hands out
		// `PgDatabase` rather than one driver's class — including this package's own
		// `PermissionsDrizzleModuleOptions.db`.
		expectTypeOf<Assignable<DrizzlePolicyStoreDatabase, LegacyParameter>>().toEqualTypeOf<false>();
		expectTypeOf<Assignable<AppDatabase, DrizzlePolicyStoreDatabase>>().toEqualTypeOf<true>();
	});

	it("builds a store over a portable transaction handle, castless", () => {
		const build = (tx: PortableTransaction, schema: PermissionsSchema): DrizzlePolicyStore =>
			new DrizzlePolicyStore(tx, schema, { poll: false });

		expect(build).toBeTypeOf("function");
	});

	it("accepts a transaction handle without a cast", () => {
		// The whole fix as one expression that has to compile. Nothing runs it — a
		// real transaction needs a server, and `tests/integration/rls.test.ts` does
		// exactly this against one, castless.
		const overTransaction = async (db: AppDatabase, schema: PermissionsSchema): Promise<void> => {
			await db.transaction(async (tx) => {
				const store = new DrizzlePolicyStore(tx, schema, { poll: false });
				expectTypeOf(store).toEqualTypeOf<DrizzlePolicyStore>();
			});
		};

		expect(overTransaction).toBeTypeOf("function");
	});

	it("accepts a plain pool handle too — this is a widening, not a swap", () => {
		expectTypeOf<Assignable<LegacyParameter, DrizzlePolicyStoreDatabase>>().toEqualTypeOf<true>();
	});

	it("accepts a tenant executor with the shared structural run contract", () => {
		interface TenantExecutor {
			run<Result>(
				execution: DrizzlePolicyStoreExecution,
				work: (database: DrizzlePolicyStoreDatabase) => Result | Promise<Result>,
			): Promise<Result>;
		}

		expectTypeOf<Assignable<TenantExecutor, DrizzlePolicyStoreExecutor>>().toEqualTypeOf<true>();
	});

	it("is the PgDatabase supertype the class already used internally", () => {
		expectTypeOf<DrizzlePolicyStoreDatabase>().toEqualTypeOf<
			PgDatabase<PgQueryResultHKT, Record<string, unknown>>
		>();
	});

	it("still rejects something that is not a drizzle database", () => {
		const schema = createPermissionsSchema({ tablePrefix: "db_type_" });

		expect(
			() =>
				new DrizzlePolicyStore(
					// @ts-expect-error — a bare pg Pool is not a drizzle handle. The widening
					// goes to `PgDatabase`, not to `unknown`.
					{ query: () => Promise.resolve({ rows: [] }) },
					schema,
				),
		).not.toThrow();
	});
});
