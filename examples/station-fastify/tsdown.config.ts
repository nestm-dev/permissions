import { defineConfig } from "tsdown";

// Same bundler as the packages, for the same reason: an esbuild-based runner
// (tsx, ts-node/swc) silently drops `design:paramtypes`, and every constructor
// injection in a Nest app stops resolving. That is exactly the failure this
// example would otherwise demonstrate by accident.
export default defineConfig({
	entry: ["src/main.ts"],
	format: ["esm"],
	platform: "node",
	target: "node22",
	dts: false,
	sourcemap: true,
	clean: true,
	fixedExtension: true,
	deps: {
		neverBundle: [/^@nestjs\//, /^@nestm\//, /^fastify/, "reflect-metadata", "rxjs"],
	},
});
