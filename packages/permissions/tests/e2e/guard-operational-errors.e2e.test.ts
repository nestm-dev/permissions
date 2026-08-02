import "reflect-metadata";
import { Controller, Get, Injectable, Module } from "@nestjs/common";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import type { INestApplication } from "@nestjs/common";
import type {
	PolicyBundle,
	PolicyRecord,
	PolicyScopeId,
	PolicyStore,
	TemplateLinkRecord,
	EntityGraph,
} from "@nestm/permissions-core";

import {
	EntityProvider,
	RequirePermission,
	type FeatureEntityProvider,
	type PermissionsDenial,
} from "../../src/index.ts";
import { createTestApp } from "../shared/test-app.ts";
import { testHttpAdapter } from "../shared/http-adapter.ts";
import { HeaderPrincipalResolver, USER_HEADER } from "../shared/test-principal.ts";
import { IDS, SEED_POLICIES, TEST_SCOPE, testVocabulary } from "../shared/test-vocabulary.ts";

/** The engine wraps these failures as a POLICY_STORE PermissionsError. */
class OfflinePolicyStore implements PolicyStore {
	async load(): Promise<PolicyBundle> {
		throw new Error("database unavailable during load");
	}

	async currentVersion(): Promise<string> {
		throw new Error("database unavailable during version read");
	}

	async save(_policies: readonly PolicyRecord[]): Promise<void> {
		throw new Error("database unavailable during save");
	}

	async delete(_scope: PolicyScopeId, _ids: readonly string[]): Promise<void> {
		throw new Error("database unavailable during delete");
	}

	async linkTemplate(_link: TemplateLinkRecord): Promise<void> {
		throw new Error("database unavailable during link");
	}

	async unlinkTemplate(_scope: PolicyScopeId, _linkId: string): Promise<void> {
		throw new Error("database unavailable during unlink");
	}
}

@Controller("operational-failure")
class OperationalFailureController {
	@Get()
	@RequirePermission("run:read", { kind: "literal", type: "Run", id: IDS.run })
	get(): { ok: true } {
		return { ok: true };
	}
}

@EntityProvider()
@Injectable()
class BrokenEntityProvider implements FeatureEntityProvider {
	resolveResource(): EntityGraph {
		throw new Error("entity database unavailable");
	}
}

@Module({ providers: [BrokenEntityProvider], exports: [BrokenEntityProvider] })
class BrokenEntityModule {}

let app: INestApplication | undefined;

afterEach(async () => {
	await app?.close();
	app = undefined;
});

describe(`guard operational failures (${testHttpAdapter})`, () => {
	it("answers 503 and audits engine-unavailable when a foreground store read fails", async () => {
		const denials: PermissionsDenial[] = [];
		app = await createTestApp({
			forRoot: {
				vocabulary: testVocabulary,
				store: new OfflinePolicyStore(),
				principalResolver: new HeaderPrincipalResolver(),
				scopeResolver: () => TEST_SCOPE,
				hooks: {
					onDecision: (record) => {
						if (record.denial !== undefined) {
							denials.push(record.denial);
						}
					},
				},
			},
			metadata: { controllers: [OperationalFailureController] },
			appOptions: { logger: false },
		});

		const response = await request(app.getHttpServer())
			.get("/operational-failure")
			.set(USER_HEADER, IDS.member)
			.expect(503);

		expect(response.body).toMatchObject({
			message: expect.stringContaining("authorization engine") as unknown,
			statusCode: 503,
		});
		expect(denials).toEqual([{ reason: "engine-unavailable" }]);
	});

	it("answers 503 and audits engine-unavailable when an entity provider fails", async () => {
		const denials: PermissionsDenial[] = [];
		app = await createTestApp({
			forRoot: {
				vocabulary: testVocabulary,
				policies: SEED_POLICIES,
				principalResolver: new HeaderPrincipalResolver(),
				scopeResolver: () => TEST_SCOPE,
				hooks: {
					onDecision: (record) => {
						if (record.denial !== undefined) {
							denials.push(record.denial);
						}
					},
				},
			},
			metadata: {
				imports: [BrokenEntityModule],
				controllers: [OperationalFailureController],
			},
			appOptions: { logger: false },
		});

		await request(app.getHttpServer())
			.get("/operational-failure")
			.set(USER_HEADER, IDS.member)
			.expect(503);

		expect(denials).toEqual([{ reason: "engine-unavailable" }]);
	});
});
