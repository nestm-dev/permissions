import { defineConfig } from "tsdown";

// `@cedar-policy/cedar-wasm` must never be bundled: its nodejs build is CJS,
// instantiates the 4.1 MiB WASM synchronously at module scope, and reads its
// own `.wasm` file through `__dirname` + `require('fs')`.
export default defineConfig({
	entry: ["src/index.ts", "src/vocabulary.ts", "src/testing.ts", "src/plan.ts"],
	format: ["esm"],
	platform: "node",
	target: "node22",
	dts: true,
	sourcemap: true,
	clean: true,
	fixedExtension: true,
	// `deps.neverBundle` supersedes the deprecated `external` option; passing
	// both is a hard tsdown error.
	deps: { neverBundle: [/^@cedar-policy\//] },
});
