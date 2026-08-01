import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
	assertCoreFrameworkFree,
	collectSourceFiles,
	CORE_PACKAGE_DIRECTORY,
	findFrameworkDependencies,
	findFrameworkReferences,
} from "./assert-core-framework-free.mjs";

const temporaryDirectories = [];

function createFakePackage({ manifest, sources }) {
	const directory = mkdtempSync(join(tmpdir(), "permissions-core-guard-"));

	temporaryDirectories.push(directory);
	writeFileSync(join(directory, "package.json"), JSON.stringify(manifest));
	mkdirSync(join(directory, "src"), { recursive: true });

	for (const [name, contents] of Object.entries(sources)) {
		writeFileSync(join(directory, "src", name), contents);
	}

	return directory;
}

afterEach(() => {
	while (temporaryDirectories.length > 0) {
		rmSync(temporaryDirectories.pop(), { force: true, recursive: true });
	}
});

describe("findFrameworkReferences", () => {
	it("reports every line mentioning @nestjs/", () => {
		const source = ['import { Injectable } from "@nestjs/common";', "export const x = 1;"].join(
			"\n",
		);

		expect(findFrameworkReferences(source)).toEqual([
			{ line: 1, text: 'import { Injectable } from "@nestjs/common";' },
		]);
	});

	it("reports mentions in comments and type-only imports too", () => {
		const source = [
			"// TODO: accept an @nestjs/common Logger here",
			'import type { Type } from "@nestjs/common";',
		].join("\n");

		expect(findFrameworkReferences(source)).toHaveLength(2);
	});

	it("returns nothing for framework-free source", () => {
		expect(
			findFrameworkReferences('export const PACKAGE_NAME = "@nestm/permissions-core";'),
		).toEqual([]);
	});

	it("rejects a non-string source", () => {
		expect(() => findFrameworkReferences(undefined)).toThrow("requires a string source");
	});
});

describe("findFrameworkDependencies", () => {
	it("finds @nestjs entries in every dependency field", () => {
		expect(
			findFrameworkDependencies({
				dependencies: { "@cedar-policy/cedar-wasm": "4.12.0" },
				peerDependencies: { "@nestjs/common": "^12.0.0-alpha.5" },
				devDependencies: { "@nestjs/testing": "12.0.0-alpha.5" },
				optionalDependencies: { "@nestjs/core": "^12.0.0-alpha.5" },
			}),
		).toEqual([
			"devDependencies.@nestjs/testing",
			"peerDependencies.@nestjs/common",
			"optionalDependencies.@nestjs/core",
		]);
	});

	it("does not flag lookalike scopes", () => {
		expect(
			findFrameworkDependencies({
				dependencies: { "@nestjsx/crud": "5.0.0", nestjs: "1.0.0", "@nestm/permissions": "0.1.0" },
			}),
		).toEqual([]);
	});

	it("rejects a non-object manifest", () => {
		expect(() => findFrameworkDependencies(null)).toThrow("requires a package manifest object");
	});
});

describe("assertCoreFrameworkFree", () => {
	it("passes for the real @nestm/permissions-core package", () => {
		expect(() => assertCoreFrameworkFree()).not.toThrow();
		expect(assertCoreFrameworkFree(CORE_PACKAGE_DIRECTORY).checkedFiles).toBeGreaterThan(0);
	});

	it("fails when a source file imports the framework", () => {
		const directory = createFakePackage({
			manifest: { name: "@nestm/permissions-core", dependencies: {} },
			sources: { "index.ts": 'import { Injectable } from "@nestjs/common";\n' },
		});

		expect(() => assertCoreFrameworkFree(directory)).toThrow(/must stay framework-free/);
		expect(() => assertCoreFrameworkFree(directory)).toThrow(/index\.ts:1/);
	});

	it("fails when the manifest declares a framework peer", () => {
		const directory = createFakePackage({
			manifest: {
				name: "@nestm/permissions-core",
				peerDependencies: { "@nestjs/common": "^12.0.0-alpha.5" },
			},
			sources: { "index.ts": "export const ok = true;\n" },
		});

		expect(() => assertCoreFrameworkFree(directory)).toThrow(
			/package\.json declares peerDependencies\.@nestjs\/common/,
		);
	});

	it("passes for a framework-free fake package", () => {
		const directory = createFakePackage({
			manifest: {
				name: "@nestm/permissions-core",
				dependencies: { "@cedar-policy/cedar-wasm": "4.12.0" },
			},
			sources: { "index.ts": 'export const PACKAGE_NAME = "@nestm/permissions-core";\n' },
		});

		expect(assertCoreFrameworkFree(directory)).toEqual({ checkedFiles: 1 });
	});
});

describe("collectSourceFiles", () => {
	it("walks nested directories", () => {
		const directory = createFakePackage({
			manifest: { name: "@nestm/permissions-core" },
			sources: { "index.ts": "export const a = 1;\n", "notes.md": "ignored\n" },
		});

		mkdirSync(join(directory, "src", "plan"), { recursive: true });
		writeFileSync(join(directory, "src", "plan", "walk.ts"), "export const b = 2;\n");

		const sourceRoot = join(directory, "src");

		expect(collectSourceFiles(sourceRoot).map((file) => relative(sourceRoot, file))).toEqual([
			"index.ts",
			join("plan", "walk.ts"),
		]);
	});
});
