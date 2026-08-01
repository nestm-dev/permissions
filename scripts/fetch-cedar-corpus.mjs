#!/usr/bin/env node
/**
 * Fetches the Cedar integration-test corpus into
 * packages/permissions-core/references/cedar-corpus at the pinned commit.
 *
 * references/ is gitignored, so the corpus is a build-time fetch. The
 * conformance suite fails loudly when it is absent — this script is what CI
 * and fresh checkouts run before `pnpm run test`. Idempotent: a corpus already
 * at the pinned commit with the generated cases extracted is left untouched.
 */
import { execFileSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PINNED_COMMIT = "75989795c75d861270ce6cac38ef9d9e5b220a0c";
const REPO_URL = "https://github.com/cedar-policy/cedar-integration-tests";

const repoRoot = path.dirname(fileURLToPath(new URL("./", import.meta.url)));
const corpusDir = path.join(repoRoot, "packages", "permissions-core", "references", "cedar-corpus");

function git(args, options = {}) {
	return execFileSync("git", args, { encoding: "utf8", ...options }).trim();
}

function currentCommit() {
	try {
		return git(["-C", corpusDir, "rev-parse", "HEAD"]);
	} catch {
		return undefined;
	}
}

const extracted = existsSync(path.join(corpusDir, "corpus-tests"));
if (currentCommit() === PINNED_COMMIT && extracted) {
	console.log(`cedar-corpus already at ${PINNED_COMMIT.slice(0, 8)} with corpus-tests/ extracted.`);
	process.exit(0);
}

if (existsSync(corpusDir)) {
	console.log("cedar-corpus present but stale or incomplete — refetching.");
	rmSync(corpusDir, { recursive: true, force: true });
}

console.log(`Fetching ${REPO_URL} @ ${PINNED_COMMIT.slice(0, 8)} …`);
git(["init", "--quiet", corpusDir]);
git(["-C", corpusDir, "remote", "add", "origin", REPO_URL]);
git(["-C", corpusDir, "fetch", "--quiet", "--depth", "1", "origin", PINNED_COMMIT]);
git(["-C", corpusDir, "checkout", "--quiet", "FETCH_HEAD"]);

console.log("Extracting corpus-tests.tar.gz …");
execFileSync("tar", ["xzf", "corpus-tests.tar.gz"], { cwd: corpusDir });

console.log(`cedar-corpus ready at ${PINNED_COMMIT.slice(0, 8)}.`);
