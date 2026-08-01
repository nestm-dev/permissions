// The Standard Schema v1 contract, vendored as types.
//
// Deliberately not a dependency: the spec is a *structural* contract with no
// runtime, and every library implementing it (zod 3.24+, valibot, arktype, …)
// satisfies these declarations by shape. Depending on `@standard-schema/spec`
// would add a package to every consumer's tree to gain exactly nothing.
//
// Only the parts this package reads are declared. `types` is carried because
// implementations set it, and a structural check would otherwise reject a schema
// for having *more* than we asked for on an optional member.

/** The success arm of {@link StandardSchemaResult}. */
export interface StandardSchemaSuccess<Output> {
	readonly value: Output;
	readonly issues?: undefined;
}

/** One problem a schema found. `path` is the spec's loose union. */
export interface StandardSchemaIssue {
	readonly message: string;
	readonly path?: readonly (PropertyKey | { readonly key: PropertyKey })[] | undefined;
}

/** The failure arm of {@link StandardSchemaResult}. */
export interface StandardSchemaFailure {
	readonly issues: readonly StandardSchemaIssue[];
}

/** What `validate` resolves to. */
export type StandardSchemaResult<Output> = StandardSchemaSuccess<Output> | StandardSchemaFailure;

/** The `~standard` property every conforming schema carries. */
export interface StandardSchemaProps<Input, Output> {
	readonly version: 1;
	readonly vendor: string;
	readonly validate: (
		value: unknown,
	) => StandardSchemaResult<Output> | Promise<StandardSchemaResult<Output>>;
	readonly types?: { readonly input: Input; readonly output: Output } | undefined;
}

/**
 * A [Standard Schema v1](https://standardschema.dev) validator.
 *
 * Used by `@RequirePermission(..., { kind: "param", parseAs })` to validate a
 * route parameter **inside the guard**, which runs before pipes — so a Zod
 * branded id schema drops straight in:
 *
 * ```ts
 * @RequirePermission("run:read", {
 *   kind: "param", param: "runId", type: "Run", parseAs: runIdSchema,
 * })
 * ```
 */
export interface StandardSchemaV1<Input = unknown, Output = Input> {
	readonly "~standard": StandardSchemaProps<Input, Output>;
}

/** Whether `value` looks like a Standard Schema validator. */
export function isStandardSchema(value: unknown): value is StandardSchemaV1 {
	if (typeof value !== "object" || value === null) {
		return false;
	}
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- probing an unknown value is the point
	const props = (value as Record<string, unknown>)["~standard"];
	return (
		typeof props === "object" &&
		props !== null &&
		typeof (props as StandardSchemaProps<unknown, unknown>).validate === "function"
	);
}
