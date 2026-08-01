import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(import.meta.dirname, "..");

export const CORE_PACKAGE_DIRECTORY = join(repositoryRoot, "packages", "permissions-core");

// `@nestm/permissions-core` must stay importable in a process with zero
// `@nestjs/*` packages installed: the ORM drivers depend on it, and so does any
// non-Nest consumer. This is the static half of the guarantee; the CI job
// `core-framework-free` is the black-box half (packs the tarball, installs it in
// a bare directory, imports it).
const frameworkPattern = /@nestjs\//;
const dependencyFields = [
	"dependencies",
	"devDependencies",
	"peerDependencies",
	"optionalDependencies",
];
const sourceExtensions = [".ts", ".mts", ".cts", ".tsx", ".js", ".mjs", ".cjs"];

/**
 * @param {string} source
 * @returns {Array<{ line: number, text: string }>}
 */
export function findFrameworkReferences(source) {
	if (typeof source !== "string") {
		throw new TypeError("findFrameworkReferences requires a string source");
	}

	const references = [];

	for (const [index, line] of source.split(/\r?\n/).entries()) {
		if (frameworkPattern.test(line)) {
			references.push({ line: index + 1, text: line.trim() });
		}
	}

	return references;
}

/**
 * @param {Record<string, unknown>} manifest
 * @returns {string[]} `field.name` entries, e.g. `peerDependencies.@nestjs/common`
 */
export function findFrameworkDependencies(manifest) {
	if (manifest === null || typeof manifest !== "object") {
		throw new TypeError("findFrameworkDependencies requires a package manifest object");
	}

	const found = [];

	for (const field of dependencyFields) {
		const record = manifest[field];

		if (record === null || typeof record !== "object") {
			continue;
		}

		for (const name of Object.keys(record)) {
			if (name === "@nestjs" || name.startsWith("@nestjs/")) {
				found.push(`${field}.${name}`);
			}
		}
	}

	return found;
}

/**
 * @param {string} directory
 * @returns {string[]} absolute paths of source files
 */
export function collectSourceFiles(directory) {
	const files = [];
	const entries = readdirSync(directory, { withFileTypes: true }).toSorted((left, right) =>
		left.name.localeCompare(right.name),
	);

	for (const entry of entries) {
		const target = join(directory, entry.name);

		if (entry.isDirectory()) {
			files.push(...collectSourceFiles(target));
			continue;
		}

		if (sourceExtensions.some((extension) => entry.name.endsWith(extension))) {
			files.push(target);
		}
	}

	return files;
}

/**
 * @param {string} [packageDirectory]
 * @returns {{ checkedFiles: number }}
 */
export function assertCoreFrameworkFree(packageDirectory = CORE_PACKAGE_DIRECTORY) {
	const manifest = JSON.parse(readFileSync(join(packageDirectory, "package.json"), "utf8"));
	const problems = findFrameworkDependencies(manifest).map(
		(entry) => `package.json declares ${entry}`,
	);

	const sourceFiles = collectSourceFiles(join(packageDirectory, "src"));

	for (const file of sourceFiles) {
		for (const reference of findFrameworkReferences(readFileSync(file, "utf8"))) {
			problems.push(`${relative(repositoryRoot, file)}:${reference.line}: ${reference.text}`);
		}
	}

	if (problems.length > 0) {
		throw new Error(
			`${manifest.name} must stay framework-free (zero @nestjs/*):\n  ${problems.join("\n  ")}`,
		);
	}

	return { checkedFiles: sourceFiles.length };
}

const entryPoint = process.argv[1];
const invokedDirectly =
	typeof entryPoint === "string" && resolve(entryPoint) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
	const { checkedFiles } = assertCoreFrameworkFree();

	console.log(
		`@nestm/permissions-core is framework-free (${checkedFiles} source file(s) checked).`,
	);
}
