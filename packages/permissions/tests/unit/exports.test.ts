import "reflect-metadata";
import { describe, expect, it } from "vitest";

import * as barrel from "../../src/index.ts";

const EXPECTED_VALUE_EXPORTS = [
	"ASYNC_OPTIONS_TYPE",
	"AUTHORIZATION_ENGINE",
	"AUTHORIZATION_STATE",
	"CurrentAuthorization",
	"CurrentPrincipal",
	"DEFAULT_PRINCIPAL_PROPERTY",
	"EntityProvider",
	"EntityProviderDiscoveryService",
	"EntityProviderRegistry",
	"FALLBACK_ROUTE_METADATA_KEYS",
	"METADATA_KEY",
	"MODULE_OPTIONS_TOKEN",
	"NOT_FOUND_DETAIL",
	"NOT_IN_SCOPE",
	"OPTIONS_TYPE",
	"PACKAGE_NAME",
	"PERMISSIONS_MODULE_OPTIONS",
	"POLICY_STORE",
	"PRINCIPAL_RESOLVER",
	"PermissionsFeatureModule",
	"PermissionsGuard",
	"PermissionsModule",
	"PermissionsService",
	"PolicySetManager",
	"Public",
	"QueryPlan",
	"RequestAuthorization",
	"RequestPrincipalResolver",
	"RequireAuthenticated",
	"RequirePermission",
	"ResourceParamError",
	"RouteAuthorizationAudit",
	"RoutePermissionConfigurationError",
	"assertEntityProviderClass",
	"createAuthorizationError",
	"inferResourceRef",
	"isNotInScope",
	"isResolvedPrincipal",
	"isStandardSchema",
	"loadRouteMetadataKeys",
	"parseRouteParam",
	"readAuthorization",
	"resolveResourceRef",
	"resolveScopeSource",
] as const;

describe("barrel exports", () => {
	it("exports PACKAGE_NAME", () => {
		expect(barrel.PACKAGE_NAME).toBe("@nestm/permissions");
	});

	it.each(EXPECTED_VALUE_EXPORTS)("exports %s", (name) => {
		expect(barrel).toHaveProperty(name);
	});

	it("exports nothing undeclared", () => {
		expect(Object.keys(barrel).toSorted()).toEqual([...EXPECTED_VALUE_EXPORTS].toSorted());
	});

	it("re-exports no runtime value from core", () => {
		// Types only (rule 1 of the barrel): a value slipping through would give an
		// app two ways to build the same engine, and two ways to hold one Cedar.
		for (const coreValue of [
			"createEngine",
			"defineVocabulary",
			"MemoryPolicyStore",
			"loadCedar",
		]) {
			expect(barrel).not.toHaveProperty(coreValue);
		}
	});

	it("exports QueryPlan as both a decorator and a type", () => {
		// One specifier, two declaration spaces — see the barrel's comment. The
		// value half is asserted here; the type half is asserted by this file
		// compiling under `tsc -b`.
		const plan: barrel.QueryPlan | undefined = undefined;
		expect(typeof barrel.QueryPlan).toBe("function");
		expect(plan).toBeUndefined();
	});
});

describe("decorator metadata", () => {
	// The same property CI greps out of dist/index.mjs, asserted at the source
	// level so a broken tsconfig fails fast in the unit suite too.
	it("emits design:paramtypes for injectable classes", () => {
		expect(Reflect.getMetadata("design:paramtypes", barrel.PermissionsGuard)).toHaveLength(6);
		expect(Reflect.getMetadata("design:paramtypes", barrel.PermissionsService)).toHaveLength(2);
		expect(
			Reflect.getMetadata("design:paramtypes", barrel.EntityProviderDiscoveryService),
		).toHaveLength(2);
		expect(Reflect.getMetadata("design:paramtypes", barrel.RouteAuthorizationAudit)).toHaveLength(
			4,
		);
	});
});
