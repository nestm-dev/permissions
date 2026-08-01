// The shared `PolicyStore` conformance suite.
//
// The `PolicyStore` SPI has four contracts that are cheap to state and easy to
// implement *almost* correctly, and every one of them fails as wrong
// authorization rather than as a crash:
//
//   D1  implementing `watch` is a promise that every write becomes an event; a
//       store that misses one serves stale decisions forever, because the cache
//       stops polling `currentVersion` entirely.
//   D2  `load(scope)` returns global (`''`) ∪ `scope` with a composite `g<n>:s<m>`
//       version, and an id present in both halves **throws** rather than letting
//       one half silently win.
//   D6  `TemplateLinkRecord.values` is partial: a template that only declares
//       `?principal` must be linkable without inventing a `?resource`.
//   —   nothing crossing the boundary may be shared with the caller, or a
//       consumer that mutates what it was handed corrupts the store's state.
//
// This suite is the contract. It runs against `MemoryPolicyStore` in this
// package's own tests — which is the suite's own conformance proof — and against
// the TypeORM and Drizzle stores in theirs.
//
// It is framework-agnostic the pragmatic way: `describe`/`it`/`expect` are
// injected, defaulting to the globals when a vitest/jest-style runner has
// installed them. Only `toBe` and `toEqual` are used, so the structural
// requirement on the injected `expect` stays small enough that any runner in the
// family satisfies it; everything else (throws, rejections, monotonicity) is
// asserted here so the suite does not depend on matcher spelling.

import { buildPolicySet } from "../policy/policy-set-builder.ts";
import {
	GLOBAL_POLICY_SCOPE,
	parsePolicyVersion,
	type PolicyChangeEvent,
	type PolicyRecord,
	type PolicyScopeId,
	type PolicyStore,
	type TemplateLinkRecord,
} from "../policy/policy-store.ts";
import {
	CONFORMANCE_SCOPES,
	FIXTURE_TIME,
	PERMIT_ALL,
	TEMPLATE_BOTH_SLOTS,
	TEMPLATE_PRINCIPAL_ONLY,
	policyRecordFixture,
	templateLinkFixture,
} from "./fixtures.ts";

// ---------------------------------------------------------------------------
// Runner seam
// ---------------------------------------------------------------------------

/** The slice of a vitest/jest assertion this suite uses. Deliberately two matchers. */
export interface ConformanceAssertion {
	toBe(expected: unknown): void;
	toEqual(expected: unknown): void;
}

/** `expect`, narrowed to what this suite needs. */
export type ConformanceExpect = (actual: unknown) => ConformanceAssertion;

/**
 * `describe`/`it`/`expect`, injected so the suite does not import a test runner.
 *
 * Declared as function-typed *properties* rather than as methods, because the
 * suite destructures them: a method signature would carry `this`, and a hook
 * called detached from its runner object is a scoping bug waiting to happen.
 */
export interface ConformanceHooks {
	readonly describe: (name: string, body: () => void) => void;
	readonly it: (name: string, body: () => Promise<void>) => void;
	readonly expect: ConformanceExpect;
}

/**
 * What `makeStore()` hands back.
 *
 * `teardown` runs even when the test failed. The two capability flags exist
 * because a real deployment can legitimately lack the feature: a tenant column
 * declared `NOT NULL` (station's shape) has no row to hold the global scope, and
 * a store with no change channel must leave `watch` undefined rather than
 * pretend (D1). Both default to "supported", and a skipped group is *announced*
 * in the test name rather than silently absent.
 */
export interface ConformanceStore {
	readonly store: PolicyStore;
	teardown?(): Promise<void>;
	/** Default `true`. Set `false` for a store whose scope column cannot hold `''`. */
	readonly supportsGlobalScope?: boolean;
	/** Default: inferred from whether `store.watch` is defined. */
	readonly supportsWatch?: boolean;
	/**
	 * Default `false`. `true` for a store whose policies are managed elsewhere.
	 *
	 * Every case in this suite seeds its own fixture through `save`/`linkTemplate`,
	 * so a store that cannot write has nothing to assert about round-trips,
	 * versions, isolation or change events — and asserting them anyway would fail
	 * for a store that is behaving exactly as designed. `readOnly: true` skips those
	 * groups (announced, not silently absent) and runs the read-only contract
	 * instead: `load` is well-shaped, `currentVersion` agrees with it, and all four
	 * write methods **reject** rather than quietly doing nothing.
	 *
	 * `readOnlyPolicyStore(...)` produces exactly such a store from three methods.
	 */
	readonly readOnly?: boolean;
}

/** Produces a **fresh, empty** store. Called once per test — never shared between them. */
export type ConformanceStoreFactory = () => Promise<ConformanceStore>;

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Registers the shared `PolicyStore` conformance suite.
 *
 * ```ts
 * import { runPolicyStoreConformanceSuite } from "@nestm/permissions-core/testing";
 *
 * runPolicyStoreConformanceSuite("DrizzlePolicyStore", async () => {
 *   const db = await freshDatabase();
 *   return { store: new DrizzlePolicyStore(db), teardown: () => db.destroy() };
 * });
 * ```
 *
 * Every test creates its own store through `makeStore` and tears it down
 * afterwards, so the suite needs no `beforeEach`/`afterEach` from the host runner
 * and cannot leak state between cases.
 *
 * @param name Shown in the test output, e.g. the store class name.
 * @param makeStore Produces a fresh, empty store per test.
 * @param hooks Test-runner hooks. Defaults to the ambient `describe`/`it`/`expect`.
 */
export function runPolicyStoreConformanceSuite(
	name: string,
	makeStore: ConformanceStoreFactory,
	hooks: ConformanceHooks = ambientHooks(),
): void {
	const { describe, it, expect } = hooks;

	/** Runs `body` against a fresh store and always tears it down. */
	async function withStore(body: (store: PolicyStore) => Promise<void>): Promise<void> {
		const handle = await makeStore();
		try {
			await body(handle.store);
		} finally {
			await handle.teardown?.();
		}
	}

	/** Capability probe. Costs one store construction; runs outside any assertion. */
	async function capabilities(): Promise<{
		global: boolean;
		watch: boolean;
		readOnly: boolean;
	}> {
		const handle = await makeStore();
		try {
			return {
				global: handle.supportsGlobalScope ?? true,
				watch: handle.supportsWatch ?? handle.store.watch !== undefined,
				readOnly: handle.readOnly ?? false,
			};
		} finally {
			await handle.teardown?.();
		}
	}

	/**
	 * Registers a case that seeds its fixture through the write SPI.
	 *
	 * Every case in this suite does, which is why the read-only gate lives here
	 * rather than being repeated thirty times.
	 */
	function itWrites(caseName: string, body: () => Promise<void>): void {
		it(caseName, async () => {
			const { readOnly } = await capabilities();
			if (readOnly) {
				return skipped(`${caseName} — store is read-only`);
			}
			await body();
		});
	}

	describe(`PolicyStore conformance: ${name}`, () => {
		// -------------------------------------------------------------------
		// Round-trips
		// -------------------------------------------------------------------

		describe("load / save / delete", () => {
			itWrites("returns an empty, correctly-shaped bundle for an untouched scope", async () => {
				await withStore(async (store) => {
					const bundle = await store.load(CONFORMANCE_SCOPES.a);

					expect(bundle.scope).toBe(CONFORMANCE_SCOPES.a);
					expect(bundle.policies.length).toBe(0);
					expect(bundle.links.length).toBe(0);
					assert(
						parsePolicyVersion(bundle.version) !== undefined,
						`version "${bundle.version}" is not the composite g<n>:s<m> form required by D2`,
					);
				});
			});

			itWrites("round-trips every field of a saved policy", async () => {
				await withStore(async (store) => {
					const record = policyRecordFixture({
						id: "p1",
						scope: CONFORMANCE_SCOPES.a,
						description: "a description",
						annotations: { owner: "platform" },
					});
					await store.save([record]);

					const loaded = onlyPolicy(await store.load(CONFORMANCE_SCOPES.a));

					expect(loaded.id).toBe("p1");
					expect(loaded.scope).toBe(CONFORMANCE_SCOPES.a);
					expect(loaded.kind).toBe("static");
					expect(loaded.enabled).toBe(true);
					expect(loaded.cedarJson).toEqual(PERMIT_ALL);
					expect(loaded.description).toBe("a description");
					expect(loaded.annotations).toEqual({ owner: "platform" });
					assert(
						loaded.updatedAt instanceof Date,
						"updatedAt must come back as a Date, not as a string",
					);
					expect(loaded.updatedAt.getTime()).toBe(FIXTURE_TIME.getTime());
				});
			});

			itWrites("replaces by (scope, id) rather than appending", async () => {
				await withStore(async (store) => {
					const scope = CONFORMANCE_SCOPES.a;
					await store.save([policyRecordFixture({ id: "p1", scope, description: "first" })]);
					await store.save([
						policyRecordFixture({ id: "p1", scope, description: "second", enabled: false }),
					]);

					const bundle = await store.load(scope);

					expect(bundle.policies.length).toBe(1);
					expect(onlyPolicy(bundle).description).toBe("second");
					expect(onlyPolicy(bundle).enabled).toBe(false);
				});
			});

			itWrites("saves records spanning several scopes in one call", async () => {
				await withStore(async (store) => {
					await store.save([
						policyRecordFixture({ id: "p:a", scope: CONFORMANCE_SCOPES.a }),
						policyRecordFixture({ id: "p:b", scope: CONFORMANCE_SCOPES.b }),
					]);

					expect(idsOf(await store.load(CONFORMANCE_SCOPES.a))).toEqual(["p:a"]);
					expect(idsOf(await store.load(CONFORMANCE_SCOPES.b))).toEqual(["p:b"]);
				});
			});

			itWrites("deletes by id and ignores unknown ids", async () => {
				await withStore(async (store) => {
					const scope = CONFORMANCE_SCOPES.a;
					await store.save([
						policyRecordFixture({ id: "p1", scope }),
						policyRecordFixture({ id: "p2", scope }),
					]);

					// The unknown id must not make the whole call fail: `delete` is the
					// idempotent half of a reconciliation loop.
					await store.delete(scope, ["p1", "does-not-exist"]);

					expect(idsOf(await store.load(scope))).toEqual(["p2"]);
				});
			});

			itWrites("round-trips a template link and unlinks it, ignoring unknown ids", async () => {
				await withStore(async (store) => {
					const scope = CONFORMANCE_SCOPES.a;
					await store.save([
						policyRecordFixture({
							id: "tpl",
							scope,
							kind: "template",
							cedarJson: TEMPLATE_BOTH_SLOTS,
						}),
					]);
					await store.linkTemplate(
						templateLinkFixture({
							id: "l1",
							templateId: "tpl",
							scope,
							values: {
								"?principal": { type: "User", id: "u1" },
								"?resource": { type: "Folder", id: "f1" },
							},
						}),
					);

					const link = onlyLink(await store.load(scope));
					expect(link.id).toBe("l1");
					expect(link.templateId).toBe("tpl");
					expect(link.scope).toBe(scope);
					expect(link.values).toEqual({
						"?principal": { type: "User", id: "u1" },
						"?resource": { type: "Folder", id: "f1" },
					});

					await store.unlinkTemplate(scope, "nope");
					expect((await store.load(scope)).links.length).toBe(1);

					await store.unlinkTemplate(scope, "l1");
					expect((await store.load(scope)).links.length).toBe(0);
				});
			});
		});

		// -------------------------------------------------------------------
		// Versions (D2)
		// -------------------------------------------------------------------

		describe("versions", () => {
			itWrites("agrees between currentVersion and load", async () => {
				await withStore(async (store) => {
					const scope = CONFORMANCE_SCOPES.a;
					await store.save([policyRecordFixture({ id: "p1", scope })]);

					expect(await store.currentVersion(scope)).toBe((await store.load(scope)).version);
				});
			});

			itWrites("moves the scope half forward on every write and never backwards", async () => {
				await withStore(async (store) => {
					const scope = CONFORMANCE_SCOPES.a;
					const seen: number[] = [scopeRevision(await store.currentVersion(scope), scope)];

					await store.save([policyRecordFixture({ id: "p1", scope })]);
					seen.push(scopeRevision(await store.currentVersion(scope), scope));

					await store.save([
						policyRecordFixture({
							id: "tpl",
							scope,
							kind: "template",
							cedarJson: TEMPLATE_BOTH_SLOTS,
						}),
					]);
					seen.push(scopeRevision(await store.currentVersion(scope), scope));

					await store.linkTemplate(templateLinkFixture({ id: "l1", templateId: "tpl", scope }));
					seen.push(scopeRevision(await store.currentVersion(scope), scope));

					await store.unlinkTemplate(scope, "l1");
					seen.push(scopeRevision(await store.currentVersion(scope), scope));

					await store.delete(scope, ["p1"]);
					seen.push(scopeRevision(await store.currentVersion(scope), scope));

					for (let index = 1; index < seen.length; index += 1) {
						const previous = seen[index - 1] as number;
						const current = seen[index] as number;
						assert(
							current > previous,
							`the scope revision must strictly increase on every write: ${previous} -> ${current} ` +
								`at step ${String(index)} of [${seen.join(", ")}]. A version that repeats leaves ` +
								`every cache serving the previous policy set.`,
						);
					}
				});
			});
		});

		// -------------------------------------------------------------------
		// Isolation
		// -------------------------------------------------------------------

		describe("cross-scope isolation", () => {
			itWrites("keeps one scope's policies out of another's bundle", async () => {
				await withStore(async (store) => {
					await store.save([policyRecordFixture({ id: "p:a", scope: CONFORMANCE_SCOPES.a })]);

					expect(idsOf(await store.load(CONFORMANCE_SCOPES.b))).toEqual([]);
				});
			});

			itWrites("does not let a delete in one scope reach another", async () => {
				await withStore(async (store) => {
					await store.save([
						policyRecordFixture({ id: "shared-id", scope: CONFORMANCE_SCOPES.a }),
						policyRecordFixture({ id: "shared-id", scope: CONFORMANCE_SCOPES.b }),
					]);

					await store.delete(CONFORMANCE_SCOPES.b, ["shared-id"]);

					expect(idsOf(await store.load(CONFORMANCE_SCOPES.a))).toEqual(["shared-id"]);
					expect(idsOf(await store.load(CONFORMANCE_SCOPES.b))).toEqual([]);
				});
			});
		});

		// -------------------------------------------------------------------
		// Global ∪ scope (D2)
		// -------------------------------------------------------------------

		describe("global union (D2)", () => {
			itWrites("composes global into every scope's effective bundle", async () => {
				const { global } = await capabilities();
				if (!global) {
					return skipped("store declares supportsGlobalScope: false");
				}

				await withStore(async (store) => {
					await store.save([
						policyRecordFixture({ id: "g1", scope: GLOBAL_POLICY_SCOPE }),
						policyRecordFixture({ id: "s1", scope: CONFORMANCE_SCOPES.a }),
					]);

					// `load` returns the *effective* bundle: consumers must not union
					// anything else in, so both halves have to be here already.
					expect(idsOf(await store.load(CONFORMANCE_SCOPES.a))).toEqual(["g1", "s1"]);
					expect(idsOf(await store.load(CONFORMANCE_SCOPES.b))).toEqual(["g1"]);
				});
			});

			itWrites("moves every scope's version when the global scope is written", async () => {
				const { global } = await capabilities();
				if (!global) {
					return skipped("store declares supportsGlobalScope: false");
				}

				await withStore(async (store) => {
					const before = await store.currentVersion(CONFORMANCE_SCOPES.a);
					await store.save([policyRecordFixture({ id: "g1", scope: GLOBAL_POLICY_SCOPE })]);
					const after = await store.currentVersion(CONFORMANCE_SCOPES.a);

					assert(
						before !== after,
						`a global write must change every scope's composite version (D2), but ` +
							`"${CONFORMANCE_SCOPES.a}" stayed at "${before}". A scope that does not move ` +
							`keeps serving a bundle the global edit was supposed to change.`,
					);
				});
			});

			itWrites("throws on a policy id present in both the global scope and the scope", async () => {
				const { global } = await capabilities();
				if (!global) {
					return skipped("store declares supportsGlobalScope: false");
				}

				await withStore(async (store) => {
					await store.save([
						policyRecordFixture({ id: "collides", scope: GLOBAL_POLICY_SCOPE }),
						policyRecordFixture({ id: "collides", scope: CONFORMANCE_SCOPES.a }),
					]);

					// Precedence between the two halves is undefined, so it is a
					// configuration error rather than a silent winner.
					await assertRejects(
						() => store.load(CONFORMANCE_SCOPES.a),
						"load() must throw when a policy id exists in both the global scope and the scope",
					);
				});
			});

			itWrites("throws on a link id present in both the global scope and the scope", async () => {
				const { global } = await capabilities();
				if (!global) {
					return skipped("store declares supportsGlobalScope: false");
				}

				await withStore(async (store) => {
					await store.save([
						policyRecordFixture({
							id: "tpl",
							scope: GLOBAL_POLICY_SCOPE,
							kind: "template",
							cedarJson: TEMPLATE_PRINCIPAL_ONLY,
						}),
					]);
					await store.linkTemplate(
						templateLinkFixture({ id: "collides", templateId: "tpl", scope: GLOBAL_POLICY_SCOPE }),
					);
					await store.linkTemplate(
						templateLinkFixture({ id: "collides", templateId: "tpl", scope: CONFORMANCE_SCOPES.a }),
					);

					await assertRejects(
						() => store.load(CONFORMANCE_SCOPES.a),
						"load() must throw when a link id exists in both the global scope and the scope",
					);
				});
			});
		});

		// -------------------------------------------------------------------
		// Partial slot values (D6)
		// -------------------------------------------------------------------

		describe("partial slot values (D6)", () => {
			itWrites("links a principal-only template without inventing a ?resource", async () => {
				await withStore(async (store) => {
					const scope = CONFORMANCE_SCOPES.a;
					await store.save([
						policyRecordFixture({
							id: "tpl",
							scope,
							kind: "template",
							cedarJson: TEMPLATE_PRINCIPAL_ONLY,
						}),
					]);
					await store.linkTemplate(
						templateLinkFixture({
							id: "l1",
							templateId: "tpl",
							scope,
							values: { "?principal": { type: "User", id: "u1" } },
						}),
					);

					const link = onlyLink(await store.load(scope));

					// Exactly the declared slot: a store that filled in a `?resource`
					// would make `buildPolicySet` reject the link as over-specified.
					expect(Object.keys(link.values).toSorted()).toEqual(["?principal"]);
					expect(link.values["?principal"]).toEqual({ type: "User", id: "u1" });
				});
			});

			itWrites("round-trips a link with no slot values at all", async () => {
				await withStore(async (store) => {
					const scope = CONFORMANCE_SCOPES.a;
					await store.save([
						policyRecordFixture({ id: "tpl", scope, kind: "template", cedarJson: PERMIT_ALL }),
					]);
					await store.linkTemplate(
						templateLinkFixture({ id: "l1", templateId: "tpl", scope, values: {} }),
					);

					expect(Object.keys(onlyLink(await store.load(scope)).values)).toEqual([]);
				});
			});
		});

		// -------------------------------------------------------------------
		// Change events (D1)
		// -------------------------------------------------------------------

		describe("watch (D1)", () => {
			itWrites("emits an event for the written scope", async () => {
				const { watch } = await capabilities();
				if (!watch) {
					return skipped("store does not implement watch");
				}

				await withStore(async (store) => {
					const events = collect(store);
					await store.save([policyRecordFixture({ id: "p1", scope: CONFORMANCE_SCOPES.a })]);

					assert(
						events.some((event) => event.scope === CONFORMANCE_SCOPES.a),
						`implementing watch is the promise that every write becomes an event (D1); a save ` +
							`to "${CONFORMANCE_SCOPES.a}" emitted ${JSON.stringify(events)}. A missed event ` +
							`serves stale authorization decisions indefinitely, because the cache stops ` +
							`polling currentVersion entirely.`,
					);
				});
			});

			itWrites("emits for every scope kind of write", async () => {
				const { watch } = await capabilities();
				if (!watch) {
					return skipped("store does not implement watch");
				}

				await withStore(async (store) => {
					const scope = CONFORMANCE_SCOPES.a;
					await store.save([
						policyRecordFixture({
							id: "tpl",
							scope,
							kind: "template",
							cedarJson: TEMPLATE_PRINCIPAL_ONLY,
						}),
					]);

					const events = collect(store);
					await store.linkTemplate(templateLinkFixture({ id: "l1", templateId: "tpl", scope }));
					const afterLink = events.length;
					await store.unlinkTemplate(scope, "l1");
					const afterUnlink = events.length;
					await store.delete(scope, ["tpl"]);

					assert(afterLink > 0, "linkTemplate must emit a change event");
					assert(afterUnlink > afterLink, "unlinkTemplate must emit a change event");
					assert(events.length > afterUnlink, "delete must emit a change event");
				});
			});

			itWrites("broadcasts a global write as scope '*'", async () => {
				const { watch, global } = await capabilities();
				if (!watch || !global) {
					return skipped("store does not implement watch, or has no global scope");
				}

				await withStore(async (store) => {
					const events = collect(store);
					await store.save([policyRecordFixture({ id: "g1", scope: GLOBAL_POLICY_SCOPE })]);

					// A global policy is composed into every bundle, so the only correct
					// invalidation is "all of them" (D2).
					assert(
						events.some((event) => event.scope === "*"),
						`a global write must broadcast { scope: "*" } so every cached scope is dropped; ` +
							`got ${JSON.stringify(events)}`,
					);
				});
			});

			itWrites("stops delivery on unsubscribe, idempotently", async () => {
				const { watch } = await capabilities();
				if (!watch) {
					return skipped("store does not implement watch");
				}

				await withStore(async (store) => {
					const events: PolicyChangeEvent[] = [];
					const unsubscribe = requireWatch(store)((event) => events.push(event));

					await store.save([policyRecordFixture({ id: "p1", scope: CONFORMANCE_SCOPES.a })]);
					const delivered = events.length;

					unsubscribe();
					unsubscribe(); // must be a no-op, not a second removal or a throw

					await store.save([policyRecordFixture({ id: "p2", scope: CONFORMANCE_SCOPES.a })]);

					assert(delivered > 0, "the listener must have received the first write");
					expect(events.length).toBe(delivered);
				});
			});
		});

		// -------------------------------------------------------------------
		// Defensive copies
		// -------------------------------------------------------------------

		describe("defensive copies", () => {
			itWrites("does not let a mutation of a returned bundle reach the store", async () => {
				await withStore(async (store) => {
					const scope = CONFORMANCE_SCOPES.a;
					await store.save([policyRecordFixture({ id: "p1", scope })]);

					const first = await store.load(scope);
					// Whatever the store returned, the caller owns it. A store that hands
					// back its own state lets a consumer that "just tweaks" a record
					// rewrite the policy every later check will run.
					mutate(first.policies[0]);
					mutate(first);

					const second = await store.load(scope);

					expect(second.policies.length).toBe(1);
					expect(onlyPolicy(second).id).toBe("p1");
					expect(onlyPolicy(second).enabled).toBe(true);
					expect(onlyPolicy(second).cedarJson).toEqual(PERMIT_ALL);
					expect(onlyPolicy(second).updatedAt.getTime()).toBe(FIXTURE_TIME.getTime());
				});
			});

			itWrites("does not let a mutation of a saved record reach the store", async () => {
				await withStore(async (store) => {
					const scope = CONFORMANCE_SCOPES.a;
					const record: PolicyRecord = policyRecordFixture({ id: "p1", scope });
					await store.save([record]);

					mutate(record);

					const loaded = onlyPolicy(await store.load(scope));
					expect(loaded.enabled).toBe(true);
					expect(loaded.cedarJson).toEqual(PERMIT_ALL);
					expect(loaded.updatedAt.getTime()).toBe(FIXTURE_TIME.getTime());
				});
			});

			itWrites("does not let a mutation of a linked record's values reach the store", async () => {
				await withStore(async (store) => {
					const scope = CONFORMANCE_SCOPES.a;
					await store.save([
						policyRecordFixture({
							id: "tpl",
							scope,
							kind: "template",
							cedarJson: TEMPLATE_PRINCIPAL_ONLY,
						}),
					]);

					const values = { "?principal": { type: "User", id: "u1" } };
					const link: TemplateLinkRecord = templateLinkFixture({
						id: "l1",
						templateId: "tpl",
						scope,
						values,
					});
					await store.linkTemplate(link);

					// Re-pointing a grant at a different principal by mutating the object
					// you handed in is a privilege escalation, not a convenience.
					values["?principal"] = { type: "User", id: "attacker" };

					expect(onlyLink(await store.load(scope)).values["?principal"]).toEqual({
						type: "User",
						id: "u1",
					});
				});
			});
		});

		// -------------------------------------------------------------------
		// Dangling links
		// -------------------------------------------------------------------

		describe("dangling links", () => {
			itWrites(
				"surfaces a link to a deleted template at build time, never as a silent revocation",
				async () => {
					await withStore(async (store) => {
						const scope = CONFORMANCE_SCOPES.a;
						await store.save([
							policyRecordFixture({
								id: "tpl",
								scope,
								kind: "template",
								cedarJson: TEMPLATE_PRINCIPAL_ONLY,
							}),
						]);
						await store.linkTemplate(
							templateLinkFixture({
								id: "l1",
								templateId: "tpl",
								scope,
								values: { "?principal": { type: "User", id: "u1" } },
							}),
						);

						await store.delete(scope, ["tpl"]);

						const bundle = await store.load(scope);

						// The store must not quietly drop the orphan: a link that vanishes is a
						// grant that vanishes, and an operator who deleted a template by
						// mistake would see access disappear with nothing in the logs. The
						// bundle stays honest and `buildPolicySet` refuses it loudly.
						assert(
							bundle.links.some((candidate) => candidate.id === "l1"),
							"a link whose template was deleted must still appear in the bundle, so the " +
								"failure surfaces at build time instead of as a silent revocation",
						);

						assertThrows(
							() => buildPolicySet(bundle),
							"buildPolicySet must reject a link referencing an unknown template",
						);
					});
				},
			);

			itWrites("rejects a link that points at a static policy", async () => {
				await withStore(async (store) => {
					const scope = CONFORMANCE_SCOPES.a;
					await store.save([policyRecordFixture({ id: "not-a-template", scope })]);
					await store.linkTemplate(
						templateLinkFixture({ id: "l1", templateId: "not-a-template", scope }),
					);

					const bundle = await store.load(scope);
					assertThrows(
						() => buildPolicySet(bundle),
						"buildPolicySet must reject a link referencing a static policy",
					);
				});
			});
		});

		// -------------------------------------------------------------------
		// Read-only stores
		// -------------------------------------------------------------------

		describe("read-only stores", () => {
			it("loads a well-shaped bundle whose version currentVersion agrees with", async () => {
				const { readOnly } = await capabilities();
				if (!readOnly) {
					return skipped("store is writable — the write suites cover this");
				}

				await withStore(async (store) => {
					const scope = CONFORMANCE_SCOPES.a;
					const bundle = await store.load(scope);

					expect(bundle.scope).toBe(scope);
					assert(
						Array.isArray(bundle.policies) && Array.isArray(bundle.links),
						"load() must return arrays for policies and links even when empty",
					);
					assert(
						parsePolicyVersion(bundle.version) !== undefined,
						`version "${bundle.version}" is not the composite g<n>:s<m> form required by D2`,
					);
					expect(await store.currentVersion(scope)).toBe(bundle.version);
				});
			});

			it("rejects every write rather than silently doing nothing", async () => {
				const { readOnly } = await capabilities();
				if (!readOnly) {
					return skipped("store is writable");
				}

				await withStore(async (store) => {
					const scope = CONFORMANCE_SCOPES.a;
					// A write that resolves without writing is the failure this asserts
					// against: the caller believes the grant landed, the next load does not
					// show it, and the difference is only visible as an authorization
					// decision that should have changed and did not.
					await assertRejects(
						() => store.save([policyRecordFixture({ id: "p1", scope })]),
						"a read-only store's save() must reject",
					);
					await assertRejects(
						() => store.delete(scope, ["p1"]),
						"a read-only store's delete() must reject",
					);
					await assertRejects(
						() => store.linkTemplate(templateLinkFixture({ id: "l1", scope, templateId: "tpl" })),
						"a read-only store's linkTemplate() must reject",
					);
					await assertRejects(
						() => store.unlinkTemplate(scope, "l1"),
						"a read-only store's unlinkTemplate() must reject",
					);
				});
			});

			it("rejects an empty write too — nothing is a special case", async () => {
				const { readOnly } = await capabilities();
				if (!readOnly) {
					return skipped("store is writable");
				}

				await withStore(async (store) => {
					// `save([])` is a no-op for a writable store, which makes "it did
					// nothing" indistinguishable from "it worked". A read-only store must
					// still refuse it, or a caller batching zero records learns nothing
					// about whether the next batch will land.
					await assertRejects(() => store.save([]), "a read-only store's save([]) must reject");
					await assertRejects(
						() => store.delete(CONFORMANCE_SCOPES.a, []),
						"a read-only store's delete(scope, []) must reject",
					);
				});
			});
		});
	});
	/** Marks a group as skipped in a way that shows up, rather than as an absent test. */
	function skipped(reason: string): void {
		// eslint-disable-next-line no-console -- a skipped conformance group must be visible in the log
		console.log(`  [skipped] ${name}: ${reason}`);
	}
}

// ---------------------------------------------------------------------------
// Assertions the suite owns
// ---------------------------------------------------------------------------

function assert(condition: boolean, message: string): void {
	if (!condition) {
		throw new Error(`PolicyStore conformance: ${message}`);
	}
}

function assertThrows(body: () => unknown, message: string): void {
	let threw = false;
	try {
		const result = body();
		// A promise-returning body would resolve after this frame; force the caller
		// to use `assertRejects` instead of silently passing.
		if (result instanceof Promise) {
			result.catch(() => undefined);
			throw new Error(`${message} (body returned a promise; use assertRejects)`);
		}
	} catch {
		threw = true;
	}
	assert(threw, message);
}

async function assertRejects(body: () => Promise<unknown>, message: string): Promise<void> {
	let threw = false;
	try {
		await body();
	} catch {
		threw = true;
	}
	assert(threw, message);
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function idsOf(bundle: { readonly policies: readonly PolicyRecord[] }): string[] {
	return bundle.policies.map((record) => record.id).toSorted();
}

function onlyPolicy(bundle: { readonly policies: readonly PolicyRecord[] }): PolicyRecord {
	const record = bundle.policies[0];
	assert(record !== undefined, "expected the bundle to hold at least one policy");
	return record as PolicyRecord;
}

function onlyLink(bundle: { readonly links: readonly TemplateLinkRecord[] }): TemplateLinkRecord {
	const link = bundle.links[0];
	assert(link !== undefined, "expected the bundle to hold at least one template link");
	return link as TemplateLinkRecord;
}

function requireWatch(store: PolicyStore): NonNullable<PolicyStore["watch"]> {
	// oxlint-disable-next-line typescript/unbound-method -- the very next line binds it; `watch` is an optional SPI method and this is the one place it is detached
	const watch = store.watch;
	assert(watch !== undefined, "expected the store to implement watch");
	return (watch as NonNullable<PolicyStore["watch"]>).bind(store);
}

function collect(store: PolicyStore): PolicyChangeEvent[] {
	const events: PolicyChangeEvent[] = [];
	requireWatch(store)((event) => events.push(event));
	return events;
}

/**
 * Tries every mutation a careless consumer might make.
 *
 * Wrapped because a store that deep-freezes its output makes these *throw* in
 * strict mode — which is a pass, not a failure. What matters is only that the
 * store's own state is unchanged afterwards.
 */
function mutate(value: unknown): void {
	if (typeof value !== "object" || value === null) {
		return;
	}

	const target = value as Record<string, unknown>;
	for (const [key, current] of Object.entries(target)) {
		try {
			if (Array.isArray(current)) {
				current.length = 0;
			} else if (current instanceof Date) {
				current.setTime(0);
			} else if (typeof current === "boolean") {
				target[key] = !current;
			} else if (typeof current === "object" && current !== null) {
				for (const nested of Object.keys(current)) {
					delete (current as Record<string, unknown>)[nested];
				}
			}
		} catch {
			// Frozen. That is the strongest possible pass.
		}
	}
}

function scopeRevision(version: string, scope: PolicyScopeId): number {
	const parsed = parsePolicyVersion(version);
	assert(
		parsed !== undefined,
		`version "${version}" for scope "${scope}" is not the composite g<n>:s<m> form required by D2`,
	);
	return (parsed as { readonly scope: number }).scope;
}

// ---------------------------------------------------------------------------
// Ambient runner discovery
// ---------------------------------------------------------------------------

interface AmbientGlobals {
	describe?: ConformanceHooks["describe"];
	it?: ConformanceHooks["it"];
	expect?: ConformanceExpect;
}

/** Picks up `globals: true` runners; throws with a usable message when there is none. */
function ambientHooks(): ConformanceHooks {
	const ambient = globalThis as AmbientGlobals;

	if (
		typeof ambient.describe !== "function" ||
		typeof ambient.it !== "function" ||
		typeof ambient.expect !== "function"
	) {
		throw new Error(
			"runPolicyStoreConformanceSuite found no ambient describe/it/expect. Either enable your " +
				"runner's globals (vitest `globals: true`) or pass them explicitly: " +
				"runPolicyStoreConformanceSuite(name, makeStore, { describe, it, expect }).",
		);
	}

	return { describe: ambient.describe, it: ambient.it, expect: ambient.expect };
}
