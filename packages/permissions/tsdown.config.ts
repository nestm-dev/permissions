import { defineConfig } from "tsdown";

// Never switch to an esbuild-based bundler: it drops `design:paramtypes`
// silently and every constructor injection in this package stops resolving.
// CI greps the built barrel for that metadata.
export default defineConfig({
	entry: ["src/index.ts"],
	format: ["esm"],
	platform: "node",
	target: "node22",
	dts: true,
	sourcemap: true,
	clean: true,
	fixedExtension: true,
	deps: {
		neverBundle: [/^@nestjs\//, /^@nestm\//, "reflect-metadata", "rxjs"],
	},
});
