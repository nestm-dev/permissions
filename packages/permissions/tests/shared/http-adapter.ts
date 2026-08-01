import { ExpressAdapter } from "@nestjs/platform-express";
import { FastifyAdapter } from "@nestjs/platform-fastify";
import type { INestApplication } from "@nestjs/common";

export const testHttpAdapter = process.env.TEST_HTTP_ADAPTER ?? "express";

export function createTestHttpAdapter(): ExpressAdapter | FastifyAdapter {
	return testHttpAdapter === "fastify" ? new FastifyAdapter() : new ExpressAdapter();
}

export async function initTestApplication<T extends INestApplication>(app: T): Promise<T> {
	await app.init();
	if (testHttpAdapter === "fastify") {
		await app.getHttpAdapter().getInstance().ready();
	}
	return app;
}
