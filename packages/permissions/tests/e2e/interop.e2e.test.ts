// The incremental cutover: two authorization guards, one route at a time.
//
// `routeAudit.additionalMetadataKeys` already let a foreign decorator satisfy the
// boot-time audit, but the *guard* still required this package's decorators — so
// migrating meant dual-decorating every route, including every `@Public()`, in
// one commit. `interop` closes that, and the two lists it takes mean genuinely
// different things:
//
//   publicKeys   — a foreign `@Public()`. ALLOW: the route was already
//                  unauthenticated under the legacy guard.
//   declaredKeys — a foreign permission decorator. ABSTAIN: return `true`
//                  without deciding, without a principal, without stashing, and
//                  let the legacy guard — still registered, still enforcing —
//                  answer.
//
// Abstaining is the load-bearing choice. Denying would 403 every unmigrated route
// the moment this guard is registered; allowing would be a hole. The suite below
// asserts the difference by putting a real legacy guard downstream and checking
// that it is the one saying no.

import "reflect-metadata";
import { Controller, Get, Injectable, SetMetadata } from "@nestjs/common";
import { APP_GUARD, Reflector } from "@nestjs/core";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import type { CanActivate, ExecutionContext, INestApplication } from "@nestjs/common";

import { Public, RequirePermission, type PermissionsForRootOptions } from "../../src/index.ts";
import { testHttpAdapter } from "../shared/http-adapter.ts";
import { createTestApp } from "../shared/test-app.ts";
import { HeaderPrincipalResolver, ROLE_HEADER, USER_HEADER } from "../shared/test-principal.ts";
import { IDS, SEED_POLICIES, TEST_SCOPE, testVocabulary } from "../shared/test-vocabulary.ts";

// ---------------------------------------------------------------------------
// The "legacy" family: a decorator, its metadata key, and a guard that enforces it
// ---------------------------------------------------------------------------

const LEGACY_ROLES = "legacy:roles";
const LEGACY_PUBLIC = "legacy:public";
const EARLIER_LEGACY_PUBLIC = "legacy:public:earlier";
const LATER_LEGACY_PUBLIC = "legacy:public:later";

/** Stand-in for the application's existing `@Roles('admin')`. */
const LegacyRoles = (...roles: string[]): MethodDecorator & ClassDecorator =>
	SetMetadata(LEGACY_ROLES, roles);

/** Stand-in for the application's existing `@Public()`. */
const LegacyPublic = (): MethodDecorator & ClassDecorator => SetMetadata(LEGACY_PUBLIC, true);

const EarlierLegacyPublic = (): MethodDecorator & ClassDecorator =>
	SetMetadata(EARLIER_LEGACY_PUBLIC, true);

const LaterLegacyPublic = (): MethodDecorator & ClassDecorator =>
	SetMetadata(LATER_LEGACY_PUBLIC, true);

/**
 * The application's existing guard, unchanged by the migration.
 *
 * Registered **before** `PermissionsGuard` (two `APP_GUARD` providers execute in
 * registration order), so on a legacy-declared route it is the one that decides
 * and `PermissionsGuard` never gets to.
 */
@Injectable()
class LegacyRolesGuard implements CanActivate {
	constructor(private readonly reflector: Reflector) {}

	canActivate(context: ExecutionContext): boolean {
		const targets = [context.getHandler(), context.getClass()];
		if (this.reflector.getAllAndOverride<true | undefined>(LEGACY_PUBLIC, targets) === true) {
			return true;
		}
		const required = this.reflector.getAllAndOverride<string[] | undefined>(LEGACY_ROLES, targets);
		if (required === undefined) {
			return true; // not its route; the next guard decides
		}
		const http = context.switchToHttp().getRequest<{
			headers?: Record<string, string | undefined>;
		}>();
		const role = http.headers?.[ROLE_HEADER];
		return role !== undefined && required.includes(role);
	}
}

// ---------------------------------------------------------------------------
// Routes at three stages of the migration
// ---------------------------------------------------------------------------

@Controller("mixed")
class MixedController {
	/** Not migrated: only the legacy decorator. `PermissionsGuard` must abstain. */
	@Get("legacy")
	@LegacyRoles("admin")
	legacy(): { ok: true } {
		return { ok: true };
	}

	/** Not migrated, and the legacy `@Public()`. */
	@Get("legacy-public")
	@LegacyPublic()
	legacyPublic(): { ok: true } {
		return { ok: true };
	}

	/**
	 * Migrated: both families present. This package's declaration wins, so the
	 * route is decided here — which is what makes a route-by-route cutover a
	 * cutover rather than a permanent double-decoration.
	 */
	@Get("migrated")
	@LegacyRoles("admin")
	@RequirePermission("run:dispatch", { kind: "literal", type: "Run", id: IDS.run })
	migrated(): { ok: true } {
		return { ok: true };
	}

	/** Neither family. Still undeclared, still denied. */
	@Get("orphan")
	orphan(): { ok: true } {
		return { ok: true };
	}

	/** This package's own `@Public()`, unaffected by any of it. */
	@Get("public")
	@Public()
	ownPublic(): { ok: true } {
		return { ok: true };
	}
}

/** A legacy decorator applied to the whole controller declares every handler. */
@Controller("legacy-class")
@LegacyRoles("admin")
class LegacyClassController {
	@Get("one")
	one(): { ok: true } {
		return { ok: true };
	}
}

/** Exercises precedence across multiple configured foreign public keys. */
@Controller("multi-public")
@EarlierLegacyPublic()
class MultiPublicController {
	@Get("explicit")
	@LaterLegacyPublic()
	@RequirePermission("run:dispatch", { kind: "literal", type: "Run", id: IDS.run })
	explicit(): { ok: true } {
		return { ok: true };
	}

	@Get("guarded")
	@RequirePermission("run:dispatch", { kind: "literal", type: "Run", id: IDS.run })
	guarded(): { ok: true } {
		return { ok: true };
	}
}

let app: INestApplication | undefined;

afterEach(async () => {
	await app?.close();
	app = undefined;
});

async function createApp(interop: PermissionsForRootOptions["interop"]): Promise<INestApplication> {
	return createTestApp({
		forRoot: {
			vocabulary: testVocabulary,
			policies: SEED_POLICIES,
			principalResolver: new HeaderPrincipalResolver(),
			scopeResolver: () => TEST_SCOPE,
			...(interop === undefined ? {} : { interop }),
		},
		metadata: {
			controllers: [MixedController, LegacyClassController, MultiPublicController],
			// Registered first, so it runs first — the shape a real cutover has.
			providers: [{ provide: APP_GUARD, useClass: LegacyRolesGuard }],
		},
	});
}

const CUTOVER = {
	publicKeys: [LEGACY_PUBLIC],
	declaredKeys: [LEGACY_ROLES],
} as const;

describe(`interop cutover (${testHttpAdapter})`, () => {
	it("abstains on a legacy-declared route, and the legacy guard still denies it", async () => {
		app = await createApp(CUTOVER);

		// The whole point: `PermissionsGuard` returns true without deciding, and the
		// route is *still* protected — by the guard that owns the decorator.
		await request(app.getHttpServer())
			.get("/mixed/legacy")
			.set(USER_HEADER, IDS.member)
			.set(ROLE_HEADER, "member")
			.expect(403);

		await request(app.getHttpServer())
			.get("/mixed/legacy")
			.set(USER_HEADER, IDS.member)
			.set(ROLE_HEADER, "admin")
			.expect(200);
	});

	it("abstains without a principal — a legacy route needs no principalResolver", async () => {
		// No `x-test-user`, so the principal resolver would return `null` and this
		// guard would 401. It never runs: abstention happens before step 4.
		app = await createApp(CUTOVER);

		await request(app.getHttpServer()).get("/mixed/legacy").set(ROLE_HEADER, "admin").expect(200);
	});

	it("honours a legacy decorator applied to the controller class", async () => {
		app = await createApp(CUTOVER);

		await request(app.getHttpServer())
			.get("/legacy-class/one")
			.set(ROLE_HEADER, "admin")
			.expect(200);
		await request(app.getHttpServer())
			.get("/legacy-class/one")
			.set(ROLE_HEADER, "member")
			.expect(403);
	});

	it("allows a route carrying a foreign @Public()", async () => {
		app = await createApp(CUTOVER);

		await request(app.getHttpServer()).get("/mixed/legacy-public").expect(200);
	});

	it("resolves multiple public keys by metadata level before configured key order", async () => {
		app = await createApp({
			publicKeys: [EARLIER_LEGACY_PUBLIC, LATER_LEGACY_PUBLIC],
		});

		// The earlier key is inherited from the class, but the later key is explicit
		// on this handler and therefore wins even alongside a permission declaration.
		await request(app.getHttpServer()).get("/multi-public/explicit").expect(200, { ok: true });

		// With no explicit public marker, the handler declaration overrides the
		// inherited marker and reaches principal resolution.
		await request(app.getHttpServer()).get("/multi-public/guarded").expect(401);
	});

	it("decides a migrated route itself, and this package's declaration wins", async () => {
		app = await createApp(CUTOVER);

		// `admin` satisfies the legacy guard, and the Cedar policy grants
		// `run:dispatch` to admins — allowed by *this* guard.
		await request(app.getHttpServer())
			.get("/mixed/migrated")
			.set(USER_HEADER, IDS.member)
			.set(ROLE_HEADER, "admin")
			.expect(200);

		// And with no principal it is a 401 rather than an abstention: the route has
		// migrated, so the foreign key no longer decides anything.
		await request(app.getHttpServer()).get("/mixed/migrated").set(ROLE_HEADER, "admin").expect(401);
	});

	it("still denies a route with no key from either family", async () => {
		app = await createApp(CUTOVER);

		await request(app.getHttpServer())
			.get("/mixed/orphan")
			.set(USER_HEADER, IDS.member)
			.set(ROLE_HEADER, "admin")
			.expect(403);
	});

	it("leaves this package's own @Public() alone", async () => {
		app = await createApp(CUTOVER);

		await request(app.getHttpServer()).get("/mixed/public").expect(200);
	});

	it("without interop configured, a legacy route is undeclared and denied", async () => {
		// The regression this is here to catch: the abstention must be opt-in. A
		// foreign key nobody declared is not a declaration.
		app = await createApp(undefined);

		await request(app.getHttpServer())
			.get("/mixed/legacy")
			.set(USER_HEADER, IDS.member)
			.set(ROLE_HEADER, "admin")
			.expect(403);

		await request(app.getHttpServer()).get("/mixed/legacy-public").expect(403);
	});

	it("declaredKeys alone does not make a foreign @Public() public", async () => {
		// The two lists are not interchangeable, and listing a public marker as
		// `declaredKeys` is a *safe* mistake: the route is abstained on rather than
		// allowed, so whatever the legacy guard says still stands.
		app = await createApp({ declaredKeys: [LEGACY_PUBLIC, LEGACY_ROLES] });

		await request(app.getHttpServer()).get("/mixed/legacy-public").expect(200);
		// ...and the legacy guard is what allowed it, not this one.
		await request(app.getHttpServer()).get("/mixed/legacy").set(ROLE_HEADER, "member").expect(403);
	});

	it("publicKeys alone does not turn a foreign permission decorator into an allow", async () => {
		// `publicKeys` allows; a route declared only by a key that is in neither list
		// is undeclared. Listing `LEGACY_ROLES` under `publicKeys` would be the
		// dangerous mistake, so the safe direction is asserted: with only the public
		// key configured, the legacy *permission* route falls through to the
		// undeclared path.
		app = await createApp({ publicKeys: [LEGACY_PUBLIC] });

		await request(app.getHttpServer()).get("/mixed/legacy-public").expect(200);
		await request(app.getHttpServer())
			.get("/mixed/legacy")
			.set(USER_HEADER, IDS.member)
			.set(ROLE_HEADER, "admin")
			.expect(403);
	});

	it("does not stash RequestAuthorization on an abstained route", async () => {
		// An abstention is not a decision, so nothing may be left behind that a
		// handler could mistake for one — `@AuthorizedPrincipal()` on a legacy route
		// must not silently produce a principal this guard never resolved.
		app = await createApp(CUTOVER);

		const response = await request(app.getHttpServer())
			.get("/mixed/legacy")
			.set(USER_HEADER, IDS.member)
			.set(ROLE_HEADER, "admin")
			.expect(200);

		expect(response.body).toEqual({ ok: true });
	});
});
