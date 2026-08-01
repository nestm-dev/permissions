import { Test } from "@nestjs/testing";
import type { INestApplication, ModuleMetadata, NestApplicationOptions } from "@nestjs/common";

import { PermissionsModule, type PermissionsForRootOptions } from "../../src/index.ts";
import { createTestHttpAdapter, initTestApplication } from "./http-adapter.ts";

export interface CreateTestAppOptions {
	forRoot: PermissionsForRootOptions;
	metadata?: ModuleMetadata;
	appOptions?: NestApplicationOptions;
	initialize?: boolean;
}

export async function createTestApp(options: CreateTestAppOptions): Promise<INestApplication> {
	const moduleRef = await Test.createTestingModule({
		imports: [PermissionsModule.forRoot(options.forRoot), ...(options.metadata?.imports ?? [])],
		controllers: options.metadata?.controllers ?? [],
		providers: options.metadata?.providers ?? [],
	}).compile();

	const app = moduleRef.createNestApplication(createTestHttpAdapter(), options.appOptions ?? {});
	app.enableShutdownHooks();
	if (options.initialize === false) {
		return app;
	}
	return initTestApplication(app);
}
