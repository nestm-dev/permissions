import type { StandardSchemaV1 } from "@nestm/permissions";

/**
 * A [Standard Schema v1](https://standardschema.dev) validator, hand-written.
 *
 * Deliberately **not** Zod: the spec is a structural contract with no runtime, so
 * `parseAs` accepts anything shaped like this — Zod 3.24+, Valibot, ArkType, or
 * twenty lines like these. A real application passes the same branded id schema
 * its handlers and DTOs already use, and gets one definition of "a valid run id"
 * across the guard, the pipe and the type system.
 *
 * Why it matters here: **guards run before pipes.** Without `parseAs` the raw URL
 * segment becomes a Cedar entity id, so `/runs/%2e%2e%2f` is an authorization
 * question about an entity that cannot exist, rather than a 400.
 */
export const runIdSchema: StandardSchemaV1<unknown, string> = {
	"~standard": {
		version: 1,
		vendor: "station-example",
		validate: (value) =>
			typeof value === "string" && /^run-[0-9]+$/.test(value)
				? { value }
				: { issues: [{ message: 'A run id looks like "run-1".' }] },
	},
};
