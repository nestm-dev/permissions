import { Injectable, Logger } from "@nestjs/common";
import { DiscoveryService } from "@nestjs/core";
import type { InstanceWrapper } from "@nestjs/core/injector/instance-wrapper.js";

import {
	EntityProvider,
	type EntityProviderOptions,
} from "../decorators/entity-provider.decorator.ts";
import {
	EntityProviderRegistry,
	type AnyFeatureEntityProvider,
} from "./entity-provider.registry.ts";

/**
 * Scans the whole container for `@EntityProvider()` provider classes and
 * registers their instances in the {@link EntityProviderRegistry}. Runs once
 * from `PermissionsModule.onModuleInit`.
 *
 * Container-wide rather than per-module on purpose: an entity provider declared
 * in a feature module's own `providers` array must behave exactly like one
 * passed to `PermissionsModule.forFeature()`.
 */
@Injectable()
export class EntityProviderDiscoveryService {
	private readonly logger = new Logger(EntityProviderDiscoveryService.name);

	constructor(
		private readonly discovery: DiscoveryService,
		private readonly registry: EntityProviderRegistry,
	) {}

	scan(): void {
		for (const wrapper of this.discovery.getProviders({ metadataKey: EntityProvider.KEY })) {
			const metatype = wrapper.metatype;
			if (!metatype) {
				continue;
			}

			// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- `getMetadata` is `any`; the decorator is what writes this value
			const options = Reflect.getMetadata(EntityProvider.KEY, metatype) as
				EntityProviderOptions | undefined;
			if (options === undefined) {
				continue;
			}

			const instance = this.resolveInstance(wrapper, metatype.name);
			this.registry.register(instance, { name: metatype.name, order: options.order ?? 0 });
		}

		this.logger.log(
			`Registered ${String(this.registry.size)} entity provider(s): ` +
				`${this.registry.registrations.map((registration) => registration.name).join(", ") || "none"}.`,
		);
	}

	private resolveInstance(wrapper: InstanceWrapper, name: string): AnyFeatureEntityProvider {
		const instance: unknown = wrapper.instance;
		if (instance !== null && typeof instance === "object") {
			return instance;
		}
		throw new Error(
			`Entity provider '${name}' could not be instantiated statically. @EntityProvider() ` +
				"classes must be singleton-scoped (no request/transient scope).",
		);
	}
}
