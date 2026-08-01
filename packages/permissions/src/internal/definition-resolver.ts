import type { InjectionToken, Type } from "@nestjs/common";
import type { ModuleRef } from "@nestjs/core";

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
		// `InjectionToken` is wider than every `get` overload accepts; Nest resolves
		// any of its arms identically at runtime.
		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see above
		return moduleRef.get<T>(definition.useExisting as Type<T>, { strict: false });
	}

	const dependencies = (definition.inject ?? []).map((token) =>
		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- as above
		moduleRef.get<unknown>(token as Type<unknown>, { strict: false }),
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
