import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, renameSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";

import { assertFixedGroup, assertFixedVersions } from "./publish-state.mjs";

const expectedRef = "refs/heads/main";

if (
	process.env.GITHUB_ACTIONS !== "true" ||
	process.env.GITHUB_REF !== expectedRef ||
	typeof process.env.GITHUB_SHA !== "string"
) {
	throw new Error(`Publishing is restricted to GitHub Actions on ${expectedRef}`);
}

const gitStatus = spawnSync("git", ["status", "--porcelain"], {
	encoding: "utf8",
});

if (gitStatus.error) {
	throw new Error("Could not inspect the git worktree", {
		cause: gitStatus.error,
	});
}

if (gitStatus.status !== 0) {
	throw new Error(`git status exited with status ${gitStatus.status ?? "unknown"}`);
}

if (gitStatus.stdout.trim().length !== 0) {
	throw new Error("Refusing to publish from a dirty git worktree");
}

const headResult = spawnSync("git", ["rev-parse", "HEAD"], {
	encoding: "utf8",
});

if (headResult.error) {
	throw new Error("Could not resolve the git commit", {
		cause: headResult.error,
	});
}

if (headResult.status !== 0) {
	throw new Error(`git rev-parse exited with status ${headResult.status ?? "unknown"}`);
}

if (headResult.stdout.trim() !== process.env.GITHUB_SHA) {
	throw new Error("Git HEAD does not match the GitHub Actions commit");
}

const repositoryRoot = resolve(import.meta.dirname, "..");
const packagesRoot = join(repositoryRoot, "packages");

const workspacePackages = readdirSync(packagesRoot, { withFileTypes: true })
	.filter((entry) => entry.isDirectory())
	.map((entry) => join(packagesRoot, entry.name, "package.json"))
	.filter((manifestPath) => existsSync(manifestPath))
	.map((manifestPath) => JSON.parse(readFileSync(manifestPath, "utf8")))
	.filter((manifest) => manifest.private !== true)
	.map((manifest) => ({ name: manifest.name, version: manifest.version }));

const changesetConfig = JSON.parse(
	readFileSync(join(repositoryRoot, ".changeset", "config.json"), "utf8"),
);

assertFixedGroup(
	workspacePackages.map((entry) => entry.name),
	changesetConfig.fixed,
);

const preStateUrl = new URL("../.changeset/pre.json", import.meta.url);
const hiddenPreStateUrl = new URL("../.changeset/pre.json.publish", import.meta.url);
const preState = existsSync(preStateUrl)
	? JSON.parse(readFileSync(preStateUrl, "utf8"))
	: undefined;
const { tag: prereleaseTag } = assertFixedVersions(workspacePackages, preState);
const require = createRequire(import.meta.url);
const changesetsBin = require.resolve("@changesets/cli/bin.js");
const publishArguments = [changesetsBin, "publish"];

if (prereleaseTag !== undefined) {
	if (existsSync(hiddenPreStateUrl)) {
		throw new Error("Refusing to overwrite a hidden Changesets pre-state file");
	}

	publishArguments.push("--tag", prereleaseTag);
	renameSync(preStateUrl, hiddenPreStateUrl);
}

let publishResult;

try {
	// Changesets forces `latest` while a package has only prerelease history and
	// rejects an explicit tag in pre mode. The validated pre-state is hidden only
	// for this command so Changesets can publish to that same configured tag.
	publishResult = spawnSync(process.execPath, publishArguments, {
		stdio: "inherit",
	});
} finally {
	if (prereleaseTag !== undefined && existsSync(hiddenPreStateUrl)) {
		renameSync(hiddenPreStateUrl, preStateUrl);
	}
}

if (publishResult.error) {
	throw new Error("Could not start Changesets publish", {
		cause: publishResult.error,
	});
}

if (publishResult.signal !== null) {
	throw new Error(`Changesets publish terminated with ${publishResult.signal}`);
}

process.exitCode = publishResult.status ?? 1;
