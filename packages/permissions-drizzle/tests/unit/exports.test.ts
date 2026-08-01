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
import * as schemaEntry from "../../src/schema.ts";
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
	// schema
	"DEFAULT_TABLE_PREFIX",
	"assertTablesReady",
	"createPermissionsSchema",
	"defaultScopeColumn",
	"permissionsPostgresPolicyStatements",
	"permissionsSchemaMetaOf",
	// store
	"DEFAULT_POLL_INTERVAL_MS",
	"MAX_POLL_BACKOFF_MS",
	"DrizzlePolicyStore",
	"PolicyChangeWatcher",
	"PolicyNotifyListener",
	// compiler
	"DEFAULT_ESCAPE_CHAR",
	"applyPlan",
	"planNodeToSql",
	"planToSql",
	// errors
	"PlanCompilationError",
	"UnmappedAttributeError",
	"UnmappedHierarchyError",
	"isPlanCompilationError",
];

describe("barrel exports", () => {
	it("exports PACKAGE_NAME", () => {
		expect(barrel.PACKAGE_NAME).toBe("@nestm/permissions-drizzle");
	});

	it("exports nothing undeclared", () => {
		expect(Object.keys(barrel).toSorted()).toEqual([...BARREL_EXPORTS].toSorted());
	});

	it("does not re-export the subpath entries' identity markers", () => {
		// Each entry names itself; the barrel names the package. Re-exporting one
		// subpath's marker and not the others' is the shape of an accidental
		// `export *`, so it is asserted absent rather than left to review.
		for (const marker of ["SCHEMA_ENTRY_NAME", "NESTJS_ENTRY_NAME", "TESTING_ENTRY_NAME"]) {
			expect(Object.keys(barrel)).not.toContain(marker);
		}
	});

	it("exports classes and functions, not undefined placeholders", () => {
		for (const name of BARREL_EXPORTS) {
			expect((barrel as Record<string, unknown>)[name]).toBeDefined();
		}
	});
});

describe("subpath entries", () => {
	it("exposes ./nestjs", () => {
		expect(nestjsEntry.NESTJS_ENTRY_NAME).toBe("@nestm/permissions-drizzle/nestjs");
	});

	it("exposes ./schema", () => {
		expect(schemaEntry.SCHEMA_ENTRY_NAME).toBe("@nestm/permissions-drizzle/schema");
	});

	it("exposes ./testing", () => {
		expect(testingEntry.TESTING_ENTRY_NAME).toBe("@nestm/permissions-drizzle/testing");
	});

	it("re-exports the whole of ./schema from the barrel, bar the identity marker", () => {
		// The barrel documents the schema factory as "also on the ./schema subpath".
		// If `./schema` grows an export and the barrel does not, that sentence quietly
		// stops being true.
		const schemaNames = Object.keys(schemaEntry).filter((name) => name !== "SCHEMA_ENTRY_NAME");
		expect(Object.keys(barrel)).toEqual(expect.arrayContaining(schemaNames));
	});
});

describe("entry-point isolation", () => {
	it("does not instantiate the Cedar WASM", () => {
		// `src/index.ts` has been imported at the top of this file. If any transitive
		// import reached core's barrel *and* triggered a load, this would be true —
		// core keeps `loadCedar()` lazy, and the driver never calls it.
		expect(__cedarLoaded()).toBe(false);
	});

	it("keeps @nestjs/* out of everything but ./nestjs", async () => {
		const sourceFiles = await collectSources();
		const offenders = sourceFiles.filter(
			(file) => file.path !== "nestjs.ts" && /from\s+["']@nestjs\//.test(file.text),
		);
		expect(offenders.map((file) => file.path)).toEqual([]);
	});

	it("keeps drizzle-kit out of the statically-imported graph", async () => {
		// drizzle-kit is an *optional* peer. A static import would make it mandatory
		// for every consumer, so `./testing` reaches it through `await import(...)`.
		const sourceFiles = await collectSources();
		const offenders = sourceFiles.filter((file) => /^import[^(]*["']drizzle-kit/m.test(file.text));
		expect(offenders.map((file) => file.path)).toEqual([]);
	});
});

async function collectSources(): Promise<readonly { path: string; text: string }[]> {
	const { readdir, readFile } = await import("node:fs/promises");
	const { fileURLToPath } = await import("node:url");

	const root = fileURLToPath(new URL("../../src/", import.meta.url));
	const entries = await readdir(root, { recursive: true, withFileTypes: true });

	const files: { path: string; text: string }[] = [];
	for (const entry of entries) {
		if (!entry.isFile() || !entry.name.endsWith(".ts")) {
			continue;
		}
		const absolute = `${entry.parentPath}/${entry.name}`;
		files.push({
			// `root` ends in a slash and `parentPath` does not repeat it, so the slice
			// leaves a leading separator on nested files; strip it so the path reads
			// `store/watcher.ts` rather than `/store/watcher.ts`.
			path: absolute.slice(root.length).replace(/^\/+/, ""),
			text: await readFile(absolute, "utf8"),
		});
	}
	return files;
}
