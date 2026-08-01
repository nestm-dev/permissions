const semverPrereleasePattern = /^[0-9]+\.[0-9]+\.[0-9]+-([0-9A-Za-z-]+)(?:[.+]|$)/;

const byName = (left, right) => left.localeCompare(right);

export function resolvePrereleaseTag(version, preState) {
	if (typeof version !== "string") {
		throw new TypeError("package.json requires a string version");
	}

	const prereleaseIdentifier = semverPrereleasePattern.exec(version)?.[1];

	if (preState?.mode === "pre") {
		if (typeof preState.tag !== "string" || preState.tag.length === 0) {
			throw new Error("Changesets prerelease mode requires a non-empty tag");
		}

		if (prereleaseIdentifier === undefined) {
			throw new Error(`Stable version ${version} cannot publish in Changesets pre mode`);
		}

		if (prereleaseIdentifier !== preState.tag) {
			throw new Error(
				`Version prerelease ${prereleaseIdentifier} does not match Changesets tag ${preState.tag}`,
			);
		}

		return preState.tag;
	}

	if (prereleaseIdentifier !== undefined) {
		throw new Error(`Prerelease version ${version} requires Changesets pre mode`);
	}

	return undefined;
}

/**
 * The four packages are versioned in Changesets `fixed` mode: one physical copy
 * of `@nestm/permissions-core` is a correctness requirement (Cedar's WASM caches
 * preparsed policy sets per module instance), and lockstep ranges are what make
 * pnpm/npm dedupe to one copy. A diverged version set means the fixed group was
 * broken somewhere between `changeset version` and publish — refuse, loudly.
 *
 * @param {ReadonlyArray<{ name: string, version: string }>} packages
 * @param {{ mode?: string, tag?: string } | undefined} preState
 * @returns {{ version: string, tag: string | undefined }}
 */
export function assertFixedVersions(packages, preState) {
	if (!Array.isArray(packages) || packages.length === 0) {
		throw new TypeError("assertFixedVersions requires at least one package");
	}

	const versions = new Map();

	for (const entry of packages) {
		if (typeof entry?.name !== "string" || entry.name.length === 0) {
			throw new TypeError("Every fixed-group package requires a string name");
		}

		if (typeof entry.version !== "string") {
			throw new TypeError(`package.json for ${entry.name} requires a string version`);
		}

		versions.set(entry.version, [...(versions.get(entry.version) ?? []), entry.name]);
	}

	if (versions.size !== 1) {
		const detail = [...versions.entries()]
			.map(([version, names]) => `${version} (${names.toSorted().join(", ")})`)
			.toSorted()
			.join(" vs ");

		throw new Error(`Refusing to publish diverged fixed-group versions: ${detail}`);
	}

	// Validate every package, not only the first: a package whose prerelease
	// identifier disagrees with .changeset/pre.json must fail here.
	let tag;

	for (const entry of packages) {
		tag = resolvePrereleaseTag(entry.version, preState);
	}

	const [version] = versions.keys();

	return { version, tag };
}

/**
 * Guards the other half of the invariant: every publishable workspace package
 * must be listed in exactly one Changesets `fixed` group. A package added to
 * `packages/` without being added to `.changeset/config.json` would otherwise
 * drift out of lockstep silently.
 *
 * @param {ReadonlyArray<string>} packageNames
 * @param {ReadonlyArray<ReadonlyArray<string>> | undefined} fixedGroups
 * @returns {ReadonlyArray<string>} the fixed group covering the packages
 */
export function assertFixedGroup(packageNames, fixedGroups) {
	if (!Array.isArray(packageNames) || packageNames.length === 0) {
		throw new TypeError("assertFixedGroup requires at least one package name");
	}

	if (!Array.isArray(fixedGroups) || fixedGroups.length !== 1 || !Array.isArray(fixedGroups[0])) {
		throw new Error("Changesets config must declare exactly one `fixed` group");
	}

	const declared = fixedGroups[0].toSorted(byName);
	const actual = packageNames.toSorted(byName);
	const missing = actual.filter((name) => !declared.includes(name));
	const unknown = declared.filter((name) => !actual.includes(name));

	if (missing.length > 0 || unknown.length > 0) {
		throw new Error(
			"Changesets `fixed` group does not match the workspace packages" +
				(missing.length > 0 ? `; missing: ${missing.join(", ")}` : "") +
				(unknown.length > 0 ? `; unknown: ${unknown.join(", ")}` : ""),
		);
	}

	return declared;
}
