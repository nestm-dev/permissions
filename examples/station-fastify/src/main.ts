import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter } from "@nestjs/platform-fastify";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";

import { AppModule } from "./app.module.ts";
import { USERS } from "./authorization/identity.ts";

/* oxlint-disable no-console -- this file is the example's console */

const PORT = Number(process.env.PORT ?? 3000);

/**
 * The fake auth layer.
 *
 * A Fastify `onRequest` hook, which is this adapter's middleware: it runs before
 * Nest's guards and stamps `request.user`, exactly as a real JWT or session guard
 * would. `@nestm/permissions` never imports an authentication library — it reads
 * one property, which is what makes better-auth, a plain JWT guard and a bespoke
 * identity all the same integration.
 *
 * **Ordering matters.** Whatever writes that property must run before
 * `PermissionsGuard`. A Fastify hook always does; two `APP_GUARD` providers
 * execute in registration order, so an auth *guard* must be registered first.
 */
function installFakeAuth(app: NestFastifyApplication): void {
	app
		.getHttpAdapter()
		.getInstance()
		.addHook("onRequest", (request, _reply, done) => {
			const header = request.headers["x-user"];
			const name = Array.isArray(header) ? header[0] : header;
			// Absent or unknown → no principal → 401 from the guard.
			Object.assign(request, { user: name === undefined ? undefined : USERS[name] });
			done();
		});
}

async function bootstrap(): Promise<void> {
	const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter());
	app.enableShutdownHooks();
	installFakeAuth(app);

	await app.listen({ port: PORT, host: "127.0.0.1" });

	console.log(`\n  station-fastify listening on http://127.0.0.1:${String(PORT)}\n`);
	console.log("  Try these — every line is a different part of the model:\n");
	for (const line of [
		["no auth at all → 401", `curl -i localhost:${String(PORT)}/runs`],
		[
			"alice holds the `reader` role, granted on `nightly` by a template link",
			`curl -s -H 'x-user: alice' localhost:${String(PORT)}/runs | jq`,
		],
		[
			"…and the plan is CONDITIONAL: run-3 is archived (forbid) and run-4 is another project",
			`curl -s -H 'x-user: alice' localhost:${String(PORT)}/runs/run-1 | jq`,
		],
		[
			"run-4 belongs to `release`, which alice was not granted → 403",
			`curl -i -H 'x-user: alice' localhost:${String(PORT)}/runs/run-4`,
		],
		[
			"a malformed id never reaches Cedar → 400, from the guard's parseAs",
			`curl -i -H 'x-user: alice' localhost:${String(PORT)}/runs/nope`,
		],
		[
			"mallory is a member with no roles → nothing is permitted → 403",
			`curl -i -H 'x-user: mallory' localhost:${String(PORT)}/runs`,
		],
		[
			"bob holds `admin`, so the literal-resource dispatch route allows",
			`curl -i -X POST -H 'x-user: bob' localhost:${String(PORT)}/runs/nightly/dispatch`,
		],
		[
			"…but alice does not → 403",
			`curl -i -X POST -H 'x-user: alice' localhost:${String(PORT)}/runs/nightly/dispatch`,
		],
		[
			"trudy belongs to another organization → 404, never 403",
			`curl -i -H 'x-user: trudy' localhost:${String(PORT)}/runs`,
		],
		[
			"@RequireAuthenticated(): a principal, no Cedar decision",
			`curl -s -H 'x-user: mallory' localhost:${String(PORT)}/runs/whoami/me | jq`,
		],
	]) {
		console.log(`  # ${line[0]}\n  ${line[1]}\n`);
	}
}

await bootstrap();
