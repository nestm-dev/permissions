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

/** Internal barrier used to order statically known sibling dependencies. */
export const PROVIDER_DEFINITION_DEPENDENCIES_READY = Symbol(
	"PROVIDER_DEFINITION_DEPENDENCIES_READY",
);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/**
 * Resolves one token without assuming its sibling module has already finished
 * instantiating the provider.
 *
 * Nest's synchronous `get()` can observe a registered async factory before its
 * instance has been assigned. `resolve()` gives the container an asynchronous
 * resolution path for that same token. Keep the fast path for providers that
 * are already ready, then await the fallback only for a nullish observation.
 */
async function resolveToken<T>(moduleRef: ModuleRef, token: InjectionToken): Promise<T> {
	// `InjectionToken` is wider than every `get` / `resolve` overload accepts;
	// Nest resolves all of its arms identically at runtime.
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see above
	const nestToken = token as Type<T>;
	const existing = moduleRef.get<T>(nestToken, { strict: false });
	if (existing !== undefined && existing !== null) {
		return existing;
	}

	return moduleRef.resolve<T>(nestToken, undefined, { strict: false });
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
 * Builds an internal provider that makes Nest order visible sibling factories
 * before this module resolves definitions through `ModuleRef`.
 *
 * Every dependency is optional on purpose. A global/exported sibling creates a
 * real graph edge and is awaited. A non-global sibling remains invisible to
 * normal injection, so the barrier receives `undefined` and the existing
 * non-strict `ModuleRef` lookup remains the compatibility fallback.
 */
export function createProviderDefinitionReadinessProvider(
	definitions: readonly (ProviderDefinition<object> | undefined)[],
): FactoryProvider<true> {
	const tokens = [
		...new Set(definitions.flatMap((definition) => providerDependencyTokens(definition))),
	];

	return {
		provide: PROVIDER_DEFINITION_DEPENDENCIES_READY,
		inject: tokens.map((token) => ({ token, optional: true })),
		useFactory: (..._dependencies: unknown[]): true => true,
	};
}

/**
 * Resolves a {@link ProviderDefinition} against the container.
 *
 * `useClass` goes through `ModuleRef.create()` so the class participates in
 * constructor DI without having to be a registered provider; `useExisting` and
 * every `inject` token are looked up with `strict: false`, so a store or
 * resolver exported by a sibling module resolves.
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
): Promise<T> {
	if (!isProviderArm(definition)) {
		return definition;
	}

	if ("useClass" in definition) {
		return moduleRef.create(definition.useClass);
	}

	if ("useExisting" in definition) {
		return resolveToken<T>(moduleRef, definition.useExisting);
	}

	const dependencies = await Promise.all(
		(definition.inject ?? []).map((token) => resolveToken<unknown>(moduleRef, token)),
	);

	// The factory's parameters are `never[]` so no caller can accidentally rely on
	// this package inferring them; the container is what actually types them.
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see above
	const factory = definition.useFactory as (...args: unknown[]) => T | Promise<T>;
	const resolved = await factory(...dependencies);

	if (resolved === undefined || resolved === null) {
		throw new TypeError(
			`PermissionsModule: \`${option}.useFactory\` resolved to ` +
				`${resolved === null ? "null" : "undefined"}.`,
		);
	}

	return resolved;
}
