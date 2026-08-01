import { defineConfig } from "tsdown";

export default defineConfig({
	entry: ["src/index.ts", "src/nestjs.ts", "src/schema.ts", "src/testing.ts"],
	format: ["esm"],
	platform: "node",
	target: "node22",
	dts: true,
	sourcemap: true,
	clean: true,
	fixedExtension: true,
	deps: {
		neverBundle: [/^@nestjs\//, /^@nestm\//, /^drizzle-orm(\/|$)/, /^drizzle-kit(\/|$)/],
	},
});
