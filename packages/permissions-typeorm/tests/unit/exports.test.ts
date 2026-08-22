// The public surface, pinned.
//
// An export list is a promise: every name here is something a consumer may
// import and this package may not remove without a major. So the assertion is
// **exact equality**, not `toContain` — a `toContain` list grows silently, which
// is how a helper that was never meant to be public ends up load-bearing in
// somebody's application.
//
// The other two invariants are the ones `src/index.ts` opens with, and they are
// checked here rather than asserted in prose:
//
//   1. **No NestJS.** Every framework import lives behind `./nestjs`, so the
//      driver is usable from a plain script, a worker or a migration.
//   2. **No Cedar WASM.** The compiler reaches `@nestm/permissions-core/plan`,
//      which is pure TypeScript. Importing this package must not instantiate the
//      4.1 MiB WASM module.

import { __cedarLoaded } from "@nestm/permissions-core";
import { describe, expect, it } from "vitest";

import * as barrel from "../../src/index.ts";
import * as nestjsEntry from "../../src/nestjs.ts";
import * as testingEntry from "../../src/testing.ts";

/**
 * Every runtime value the barrel exports.
 *
 * Types are invisible here by construction — `Object.keys` of a module namespace
 * lists values only — and are covered by `tsc -b`, which fails on a type export
 * whose declaration was removed.
 */
const BARREL_EXPORTS: readonly string[] = [
	// identity
	"PACKAGE_NAME",
	// entities
	"DEFAULT_TABLE_PREFIX",
	"createPermissionsEntities",
	"defaultLinkIdColumn",
	"defaultScopeColumn",
	"permissionsEntitiesMetaOf",
	// migrations
	"DEFAULT_MIGRATION_NAME",
	"PermissionsInitialMigration",
	"buildPermissionsMigration",
	"permissionsPostgresIndexStatements",
	"permissionsPostgresPolicyStatements",
	// store
	"TypeOrmPolicyStore",
	"defaultTypeOrmPolicyStoreExecutor",
	"DEFAULT_POLL_INTERVAL_MS",
	"MAX_POLL_BACKOFF_MS",
	"PolicyChangeWatcher",
	"PolicyNotifyListener",
	// compiler
	"DEFAULT_ESCAPE_CHAR",
	"DEFAULT_PARAMETER_PREFIX",
	"ParameterBag",
	"applyPlan",
	"applyPlanToSelect",
	"createTypeOrmResourceMapping",
	"planNodeToBrackets",
	"planNodeToSql",
	"planToBrackets",
	"planToSql",
	// errors
	"PlanCompilationError",
	"UnmappedAttributeError",
	"UnmappedHierarchyError",
	"isPlanCompilationError",
];

describe("barrel exports", () => {
	it("exports exactly the declared surface", () => {
		expect(Object.keys(barrel).toSorted()).toEqual([...BARREL_EXPORTS].toSorted());
	});

	it("exports PACKAGE_NAME", () => {
		expect(barrel.PACKAGE_NAME).toBe("@nestm/permissions-typeorm");
	});

	it("does not instantiate the Cedar WASM", () => {
		// The store reaches core's barrel for `PermissionsError` and the store SPI,
		// and the compiler reaches `/plan`. Neither may pull 4.1 MiB of WASM into a
		// consumer's bundle, and `loadCedar()` staying lazy is what guarantees it.
		expect(__cedarLoaded()).toBe(false);
	});

	it("keeps @nestjs out of the base entry's module graph", async () => {
		// Structural rather than a mocked resolver: every file the barrel can reach is
		// in this package, so "does any of them import @nestjs" is answerable by
		// reading them. The one file that may is `nestjs.ts`, which the barrel does not
		// reference.
		const { readFileSync, readdirSync, statSync } = await import("node:fs");
		const { fileURLToPath } = await import("node:url");
		const { join } = await import("node:path");

		const sourceDirectory = fileURLToPath(new URL("../../src", import.meta.url));
		const offenders: string[] = [];

		const walk = (directory: string): void => {
			for (const entry of readdirSync(directory)) {
				const path = join(directory, entry);
				if (statSync(path).isDirectory()) {
					walk(path);
					continue;
				}
				if (!path.endsWith(".ts") || path.endsWith("nestjs.ts")) {
					continue;
				}
				if (/from\s+["']@nestjs\//.test(readFileSync(path, "utf8"))) {
					offenders.push(path);
				}
			}
		};
		walk(sourceDirectory);

		expect(offenders, "only src/nestjs.ts may import @nestjs/*").toEqual([]);
	});
});

describe("subpath entries", () => {
	it("exposes ./nestjs", () => {
		expect(nestjsEntry.NESTJS_ENTRY_NAME).toBe("@nestm/permissions-typeorm/nestjs");
		expect(typeof nestjsEntry.PermissionsTypeOrmModule.forRoot).toBe("function");
		expect(typeof nestjsEntry.PermissionsTypeOrmModule.forRootAsync).toBe("function");
	});

	it("exposes ./testing, including core's oracles", () => {
		expect(testingEntry.TESTING_ENTRY_NAME).toBe("@nestm/permissions-typeorm/testing");
		expect(typeof testingEntry.typeormStoreFactory).toBe("function");
		expect(typeof testingEntry.provisionPermissionsSchema).toBe("function");
		// Re-exported from core so a driver's suite has one import, not two.
		expect(typeof testingEntry.runPolicyStoreConformanceSuite).toBe("function");
		expect(typeof testingEntry.evaluatePlanNode).toBe("function");
		expect(typeof testingEntry.filterRowsByPlan).toBe("function");
		expect(typeof testingEntry.matchLikeTokens).toBe("function");
	});

	it("keeps the compilation errors mutually recognisable across drivers", () => {
		// `isPlanCompilationError` matches on `code`/`reason`, not on the class, so an
		// application using both drivers catches one shape rather than two — and a
		// bundler that duplicates the module cannot break `instanceof` for it.
		const error = new barrel.PlanCompilationError("invalid-mapping", "x");
		expect(barrel.isPlanCompilationError(error)).toBe(true);
		expect(barrel.isPlanCompilationError(new Error("x"))).toBe(false);
		expect(error.code).toBe("PLAN_COMPILATION");
		expect(new barrel.UnmappedAttributeError("x").reason).toBe("unmapped-attribute");
		expect(new barrel.UnmappedHierarchyError("x").reason).toBe("unmapped-hierarchy");
	});
});
