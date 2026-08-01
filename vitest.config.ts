import { defineConfig } from "vitest/config";

// Workspace-root suite: the release/guard scripts under `scripts/`.
// Package suites live in `packages/*/vitest.config.ts`.
export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		include: ["scripts/**/*.spec.mjs"],
		pool: "forks",
		clearMocks: true,
		restoreMocks: true,
	},
});
