import { existsSync, readdirSync, rmSync } from "node:fs";
import { basename, join, resolve, sep } from "node:path";

const repositoryRoot = resolve(import.meta.dirname, "..");

// Only these basenames may ever be removed. A malformed path (an empty
// variable, a stray `..`, a renamed package directory) is refused instead of
// deleting sources.
const removableNames = ["dist", "dist-tsc", "coverage"];

function removeBuildDirectory(target) {
	if (!target.startsWith(`${repositoryRoot}${sep}`)) {
		throw new Error(`Refusing to clean outside the repository: ${target}`);
	}

	if (!removableNames.includes(basename(target))) {
		throw new Error(`Refusing to clean unexpected path: ${target}`);
	}

	rmSync(target, { force: true, recursive: true });
}

const packagesRoot = join(repositoryRoot, "packages");
const packageDirectories = existsSync(packagesRoot)
	? readdirSync(packagesRoot, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => join(packagesRoot, entry.name))
	: [];

for (const directory of [repositoryRoot, ...packageDirectories]) {
	for (const name of removableNames) {
		removeBuildDirectory(join(directory, name));
	}
}
