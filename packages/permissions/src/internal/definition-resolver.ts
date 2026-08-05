import { ModuleRef } from "@nestjs/core";
import type { FactoryProvider, InjectionToken, Type } from "@nestjs/common";

import type { ProviderDefinition } from "../interfaces/permissions-module-options.interface.ts";

/** The `{ useClass }` arm of a {@link ProviderDefinition}. */
export interface UseClassArm<T> {
	readonly useClass: Type<T>;
}

/** The `{ useExisting }` arm of a {@link ProviderDefinition}. */
export interface UseExistingArm {
	readonly useExisting: InjectionToken;
}

/** The `{ useFactory }` arm of a {@link ProviderDefinition}. */
export interface UseFactoryArm<T> {
	readonly useFactory: (...args: never[]) => T | Promise<T>;
	readonly inject?: readonly InjectionToken[];
}

/** Any of the three provider-shaped arms. */
export type ProviderArm<T> = UseClassArm<T> | UseExistingArm | UseFactoryArm<T>;

/** Statically wired provider-definition dependencies, keyed by their Nest token. */
export type ProviderDefinitionDependencies = ReadonlyMap<InjectionToken, unknown>;

/** Initialization barrier for a statically configured policy store definition. */
export const POLICY_STORE_DEFINITION_DEPENDENCIES_READY = Symbol(
	"POLICY_STORE_DEFINITION_DEPENDENCIES_READY",
);

/** Initialization barrier for a statically configured principal resolver definition. */
export const PRINCIPAL_RESOLVER_DEFINITION_DEPENDENCIES_READY = Symbol(
	"PRINCIPAL_RESOLVER_DEFINITION_DEPENDENCIES_READY",
);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/**
 * Whether `definition` is a provider definition rather than a ready instance.
 *
 * The discriminator is the presence of one of the three keys, which is why a
 * `PolicyStore` implementation must not have a member called `useClass`,
 * `useExisting` or `useFactory` — none of the SPI's do, and the union is the
 * shape every Nest module in the ecosystem uses.
 */
export function isProviderArm<T>(definition: ProviderDefinition<T>): definition is ProviderArm<T> {
	return (
		isRecord(definition) &&
		("useClass" in definition || "useExisting" in definition || "useFactory" in definition)
	);
}

/** Tokens a provider-shaped definition asks Nest to inject. */
function providerDependencyTokens<T>(
	definition: ProviderDefinition<T> | undefined,
): readonly InjectionToken[] {
	if (definition === undefined || !isProviderArm(definition)) {
		return [];
	}
	if ("useExisting" in definition) {
		return [definition.useExisting];
	}
	if ("useFactory" in definition) {
		return definition.inject ?? [];
	}
	return [];
}

/**
 * Builds the native Nest dependency edge for statically known definitions.
 *
 * Tokens are deliberately required. The module named in `forRoot({ imports })`
 * must export them, exactly as it would for any ordinary Nest consumer. Nest
 * then owns initialization ordering, error propagation and cycle detection;
 * the resulting map only carries those already-settled instances to the
 * definition resolver.
 */
export function createProviderDefinitionReadinessProvider(
	provide: InjectionToken,
	definition: ProviderDefinition<object> | undefined,
): FactoryProvider<ProviderDefinitionDependencies> {
	const tokens = [...new Set(providerDependencyTokens(definition))];

	return {
		provide,
		inject: tokens,
		useFactory: (...dependencies: unknown[]): ProviderDefinitionDependencies =>
			new Map(
				tokens.map((token, index): readonly [InjectionToken, unknown] => [
					token,
					dependencies[index],
				]),
			),
	};
}

function providerDependency(
	dependencies: ProviderDefinitionDependencies | undefined,
	token: InjectionToken,
	option: string,
): unknown {
	if (dependencies?.has(token) !== true) {
		throw new TypeError(
			`PermissionsModule: \`${option}\` requires a static provider dependency. ` +
				"Use `PermissionsModule.forRoot({ imports: [...] })` with a module that exports " +
				"the token. With `forRootAsync()`, resolve the instance in the outer options factory.",
		);
	}

	return dependencies.get(token);
}

/**
 * Resolves a {@link ProviderDefinition} against the container.
 *
 * `useClass` goes through `ModuleRef.create()` so the class participates in
 * constructor DI without having to be a registered provider. `useExisting`
 * and every `inject` token are supplied by the native dependency map created
 * for static `forRoot()` registrations.
 *
 * Runtime resolution rather than static providers is forced by the option
 * surface: `forRootAsync` produces its options *after* the module graph is
 * built, so there is no point at which the definition could be turned into
 * module metadata.
 */
export async function resolveProviderDefinition<T>(
	definition: ProviderDefinition<T>,
	moduleRef: ModuleRef,
	option: string,
	dependencies?: ProviderDefinitionDependencies,
): Promise<T> {
	if (!isProviderArm(definition)) {
		return definition;
	}

	if ("useClass" in definition) {
		return moduleRef.create(definition.useClass);
	}

	if ("useExisting" in definition) {
		// The injection token determines the value type at the caller's provider
		// definition boundary; Nest's InjectionToken itself cannot express that link.
		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see above
		return providerDependency(dependencies, definition.useExisting, `${option}.useExisting`) as T;
	}

	const injected = (definition.inject ?? []).map((token) =>
		providerDependency(dependencies, token, `${option}.useFactory.inject`),
	);

	// The factory's parameters are `never[]` so no caller can accidentally rely on
	// this package inferring them; the container is what actually types them.
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see above
	const factory = definition.useFactory as (...args: unknown[]) => T | Promise<T>;
	const resolved = await factory(...injected);

	if (resolved === undefined || resolved === null) {
		throw new TypeError(
			`PermissionsModule: \`${option}.useFactory\` resolved to ` +
				`${resolved === null ? "null" : "undefined"}.`,
		);
	}

	return resolved;
}
