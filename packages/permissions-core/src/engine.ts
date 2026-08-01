// `PermissionsEngine` — the check path.
//
// The class owns four things that must be created and torn down together: the
// Cedar binding, the preparsed-schema registry, the per-scope preparsed policy
// sets, and a subscription to the policy store. That ownership is why this is a
// class rather than a bag of functions (core.md §1): a functional API would have
// to park all four in module globals, which is fatal for tests and for the
// NestJS module, where two independent registrations must not share a WASM
// policy-set id.
//
// Everything the engine does on the hot path is a consequence of the numbers in
// core.md §0: authorize against a *preparsed* set (14.6x), pass a *narrow* entity
// graph (up to 20x), and never probe the store per check (D1).
//
// `plan()` is the same engine seen from the other side. It leaves the *resource*
// unknown, so Cedar returns residuals instead of a decision, and those residuals
// compile into a driver-neutral filter. Two facts shape its implementation:
// `PartialAuthorizationCall` has no `preparsedPolicySetId` field, so the policy
// set travels inline on every call and the plan cache is a requirement rather
// than an optimisation; and an untranslatable subterm is a **security** event,
// not a formatting one, which is why `plan()` throws by default.

import type {
	AuthorizationAnswer,
	CedarBinding,
	CedarValueJson,
	Context,
	DetailedError,
	EntityJson,
	PartialAuthorizationCall,
	PolicySet,
	StatefulAuthorizationCall,
} from "./cedar/binding.ts";
import {
	cedarErrorsOf,
	isCedarFailure,
	unwrapAuthorization,
	unwrapPartialAuthorization,
	unwrapValidation,
} from "./cedar/answers.ts";
import { loadCedar } from "./cedar/loader.ts";
import { actionUid, entityRefToUid, type EntityRef } from "./cedar/uid.ts";
import {
	emitDecision,
	type DecisionEvent,
	type DecisionListener,
	type ContextRedactor,
} from "./diagnostics/decision-event.ts";
import { entityGraph, toCedarValue } from "./entities/entity-builder.ts";
import { EntityCache, type EntityCacheStats } from "./entities/entity-cache.ts";
import type {
	EntityGraph,
	EntityProvider,
	EntityResolutionRequest,
} from "./entities/entity-provider.ts";
import {
	resolveEngineOptions,
	type EngineOptions,
	type ResolvedEngineOptions,
} from "./engine.options.ts";
import { compileResiduals, type CompiledPlan } from "./plan/compile-residuals.ts";
import { formatPlanNode } from "./plan/plan-node.ts";
import { createPostFilter, type PostFilterCheck } from "./plan/post-filter.ts";
import type {
	OnErroredPolicy,
	PlanDiagnostics,
	QueryPlan,
	UnsupportedResidualPolicy,
} from "./plan/plan.ts";
import { buildPolicySet } from "./policy/policy-set-builder.ts";
import type { PolicyScopeId, PolicyStore, Unsubscribe } from "./policy/policy-store.ts";
import { PlanCache, planCacheKey, type PlanCacheStats } from "./runtime/plan-cache.ts";
import {
	PolicySetCache,
	type PolicySetCacheStats,
	type PolicySetHandle,
} from "./runtime/policy-set-cache.ts";
import { SchemaCache, schemaHash } from "./runtime/schema-cache.ts";
import { fail } from "./util/assert.ts";
import type {
	ActionOf,
	AnyVocabulary,
	ContextFor,
	PrincipalTypeFor,
	ResourceTypeFor,
} from "./vocabulary/types.ts";

/**
 * cedar-wasm's answer when `preparsedPolicySetId` names an id it has never seen:
 * `preparsed policy set '<id>' not found`.
 *
 * Note what this does **not** cover, per errata 1: an id that was *evicted*
 * (overwritten with an empty policy set) stays registered and answers `deny`.
 * "Not found" therefore only ever means "never preparsed in this WASM instance".
 */
const POLICY_SET_MISSING = /policy set\b.*\bnot found/i;

/** One Cedar policy that errored while evaluating a request. */
export interface PolicyEvaluationError {
	/** Id of the policy (or template link) that errored. */
	readonly policyId: string;
	/** Cedar's message, flattened for logging. */
	readonly message: string;
	/** Cedar's full diagnostic, `sourceLocations` included. */
	readonly detail: DetailedError;
}

/** One authorization question. */
export interface CheckRequest<V extends AnyVocabulary, A extends ActionOf<V>> {
	/** Policy scope to decide in — the tenant key, `''` for global. */
	readonly scope: PolicyScopeId;
	/** Who is acting. The type union is narrowed to what `A` declares. */
	readonly principal: EntityRef<PrincipalTypeFor<V, A>>;
	/** What they are doing. */
	readonly action: A;
	/** What they are doing it to. A type `A` does not declare is a compile error. */
	readonly resource: EntityRef<ResourceTypeFor<V, A>>;
	/** Request context, typed by the action's declared context fields. */
	readonly context?: ContextFor<V, A>;
	/**
	 * Pre-resolved entities. Skips the `EntityProvider` entirely.
	 *
	 * `[]` is meaningful and allowed: it says "this decision needs no attributes
	 * and no hierarchy". Leaving it `undefined` with no provider configured is an
	 * `ENTITY_RESOLUTION` error rather than an implicit empty graph.
	 */
	readonly entities?: EntityGraph;
}

/**
 * A {@link CheckRequest} with every vocabulary-derived type widened to `string`.
 *
 * The escape hatch for the cases where inference genuinely cannot work: an
 * action id that only exists as a `string` at the call site (read from a route
 * table, a database row, a config file), or a generic wrapper that has lost `V`.
 *
 * The trade is exactly the one the vocabulary exists to prevent: a typo in the
 * action id, or an action/resource pair the schema does not allow, is no longer
 * a compile error. It becomes a `deny` — or, with `validateRequests: true`, an
 * `EVALUATION_FAILED` throw from Cedar's request validation. Prefer `check()`
 * everywhere it type-checks, and keep the unsafe surface to the one adapter that
 * needs it.
 */
export interface UnsafeCheckRequest {
	readonly scope: PolicyScopeId;
	readonly principal: EntityRef;
	readonly action: string;
	readonly resource: EntityRef;
	readonly context?: Readonly<Record<string, unknown>>;
	readonly entities?: EntityGraph;
}

/**
 * One "which rows may this principal act on" question.
 *
 * The mirror image of a {@link CheckRequest}: the resource is a *type* rather
 * than an instance, and it is the one thing Cedar is not told, so what comes
 * back is a filter instead of a decision.
 */
export interface PlanRequest<
	V extends AnyVocabulary,
	A extends ActionOf<V>,
	R extends ResourceTypeFor<V, A>,
> {
	/** Policy scope to plan in — the tenant key, `''` for global. */
	readonly scope: PolicyScopeId;
	/** Who is acting. Fully known: only the resource is left unknown. */
	readonly principal: EntityRef<PrincipalTypeFor<V, A>>;
	/** What they are doing. */
	readonly action: A;
	/**
	 * The type of row being filtered. A type `A` does not declare is a compile
	 * error, exactly as for `check()`.
	 */
	readonly resourceType: R;
	/** Request context, typed by the action's declared context fields. */
	readonly context?: ContextFor<V, A>;
	/**
	 * Pre-resolved entities — the **principal graph**. Skips the `EntityProvider`.
	 *
	 * There is no resource to resolve here, so `resolveResource` is never called
	 * on this path. Note the consequence for `plan.postFilter`: passing `entities`
	 * explicitly means the engine will re-use that same graph when re-checking
	 * rows, and a graph with no resource entities makes every row deny.
	 */
	readonly entities?: EntityGraph;
}

/** The answer to one {@link CheckRequest}. Plain data: cloneable, loggable, frozen. */
export interface CheckResult {
	/** `decision === 'allow'`. The field callers should branch on. */
	readonly allowed: boolean;
	/** Cedar's decision. Default is `deny`; a `forbid` always beats a `permit`. */
	readonly decision: "allow" | "deny";
	/** Cedar `diagnostics.reason` — the policies that determined the decision. */
	readonly determiningPolicyIds: readonly string[];
	/**
	 * Policies that errored while evaluating.
	 *
	 * Never empty-and-ignorable: an errored `forbid` is *dropped* from the
	 * decision (core.md §0), so a non-empty list on an `allow` means the allow may
	 * be wrong. `validateOnLoad` exists to keep this empty; treat entries here as
	 * an alert, not as debug output.
	 */
	readonly policyErrors: readonly PolicyEvaluationError[];
	/** Scope the decision was made in. */
	readonly scope: PolicyScopeId;
	/** Version of the policy bundle that produced it. */
	readonly policySetVersion: string;
	/** Wall time spent, measured with the configured `clock`. */
	readonly durationMs: number;
	/** Whether the policy set was already preparsed (`'hit'`) or had to be loaded. */
	readonly cache: "hit" | "miss";
}

/** One problem Cedar's validator found in a policy set. */
export interface PolicyValidationIssue {
	/** Id of the offending policy or template. */
	readonly policyId: string;
	/** Cedar's message, flattened for logging. */
	readonly message: string;
	/** Cedar's full diagnostic, `sourceLocations` included. */
	readonly detail: DetailedError;
}

/** What {@link PermissionsEngine.validatePolicies} reports. */
export interface PolicyValidationReport {
	/** `true` when Cedar reported no validation errors. Warnings do not clear it. */
	readonly ok: boolean;
	/** Scope validated. */
	readonly scope: PolicyScopeId;
	/** Version of the bundle validated. */
	readonly version: string;
	/** Errors, per policy. */
	readonly errors: readonly PolicyValidationIssue[];
	/** Warnings, per policy. */
	readonly warnings: readonly PolicyValidationIssue[];
	/** Warnings Cedar could not attribute to a policy. */
	readonly otherWarnings: readonly DetailedError[];
}

/** Everything {@link PermissionsEngine.stats} reports. */
export interface EngineStats {
	/** Prefix of every WASM policy-set id this engine owns. */
	readonly instanceId: string;
	/** Cedar namespace requests are qualified with. */
	readonly namespace: string;
	/** `check` calls that produced a result. */
	readonly checks: number;
	/** Of those, how many allowed. */
	readonly allows: number;
	/** Of those, how many denied. */
	readonly denies: number;
	/** Of those, how many carried at least one `policyErrors` entry. */
	readonly errored: number;
	/** `plan` calls that produced a plan. */
	readonly plans: number;
	/** Of those, how many carried at least one `PlanApproximation`. */
	readonly approximated: number;
	/** Preparse-cache counters. */
	readonly policySets: PolicySetCacheStats;
	/** Compiled-plan-cache counters. */
	readonly planCache: PlanCacheStats;
	/** Preparsed-schema registry. */
	readonly schema: {
		readonly name: string;
		readonly registered: number;
		readonly preparses: number;
	};
	/** Entity-cache counters, or `undefined` when the cache is off (the default). */
	readonly entities: EntityCacheStats | undefined;
	/** Whether `dispose()` has run. */
	readonly disposed: boolean;
}

/** Normalised, vocabulary-agnostic form every check path converges on. */
interface NormalizedRequest {
	readonly scope: PolicyScopeId;
	readonly principal: EntityRef;
	readonly action: string;
	readonly resource: EntityRef;
	readonly context: unknown;
	readonly entities: EntityGraph | undefined;
}

/** The same, for the plan path, where the resource is a type rather than an instance. */
interface NormalizedPlanRequest {
	readonly scope: PolicyScopeId;
	readonly principal: EntityRef;
	readonly action: string;
	readonly resourceType: string;
	readonly context: unknown;
	readonly entities: EntityGraph | undefined;
}

/** Work shared across the requests of one `checkMany` batch. */
interface CheckBatch {
	readonly handles: Map<PolicyScopeId, PolicySetHandle>;
	readonly principals: Map<string, EntityGraph>;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPolicySetMissing(answer: AuthorizationAnswer): boolean {
	return (
		isCedarFailure(answer) && answer.errors.some((error) => POLICY_SET_MISSING.test(error.message))
	);
}

/**
 * The Cedar authorization engine.
 *
 * ```ts
 * const engine = await createEngine({ vocabulary, policyStore, entityProvider });
 * const { allowed } = await engine.check({
 *   scope: "org:8f3e",
 *   principal: { type: "Member", id: "m1" },
 *   action: "run:dispatch",
 *   resource: { type: "Run", id: "r1" },
 * });
 * ```
 *
 * Lifecycle: created with {@link create} (which loads the WASM and registers the
 * schema), used for as long as the process needs it, and torn down with
 * {@link dispose}, which releases every WASM policy-set id it owns. `dispose()`
 * is terminal — a disposed engine throws `ENGINE_INIT` rather than quietly
 * authorizing against an emptied policy set.
 */
export class PermissionsEngine<V extends AnyVocabulary> {
	readonly #vocabulary: V;
	readonly #store: PolicyStore;
	readonly #entityProvider: EntityProvider<V> | undefined;
	readonly #namespace: string;
	readonly #instanceId: string;
	readonly #binding: CedarBinding;
	readonly #schemas: SchemaCache;
	readonly #schemaName: string;
	readonly #policySets: PolicySetCache;
	readonly #planCache: PlanCache<CompiledPlan>;
	readonly #entityCache: EntityCache | undefined;
	readonly #validateRequests: boolean;
	readonly #unsupportedResidual: UnsupportedResidualPolicy;
	readonly #onErroredPolicy: OnErroredPolicy;
	readonly #maxPostFilterRows: number;
	readonly #onDecision: DecisionListener | undefined;
	readonly #redactContext: ContextRedactor;
	readonly #clock: () => number;

	#unsubscribe: Unsubscribe | undefined;
	#disposed = false;
	#checks = 0;
	#allows = 0;
	#denies = 0;
	#errored = 0;
	#plans = 0;
	#approximated = 0;

	private constructor(
		options: ResolvedEngineOptions<V>,
		binding: CedarBinding,
		schemas: SchemaCache,
		schemaName: string,
	) {
		this.#vocabulary = options.vocabulary;
		this.#store = options.policyStore;
		this.#entityProvider = options.entityProvider;
		this.#namespace = options.namespace;
		this.#instanceId = options.instanceId;
		this.#binding = binding;
		this.#schemas = schemas;
		this.#schemaName = schemaName;
		this.#validateRequests = options.validateRequests;
		this.#unsupportedResidual = options.unsupportedResidual;
		this.#onErroredPolicy = options.onErroredPolicy;
		this.#maxPostFilterRows = options.maxPostFilterRows;
		this.#onDecision = options.onDecision;
		this.#redactContext = options.redactContext;
		this.#clock = options.clock;
		this.#entityCache =
			options.entityCache === undefined
				? undefined
				: new EntityCache({ ...options.entityCache, clock: options.clock });
		this.#planCache = new PlanCache<CompiledPlan>({ ...options.planCache, clock: options.clock });

		this.#policySets = new PolicySetCache({
			binding,
			store: options.policyStore,
			instanceId: options.instanceId,
			namespace: options.namespace,
			maxScopes: options.policySetCache.maxScopes,
			staleAfterMs: options.policySetCache.staleAfterMs,
			clock: options.clock,
			...(options.validateOnLoad
				? {
						onPolicySetBuilt: (set, scope) => {
							this.#assertPolicySetValid(set, scope);
						},
					}
				: {}),
		});

		// The policy-set cache subscribes for its own staleness. This second,
		// engine-owned subscription drops the two derived caches, which cannot be
		// merely marked stale:
		//
		//   * a compiled plan is a filter built from policies that no longer apply —
		//     serving it stale is precisely the over-share this package exists to
		//     prevent, so plans are *dropped*, never reused;
		//   * an entity graph that was sufficient before a policy started traversing
		//     a hierarchy is now insufficient, which is a wrong decision, not a slow
		//     one.
		const entityCache = this.#entityCache;
		const planCache = this.#planCache;
		this.#unsubscribe = this.#store.watch?.((event) => {
			planCache.invalidate(event.scope);
			entityCache?.invalidate(event.scope);
		});
	}

	/**
	 * Loads Cedar, registers the vocabulary's schema and returns a ready engine.
	 *
	 * No policies are loaded here: scopes are populated lazily on first check, so
	 * a process with 10 000 tenants does not pay for 10 000 preparses at boot.
	 * Call {@link warm} for the scopes you know you need immediately.
	 *
	 * @throws `PermissionsError` with code `SCHEMA_INVALID` when Cedar rejects the
	 * vocabulary's generated schema — which is where delta D3 moved that check
	 * from `defineVocabulary`, and the only place it is unconditional.
	 * @throws {@link CedarVersionError} when the installed cedar-wasm reports an
	 * unsupported language version.
	 */
	static async create<V extends AnyVocabulary>(
		options: EngineOptions<V>,
	): Promise<PermissionsEngine<V>> {
		const resolved = resolveEngineOptions(options);

		// `loadCedar()` also runs the "one copy of this package" tripwire; injecting
		// a binding skips it, which is what makes the seam usable from unit tests.
		const binding = resolved.cedar ?? (await loadCedar());

		const schemas = new SchemaCache();
		const schemaName = schemas.ensure(
			binding,
			schemaHash(resolved.vocabulary.cedarSchemaJson),
			resolved.vocabulary.cedarSchemaJson,
		);

		return new PermissionsEngine(resolved, binding, schemas, schemaName);
	}

	/** The vocabulary this engine decides against. */
	get vocabulary(): V {
		return this.#vocabulary;
	}

	/** Prefix of every WASM policy-set id this engine owns. */
	get instanceId(): string {
		return this.#instanceId;
	}

	/** Whether {@link dispose} has run. */
	get disposed(): boolean {
		return this.#disposed;
	}

	/**
	 * Decides one request.
	 *
	 * The action narrows both entity types: `resource` must be one of the types
	 * the action's `appliesTo` declares, so a mismatched pair is a compile error
	 * rather than a guaranteed `deny` discovered in production.
	 *
	 * @throws `PermissionsError` with code `ENTITY_RESOLUTION` when neither
	 * `entities` nor an `entityProvider` is available, `POLICY_STORE` /
	 * `POLICY_INVALID` when the scope's policies cannot be loaded or compiled,
	 * `POLICY_SET_NOT_PREPARED` when the preparsed set vanished twice in a row, and
	 * `EVALUATION_FAILED` when Cedar rejects the request itself.
	 */
	async check<A extends ActionOf<V>>(request: CheckRequest<V, A>): Promise<CheckResult> {
		this.#assertActive();
		return this.#execute(this.#normalize(request), newBatch());
	}

	/**
	 * Decides many requests, in order.
	 *
	 * Sequential by design — `statefulIsAuthorized` is a synchronous WASM call, so
	 * concurrency buys nothing — but the batch shares work: one `ensure` per
	 * distinct scope and one principal resolution per distinct `(scope, principal)`
	 * pair. A "list the 200 runs this member may read" loop therefore costs one
	 * policy-set lookup and one entity resolution, not 200 of each.
	 */
	async checkMany(
		requests: readonly CheckRequest<V, ActionOf<V>>[],
	): Promise<readonly CheckResult[]> {
		this.#assertActive();

		const batch = newBatch();
		const results: CheckResult[] = [];

		for (const request of requests) {
			results.push(await this.#execute(this.#normalize(request), batch));
		}

		return results;
	}

	/**
	 * {@link check} with plain-string action and entity types.
	 *
	 * See {@link UnsafeCheckRequest} for what this gives up. It is a real escape
	 * hatch, not a convenience: reach for it only where the action id genuinely
	 * cannot be a literal at the call site.
	 */
	async checkUnsafe(request: UnsafeCheckRequest): Promise<CheckResult> {
		this.#assertActive();
		return this.#execute(this.#normalize(request), newBatch());
	}

	/**
	 * Compiles "which rows of `resourceType` may this principal act on" into a
	 * three-state {@link QueryPlan}.
	 *
	 * ```ts
	 * const plan = await engine.plan({
	 *   scope: "org:8f3e",
	 *   principal: { type: "Member", id: "m1" },
	 *   action: "run:read",
	 *   resourceType: "Run",
	 * });
	 * if (plan.kind === "ALWAYS_DENY") return [];
	 * const where = plan.kind === "ALWAYS_ALLOW" ? undefined : planToSql(plan, mapping);
	 * ```
	 *
	 * The plan is **sound**: the rows `condition` selects are exactly the rows
	 * `check()` would allow, unless `approximations` is non-empty — and a
	 * `'permissive'` approximation only ever appears because the caller asked for
	 * one via `unsupportedResidual`.
	 *
	 * @throws `PermissionsError` with code `UNSUPPORTED_RESIDUAL` when a policy
	 * cannot be pushed into a query and dropping it would widen the result,
	 * `ERRORED_POLICY` when Cedar reports errored policies, and the same
	 * `ENTITY_RESOLUTION` / `POLICY_STORE` / `POLICY_INVALID` / `EVALUATION_FAILED`
	 * failures as `check()`.
	 */
	async plan<A extends ActionOf<V>, R extends ResourceTypeFor<V, A>>(
		request: PlanRequest<V, A, R>,
	): Promise<QueryPlan<R>> {
		this.#assertActive();

		const startedAt = this.#clock();
		const normalized: NormalizedPlanRequest = {
			scope: request.scope,
			principal: request.principal,
			action: request.action,
			resourceType: request.resourceType,
			context: request.context,
			entities: request.entities,
		};

		// Both of these happen *before* the cache probe, and they have to: the key
		// covers the policy-set version and the resolved entity graph, so neither is
		// optional. `ensure` is a pure in-memory hit on a watching store (D1). The
		// entity resolution is the one cost a plan-cache hit does not avoid — which
		// is what `entityCache` is for, and why `PlanRequest.entities` exists.
		const handle = await this.#policySets.ensure(normalized.scope);
		const entities = await this.#planEntitiesFor(normalized);

		const key = planCacheKey({
			instanceId: this.#instanceId,
			scope: normalized.scope,
			policySetVersion: handle.version,
			principal: normalized.principal,
			entities,
			action: normalized.action,
			resourceType: normalized.resourceType,
			context: normalized.context ?? null,
			vocabHash: this.#schemaName,
		});

		const cached = this.#planCache.get(key);
		const compiled = cached ?? this.#compile(normalized, entities);

		if (cached === undefined) {
			this.#planCache.set(key, normalized.scope, compiled);
		}

		const plan = this.#toQueryPlan<R>(normalized, compiled, {
			policySetVersion: handle.version,
			cache: cached === undefined ? "miss" : "hit",
			durationMs: this.#clock() - startedAt,
		});

		this.#plans += 1;
		if (plan.approximations.length > 0) {
			this.#approximated += 1;
		}

		emitDecision(this.#onDecision, () => ({
			type: "plan",
			scope: normalized.scope,
			principal: normalized.principal,
			action: normalized.action,
			resourceType: normalized.resourceType,
			kind: plan.kind,
			approximations: plan.approximations,
			diagnostics: plan.diagnostics,
			...(normalized.context === undefined
				? {}
				: { context: this.#redactContext(normalized.context) }),
		}));

		return plan;
	}

	/**
	 * Preloads a scope's policy set, probing the store's `currentVersion` first.
	 *
	 * The explicit freshness flow D1 carves out: use it at boot or after an
	 * out-of-band write, never per check.
	 */
	async warm(scope: PolicyScopeId): Promise<void> {
		this.#assertActive();
		await this.#policySets.warm(scope);
	}

	/**
	 * Marks a scope — or every scope, for `'*'` — as stale in every cache.
	 *
	 * The policy set is not unloaded: the resident one keeps answering until a
	 * reload succeeds, because a stale-but-known policy set is strictly better
	 * than an empty one. Compiled **plans** are dropped outright, because a stale
	 * plan is not a slower answer, it is the wrong set of rows.
	 */
	// oxlint-disable-next-line typescript/no-redundant-type-constituents -- `PolicyScopeId` widens to `string`, but spelling the sentinel out is the contract
	async invalidate(scope: PolicyScopeId | "*"): Promise<void> {
		this.#assertActive();
		this.#policySets.invalidate(scope);
		this.#planCache.invalidate(scope);
		this.#entityCache?.invalidate(scope);
	}

	/**
	 * Drops one entity's cached graph, in `scope` or in every scope.
	 *
	 * The hook for changes no `PolicyChangeEvent` can describe: a role granted, a
	 * member removed, a project reparented. Only meaningful when `entityCache` is
	 * enabled; a no-op otherwise.
	 *
	 * @returns how many cache entries were dropped.
	 */
	invalidateEntity(ref: EntityRef, scope?: PolicyScopeId): number {
		return this.#entityCache?.invalidateEntity(ref, scope) ?? 0;
	}

	/**
	 * Runs Cedar's validator over a scope's policies without preparsing them.
	 *
	 * The read-only half of `validateOnLoad`: an admin UI calls this before saving
	 * so the author sees the squiggles, and `validateOnLoad` is what guarantees a
	 * policy that skipped that step still cannot take effect.
	 */
	async validatePolicies(scope: PolicyScopeId): Promise<PolicyValidationReport> {
		this.#assertActive();

		const bundle = await this.#store.load(scope);
		const set = buildPolicySet(bundle, { namespace: this.#namespace });

		const report = unwrapValidation(
			this.#binding.validate({ schema: this.#vocabulary.cedarSchemaJson, policies: set }),
			{
				code: "POLICY_INVALID",
				message: `Cedar could not validate the policies for scope "${scope}"`,
				scope,
			},
		);

		const errors = report.validationErrors.map(toValidationIssue);
		const warnings = report.validationWarnings.map(toValidationIssue);

		return Object.freeze({
			ok: errors.length === 0,
			scope,
			version: bundle.version,
			errors: Object.freeze(errors),
			warnings: Object.freeze(warnings),
			otherWarnings: Object.freeze([...report.otherWarnings]),
		});
	}

	/** Counter snapshot across every cache the engine owns. Safe after `dispose()`. */
	stats(): EngineStats {
		return Object.freeze({
			instanceId: this.#instanceId,
			namespace: this.#namespace,
			checks: this.#checks,
			allows: this.#allows,
			denies: this.#denies,
			errored: this.#errored,
			plans: this.#plans,
			approximated: this.#approximated,
			policySets: this.#policySets.stats(),
			planCache: this.#planCache.stats(),
			schema: Object.freeze({
				name: this.#schemaName,
				registered: this.#schemas.size,
				preparses: this.#schemas.preparses,
			}),
			entities: this.#entityCache?.stats(),
			disposed: this.#disposed,
		});
	}

	/**
	 * Releases every WASM policy-set id this engine owns and unsubscribes from the
	 * store.
	 *
	 * Terminal and idempotent. Every subsequent `check` throws `ENGINE_INIT`: the
	 * ids have been overwritten with empty policy sets, so a check against a
	 * disposed engine would return a perfectly plausible `deny` for every request
	 * — the failure mode this refuses to have.
	 */
	async dispose(): Promise<void> {
		if (this.#disposed) {
			return;
		}
		this.#disposed = true;

		this.#unsubscribe?.();
		this.#unsubscribe = undefined;
		this.#planCache.clear();
		this.#entityCache?.clear();
		this.#policySets.dispose();
	}

	#assertActive(): void {
		if (this.#disposed) {
			fail(
				"ENGINE_INIT",
				`The PermissionsEngine for instance "${this.#instanceId}" has been disposed. ` +
					`Every policy-set id it owned was released; create a new engine.`,
			);
		}
	}

	#normalize(request: CheckRequest<V, ActionOf<V>> | UnsafeCheckRequest): NormalizedRequest {
		return {
			scope: request.scope,
			principal: request.principal,
			action: request.action,
			resource: request.resource,
			context: request.context,
			entities: request.entities,
		};
	}

	/**
	 * Runs partial evaluation and compiles the residuals.
	 *
	 * Synchronous on purpose: everything asynchronous — the policy set, the entity
	 * graph — has already been resolved by the caller, so this is the part the
	 * plan cache is actually caching.
	 */
	#compile(request: NormalizedPlanRequest, entities: EntityGraph): CompiledPlan {
		const policies = this.#policySets.policySetFor(request.scope);

		if (policies === undefined) {
			// `ensure` just populated the entry, so this can only happen if the LRU
			// evicted the scope in between — with `maxScopes` at 1 and concurrent
			// traffic, say. Failing is right: partial evaluation against a policy set
			// we cannot produce would have to mean "no policies", i.e. allow nothing
			// or, far worse, silently plan against an empty set.
			fail(
				"POLICY_SET_NOT_PREPARED",
				`The policy set for scope "${request.scope}" was evicted while planning ` +
					`"${request.action}". Raise policySetCache.maxScopes above the number of scopes in ` +
					`concurrent use.`,
				{ scope: request.scope },
			);
		}

		const answer = this.#binding.isAuthorizedPartial(
			this.#partialCall(request, entities, policies),
		);

		const response = unwrapPartialAuthorization(answer, {
			code: "EVALUATION_FAILED",
			message:
				`Cedar could not partially evaluate "${request.action}" over ` +
				`${request.resourceType} in scope "${request.scope}"`,
			scope: request.scope,
		});

		return compileResiduals(response, {
			resourceType: request.resourceType,
			namespace: this.#namespace,
			scope: request.scope,
			action: request.action,
			unsupportedResidual: this.#unsupportedResidual,
			onErroredPolicy: this.#onErroredPolicy,
		});
	}

	#partialCall(
		request: NormalizedPlanRequest,
		entities: EntityGraph,
		policies: PolicySet,
	): PartialAuthorizationCall {
		const call: PartialAuthorizationCall = {
			principal: entityRefToUid(request.principal, this.#namespace),
			action: actionUid(this.#namespace, request.action),
			// The one unknown. Everything else is concrete, which is what keeps the
			// residuals to a shape the pushdown table can handle.
			resource: null,
			context: this.#context(request),
			policies,
			entities: [...entities],
		};

		if (!this.#validateRequests) {
			return call;
		}

		// Partial evaluation takes the schema inline: there is no
		// `preparsedSchemaName` on this call shape, only on the stateful one.
		return { ...call, schema: this.#vocabulary.cedarSchemaJson, validateRequest: true };
	}

	#toQueryPlan<R extends string>(
		request: NormalizedPlanRequest,
		compiled: CompiledPlan,
		provenance: { policySetVersion: string; cache: "hit" | "miss"; durationMs: number },
	): QueryPlan<R> {
		const diagnostics: PlanDiagnostics = Object.freeze({
			residualPolicyIds: compiled.residualPolicyIds,
			erroredPolicyIds: compiled.erroredPolicyIds,
			policySetVersion: provenance.policySetVersion,
			cache: provenance.cache,
			durationMs: provenance.durationMs,
			explain: () => this.#explain(request, compiled, provenance.policySetVersion),
		});

		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- `resourceType` came in as `R`; `NormalizedPlanRequest` only widens it to `string`
		const resourceType = request.resourceType as R;
		const base = { resourceType, approximations: compiled.approximations, diagnostics };

		if (compiled.kind !== "CONDITIONAL") {
			return Object.freeze({ ...base, kind: compiled.kind });
		}

		if (!compiled.postFilter) {
			return Object.freeze({
				...base,
				kind: "CONDITIONAL" as const,
				condition: compiled.condition,
			});
		}

		return Object.freeze({
			...base,
			kind: "CONDITIONAL" as const,
			condition: compiled.condition,
			postFilter: createPostFilter({
				check: this.#postFilterCheck(request),
				maxRows: this.#maxPostFilterRows,
				resourceType: request.resourceType,
				action: request.action,
				scope: request.scope,
			}),
		});
	}

	/**
	 * The plan's only reference back to the engine.
	 *
	 * A closure rather than a stored `this`, so stripping the functions off a
	 * `QueryPlan` leaves plain, structurally cloneable data.
	 */
	#postFilterCheck(request: NormalizedPlanRequest): PostFilterCheck {
		return async (resources) => {
			// One batch for the whole call: one policy-set handle and one principal
			// resolution shared across every row, exactly as `checkMany` does.
			const batch = newBatch();
			const allowed: boolean[] = [];

			for (const resource of resources) {
				const result = await this.#execute(
					{
						scope: request.scope,
						principal: request.principal,
						action: request.action,
						resource,
						context: request.context,
						entities: request.entities,
					},
					batch,
				);
				allowed.push(result.allowed);
			}

			return allowed;
		};
	}

	#explain(
		request: NormalizedPlanRequest,
		compiled: CompiledPlan,
		policySetVersion: string,
	): string {
		const lines = [
			`${compiled.kind} — ${request.principal.type}::"${request.principal.id}" ` +
				`"${request.action}" over ${request.resourceType} in scope "${request.scope}" ` +
				`(policies ${policySetVersion})`,
		];

		if (compiled.kind === "CONDITIONAL") {
			lines.push(`  where ${formatPlanNode(compiled.condition)}`);
		}
		if (compiled.residualPolicyIds.length > 0) {
			lines.push(`  residual policies: ${compiled.residualPolicyIds.join(", ")}`);
		}
		if (compiled.erroredPolicyIds.length > 0) {
			lines.push(`  errored policies: ${compiled.erroredPolicyIds.join(", ")}`);
		}
		if (compiled.postFilter) {
			lines.push("  post-filter: required — rows must be re-checked before use");
		}
		for (const approximation of compiled.approximations) {
			lines.push(`  ! ${approximation.direction}: ${approximation.message}`);
		}

		return lines.join("\n");
	}

	async #planEntitiesFor(request: NormalizedPlanRequest): Promise<EntityGraph> {
		if (request.entities !== undefined) {
			return entityGraph(...request.entities);
		}

		const provider = this.#entityProvider;
		if (provider === undefined) {
			fail(
				"ENTITY_RESOLUTION",
				`No entities were supplied for planning "${request.action}" over ` +
					`${request.resourceType} in scope "${request.scope}" and no entityProvider is ` +
					`configured. Pass "entities" on the request (use [] to mean "this plan needs none") ` +
					`or configure an entityProvider.`,
				{ scope: request.scope },
			);
		}

		// `resource` is deliberately absent: there is no instance to resolve, which
		// is why `EntityResolutionRequest.resource` is optional. `resolveResource`
		// is skipped for the same reason.
		const resolution: EntityResolutionRequest<V> = {
			scope: request.scope,
			principal: request.principal,
			// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- `PlanRequest.action` is `ActionOf<V>`; the normalised form only widens it
			action: request.action as ActionOf<V>,
		};

		const parts: EntityJson[] = [...(await this.#principalGraph(provider, resolution, newBatch()))];

		if (provider.resolveAdditional !== undefined) {
			parts.push(...(await provider.resolveAdditional(resolution)));
		}

		return entityGraph(...parts);
	}

	async #execute(request: NormalizedRequest, batch: CheckBatch): Promise<CheckResult> {
		const startedAt = this.#clock();

		let handle = await this.#handleFor(request.scope, batch);
		const entities = await this.#entitiesFor(request, batch);
		const call = this.#authorizationCall(request, entities, handle.psetId);

		let answer = this.#binding.statefulIsAuthorized(call);

		if (isPolicySetMissing(answer)) {
			// The id is registered by this engine and never version-suffixed, so
			// "not found" means something outside this engine's control lost it: a
			// duplicated copy of the package with its own WASM instance, a disposed
			// sibling engine that reused the prefix, or a module reload. Re-preparse
			// once and retry; a second failure is a configuration problem, not a race.
			this.#policySets.evict(request.scope);
			batch.handles.delete(request.scope);
			handle = await this.#handleFor(request.scope, batch);

			answer = this.#binding.statefulIsAuthorized({
				...call,
				preparsedPolicySetId: handle.psetId,
			});

			if (isPolicySetMissing(answer)) {
				fail(
					"POLICY_SET_NOT_PREPARED",
					`Cedar reports no preparsed policy set "${handle.psetId}" for scope ` +
						`"${request.scope}" even after re-preparsing it. Check for more than one copy of ` +
						`@nestm/permissions-core in this process — each copy owns a separate WASM instance.`,
					{ details: cedarErrorsOf(answer), scope: request.scope },
				);
			}
		}

		const response = unwrapAuthorization(answer, {
			code: "EVALUATION_FAILED",
			message: `Cedar could not decide "${request.action}" in scope "${request.scope}"`,
			scope: request.scope,
		});

		const policyErrors = response.diagnostics.errors.map((error) => ({
			policyId: error.policyId,
			message: error.error.message,
			detail: error.error,
		}));

		const result: CheckResult = Object.freeze({
			allowed: response.decision === "allow",
			decision: response.decision,
			determiningPolicyIds: Object.freeze([...response.diagnostics.reason]),
			policyErrors: Object.freeze(policyErrors),
			scope: request.scope,
			policySetVersion: handle.version,
			durationMs: this.#clock() - startedAt,
			cache: handle.cache,
		});

		this.#checks += 1;
		if (result.allowed) {
			this.#allows += 1;
		} else {
			this.#denies += 1;
		}
		if (policyErrors.length > 0) {
			this.#errored += 1;
		}

		emitDecision(this.#onDecision, () => this.#decisionEvent(request, result));

		return result;
	}

	#decisionEvent(request: NormalizedRequest, result: CheckResult): DecisionEvent {
		return {
			...result,
			type: "check",
			principal: request.principal,
			action: request.action,
			resource: request.resource,
			...(request.context === undefined ? {} : { context: this.#redactContext(request.context) }),
		};
	}

	async #handleFor(scope: PolicyScopeId, batch: CheckBatch): Promise<PolicySetHandle> {
		const shared = batch.handles.get(scope);
		if (shared !== undefined) {
			return shared;
		}

		const handle = await this.#policySets.ensure(scope);
		batch.handles.set(scope, handle);
		return handle;
	}

	async #entitiesFor(request: NormalizedRequest, batch: CheckBatch): Promise<EntityGraph> {
		if (request.entities !== undefined) {
			return entityGraph(...request.entities);
		}

		const provider = this.#entityProvider;
		if (provider === undefined) {
			fail(
				"ENTITY_RESOLUTION",
				`No entities were supplied for "${request.action}" in scope "${request.scope}" and no ` +
					`entityProvider is configured. Pass "entities" on the request (use [] to mean "this ` +
					`decision needs none") or configure an entityProvider.`,
				{ scope: request.scope },
			);
		}

		const resolution: EntityResolutionRequest<V> = {
			scope: request.scope,
			principal: request.principal,
			// `checkUnsafe` accepts an unchecked action id; providers declare the
			// narrow union, so the widening happens exactly here and nowhere else.
			// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see above
			action: request.action as ActionOf<V>,
			resource: request.resource,
		};

		const parts: EntityJson[] = [...(await this.#principalGraph(provider, resolution, batch))];

		if (provider.resolveResource !== undefined) {
			parts.push(...(await provider.resolveResource(resolution)));
		}
		if (provider.resolveAdditional !== undefined) {
			parts.push(...(await provider.resolveAdditional(resolution)));
		}

		return entityGraph(...parts);
	}

	async #principalGraph(
		provider: EntityProvider<V>,
		resolution: EntityResolutionRequest<V>,
		batch: CheckBatch,
	): Promise<EntityGraph> {
		const key = `${resolution.scope}\u0000${resolution.principal.type}\u0000${resolution.principal.id}`;

		const inBatch = batch.principals.get(key);
		if (inBatch !== undefined) {
			return inBatch;
		}

		const cached = this.#entityCache?.get(resolution.scope, resolution.principal);
		if (cached !== undefined) {
			batch.principals.set(key, cached);
			return cached;
		}

		const graph = await provider.resolvePrincipal(resolution);

		batch.principals.set(key, graph);
		this.#entityCache?.set(resolution.scope, resolution.principal, graph);
		return graph;
	}

	#authorizationCall(
		request: NormalizedRequest,
		entities: EntityGraph,
		psetId: string,
	): StatefulAuthorizationCall {
		const call: StatefulAuthorizationCall = {
			principal: entityRefToUid(request.principal, this.#namespace),
			action: actionUid(this.#namespace, request.action),
			resource: entityRefToUid(request.resource, this.#namespace),
			context: this.#context(request),
			entities: [...entities],
			preparsedPolicySetId: psetId,
		};

		if (!this.#validateRequests) {
			return call;
		}

		return { ...call, preparsedSchemaName: this.#schemaName, validateRequest: true };
	}

	#context(request: {
		readonly scope: PolicyScopeId;
		readonly action: string;
		readonly context: unknown;
	}): Context {
		const value = request.context;

		if (value === undefined || value === null) {
			return {};
		}
		if (!isPlainRecord(value)) {
			fail(
				"SCHEMA_INVALID",
				`The context for "${request.action}" must be an object of the action's declared context ` +
					`fields, received ${typeof value}.`,
				{ scope: request.scope },
			);
		}

		// Structural conversion only — Date to `__extn`, EntityRef to `__entity`.
		// Whether the *shape* matches the action's declaration is Cedar's call,
		// under `validateRequests`, which is what makes that check authoritative
		// rather than a second opinion this package could get wrong.
		const context: Record<string, CedarValueJson> = {};
		for (const [key, member] of Object.entries(value)) {
			if (member === undefined) {
				continue;
			}
			context[key] = toCedarValue(member, {
				namespace: this.#namespace,
				path: `context.${key}`,
			});
		}

		return context;
	}

	#assertPolicySetValid(set: PolicySet, scope: PolicyScopeId): void {
		const report = unwrapValidation(
			this.#binding.validate({ schema: this.#vocabulary.cedarSchemaJson, policies: set }),
			{
				code: "POLICY_INVALID",
				message: `Cedar could not validate the policy set for scope "${scope}"`,
				scope,
			},
		);

		if (report.validationErrors.length === 0) {
			return;
		}

		fail(
			"POLICY_INVALID",
			`Cedar validation rejected the policy set for scope "${scope}": ` +
				report.validationErrors
					.map((issue) => `${issue.policyId}: ${issue.error.message}`)
					.join("; "),
			{ details: report.validationErrors.map((issue) => issue.error), scope },
		);
	}
}

function newBatch(): CheckBatch {
	return { handles: new Map(), principals: new Map() };
}

function toValidationIssue(issue: {
	policyId: string;
	error: DetailedError;
}): PolicyValidationIssue {
	return { policyId: issue.policyId, message: issue.error.message, detail: issue.error };
}

/**
 * Functional alias for {@link PermissionsEngine.create}.
 *
 * Identical behaviour; it exists because `createEngine(options)` reads better in
 * a NestJS `useFactory` than a static method does.
 */
export async function createEngine<V extends AnyVocabulary>(
	options: EngineOptions<V>,
): Promise<PermissionsEngine<V>> {
	return PermissionsEngine.create(options);
}
