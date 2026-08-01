import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		include: ["tests/**/*.test.ts"],
		pool: "forks",
		// `benchmark.include` does NOT inherit `test.include`; left unset it defaults
		// to `**/*.bench.ts`, which also matches `dist-tsc/tests/bench/*.bench.js`
		// once `tsc -b` has emitted there — every number would be reported twice,
		// once from source and once from a stale compiled copy.
		benchmark: { include: ["tests/**/*.bench.ts"] },
		testTimeout: 20_000,
		hookTimeout: 20_000,
		coverage: {
			provider: "v8",
			include: ["src/**/*.ts"],
		},
	},
});
