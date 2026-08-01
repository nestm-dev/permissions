import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const coreSrc = (entry: string): string =>
	fileURLToPath(new URL(`../permissions-core/src/${entry}`, import.meta.url));

export default defineConfig({
	// Mirrors the `paths` mapping in tsconfig.base.json so the suites run against
	// core's *sources*. Resolving the published `exports` instead would test
	// whatever happens to be in core's `dist` — exactly the stale artefact a
	// workspace is supposed to make impossible.
	resolve: {
		alias: [
			{ find: /^@nestm\/permissions-core\/plan$/, replacement: coreSrc("plan.ts") },
			{ find: /^@nestm\/permissions-core\/testing$/, replacement: coreSrc("testing.ts") },
			{ find: /^@nestm\/permissions-core$/, replacement: coreSrc("index.ts") },
		],
	},
	test: {
		globals: true,
		environment: "node",
		include: ["tests/**/*.test.ts"],
		// Forks, not threads: the integration suites hold real Postgres connections
		// and the property suites load the Cedar WASM, neither of which is safe to
		// share across workers.
		pool: "forks",
		testTimeout: 120_000,
		hookTimeout: 120_000,
		coverage: {
			provider: "v8",
			include: ["src/**/*.ts"],
		},
	},
});
