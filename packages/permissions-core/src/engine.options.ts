// `EngineOptions` and their defaults, kept apart from `engine.ts` so the NestJS
// module can name and validate the option shape without importing the engine
// (and therefore without pulling the Cedar WASM into its module graph).

import { randomBytes } from "node:crypto";

import type { CedarBinding } from "./cedar/binding.ts";
import {
	redactContextKeys,
	type ContextRedactor,
	type DecisionListener,
} from "./diagnostics/decision-event.ts";
import type { EntityProvider } from "./entities/entity-provider.ts";
import type { OnErroredPolicy, UnsupportedResidualPolicy } from "./plan/plan.ts";
import { DEFAULT_MAX_POST_FILTER_ROWS } from "./plan/post-filter.ts";
import type { PolicyStore } from "./policy/policy-store.ts";
import { DEFAULT_PLAN_CACHE_MAX, DEFAULT_PLAN_CACHE_TTL_MS } from "./runtime/plan-cache.ts";
import { DEFAULT_MAX_SCOPES, DEFAULT_STALE_AFTER_MS } from "./runtime/policy-set-cache.ts";
import {
	DEFAULT_ENTITY_CACHE_MAX_ENTRIES,
	DEFAULT_ENTITY_CACHE_TTL_MS,
} from "./entities/entity-cache.ts";
import { invariant } from "./util/assert.ts";
import type { AnyVocabulary } from "./vocabulary/types.ts";

/** Prefix of a generated {@link EngineOptions.instanceId}. */
export const DEFAULT_INSTANCE_ID_PREFIX = "perm-";

/** Bytes of randomness in a generated instance id. */
const INSTANCE_ID_BYTES = 8;

/** Tuning for the preparsed-policy-set cache. */
export interface PolicySetCacheTuning {
	/** Scopes kept preparsed at once. Default {@link DEFAULT_MAX_SCOPES}. */
	readonly maxScopes?: number;
	/**
	 * Revalidation interval used **only** when the policy store cannot `watch`.
	 * Default {@link DEFAULT_STALE_AFTER_MS}. Ignored entirely when it can (D1).
	 */
	readonly staleAfterMs?: number;
}

/** Tuning for the compiled-plan cache. */
export interface PlanCacheTuning {
	/** Maximum plans held at once. Default {@link DEFAULT_PLAN_CACHE_MAX}. */
	readonly max?: number;
	/** Entry lifetime. Default {@link DEFAULT_PLAN_CACHE_TTL_MS}. */
	readonly ttlMs?: number;
}

/** Tuning for the optional cross-request entity cache. */
export interface EntityCacheTuning {
	/** Entry lifetime. Default {@link DEFAULT_ENTITY_CACHE_TTL_MS}. */
	readonly ttlMs?: number;
	/** Maximum entries. Default {@link DEFAULT_ENTITY_CACHE_MAX_ENTRIES}. */
	readonly maxEntries?: number;
}

/** Everything `PermissionsEngine.create()` accepts. */
export interface EngineOptions<V extends AnyVocabulary> {
	/** The vocabulary every request is typed and validated against. */
	readonly vocabulary: V;
	/** Where policies come from. */
	readonly policyStore: PolicyStore;
	/**
	 * Resolves the entities a decision needs.
	 *
	 * Optional only because a caller may pass `entities` on every request instead.
	 * A request with neither is an `ENTITY_RESOLUTION` error, never an empty graph:
	 * silently authorizing against no entities would deny things that should be
	 * allowed and, with a `forbid` that depends on an attribute, allow things that
	 * should be denied.
	 */
	readonly entityProvider?: EntityProvider<V>;
	/** Cedar namespace to qualify types with. Defaults to `vocabulary.namespace`. */
	readonly namespace?: string;
	/**
	 * Prefix of every WASM policy-set id this engine owns.
	 *
	 * Must be unique per engine in the process — two engines sharing one would
	 * overwrite each other's preparsed sets. Defaults to
	 * `` `${DEFAULT_INSTANCE_ID_PREFIX}${random hex}` ``. Set it explicitly only if
	 * you need the ids to be recognisable in a memory dump.
	 */
	readonly instanceId?: string;
	/** Preparse-cache tuning. */
	readonly policySetCache?: PolicySetCacheTuning;
	/**
	 * Compiled-plan cache tuning.
	 *
	 * Not an optimisation: `isAuthorizedPartial` cannot use the preparse cache
	 * (there is no `preparsedPolicySetId` on `PartialAuthorizationCall`), so an
	 * uncached `plan()` re-parses the whole policy set at ~2.28 ms — roughly 17
	 * stateful checks. Defaults are {@link DEFAULT_PLAN_CACHE_MAX} entries and
	 * {@link DEFAULT_PLAN_CACHE_TTL_MS}.
	 */
	readonly planCache?: PlanCacheTuning;
	/**
	 * What `plan()` does when a residual subterm cannot be pushed into a query and
	 * dropping it would **widen** the result. Default `'error'`.
	 *
	 * This is the fail-closed contract's one knob. `'error'` refuses to return an
	 * unsound plan; `'post-filter'` returns a widened plan plus an `O(n)`
	 * re-check; a function decides per subterm. Restrictive approximations — which
	 * over-block and are therefore safe — never consult it.
	 */
	readonly unsupportedResidual?: UnsupportedResidualPolicy;
	/**
	 * What `plan()` does when Cedar reports policies that errored during partial
	 * evaluation. Default `'error'`.
	 *
	 * An errored policy gets a `{"Value": false}` residual, so an errored `forbid`
	 * silently vanishes from the plan. `'ignore'` is documented as unsafe for
	 * exactly that reason.
	 */
	readonly onErroredPolicy?: OnErroredPolicy;
	/**
	 * Cap on rows one `plan.postFilter(...)` call will re-check. Default
	 * {@link DEFAULT_MAX_POST_FILTER_ROWS}.
	 *
	 * A circuit breaker, not a tuning knob: the post-filter runs one Cedar
	 * decision per row, so an unpaginated call is a self-inflicted outage.
	 */
	readonly maxPostFilterRows?: number;
	/**
	 * Cross-request entity cache. **Default `false`.**
	 *
	 * Enabling it is an explicit trade: principal graphs are reused for `ttlMs`,
	 * so a role granted elsewhere becomes visible to Cedar only after the entry
	 * expires or something invalidates it. Policy changes invalidate it
	 * automatically; membership changes do not — call `invalidateEntity(ref)` from
	 * whatever writes them.
	 */
	readonly entityCache?: false | EntityCacheTuning;
	/**
	 * Run Cedar's `validate()` over every policy set as it is loaded, and **reject
	 * the load** when it reports errors. Default `true`.
	 *
	 * This is the second half of the errored-policy defence (core.md §0): the typed
	 * `entity()` builder catches bad entities, and this catches a policy that reads
	 * an attribute or entity type the schema does not declare — the shape that
	 * makes a `forbid` error at evaluation time and vanish from the decision.
	 *
	 * A rejected load leaves the previously prepared set resident and serviceable,
	 * so a bad policy write degrades to "the new policies did not take effect",
	 * never to "the tenant lost all policies".
	 */
	readonly validateOnLoad?: boolean;
	/**
	 * Pass the schema on every authorization call with `validateRequest: true`, so
	 * Cedar rejects a request whose principal/resource types or context do not
	 * match the action's declaration. Default `true`.
	 */
	readonly validateRequests?: boolean;
	/** Synchronous audit sink. Never awaited; a throw is swallowed. */
	readonly onDecision?: DecisionListener;
	/** Redacts the request context before it reaches `onDecision`. Default: keys only. */
	readonly redactContext?: ContextRedactor;
	/**
	 * Clock in milliseconds, used for cache freshness and `durationMs`.
	 *
	 * Defaults to `Date.now`, whose 1 ms resolution rounds a ~0.14 ms check down to
	 * `0`. Pass `() => performance.now()` when `durationMs` needs to be meaningful.
	 */
	readonly clock?: () => number;
	/** Cedar binding to use instead of loading one. The unit-test seam. */
	readonly cedar?: CedarBinding;
}

/** {@link EngineOptions} with every default applied. */
export interface ResolvedEngineOptions<V extends AnyVocabulary> {
	readonly vocabulary: V;
	readonly policyStore: PolicyStore;
	readonly entityProvider: EntityProvider<V> | undefined;
	readonly namespace: string;
	readonly instanceId: string;
	readonly policySetCache: Required<PolicySetCacheTuning>;
	readonly planCache: Required<PlanCacheTuning>;
	readonly unsupportedResidual: UnsupportedResidualPolicy;
	readonly onErroredPolicy: OnErroredPolicy;
	readonly maxPostFilterRows: number;
	/** `undefined` when the entity cache is disabled, which is the default. */
	readonly entityCache: Required<EntityCacheTuning> | undefined;
	readonly validateOnLoad: boolean;
	readonly validateRequests: boolean;
	readonly onDecision: DecisionListener | undefined;
	readonly redactContext: ContextRedactor;
	readonly clock: () => number;
	readonly cedar: CedarBinding | undefined;
}

/**
 * A fresh instance id: {@link DEFAULT_INSTANCE_ID_PREFIX} plus 16 hex characters.
 *
 * Random rather than derived: ids must not collide between two engines in one
 * process, and nothing may make them *stable across processes* — a restarted
 * process inherits no WASM state, so reusing an old id would only make two live
 * processes fight over the same slot in a shared-memory future.
 */
export function generateInstanceId(): string {
	return `${DEFAULT_INSTANCE_ID_PREFIX}${randomBytes(INSTANCE_ID_BYTES).toString("hex")}`;
}

/**
 * Applies every default and validates what cannot be defaulted.
 *
 * Pure and synchronous — it never touches Cedar — so a host can resolve options
 * at configuration time and inspect the result before an engine exists.
 *
 * @throws `PermissionsError` with code `ENGINE_INIT` when a required option is
 * missing or a numeric bound is not a positive integer.
 */
export function resolveEngineOptions<V extends AnyVocabulary>(
	options: EngineOptions<V>,
): ResolvedEngineOptions<V> {
	const vocabulary = options.vocabulary;

	invariant(
		typeof vocabulary === "object" && vocabulary !== null && "cedarSchemaJson" in vocabulary,
		"ENGINE_INIT",
		"EngineOptions.vocabulary must be the result of defineVocabulary().",
	);
	invariant(
		typeof options.policyStore === "object" && options.policyStore !== null,
		"ENGINE_INIT",
		"EngineOptions.policyStore is required; use MemoryPolicyStore for an in-process one.",
	);

	const namespace = options.namespace ?? vocabulary.namespace;
	invariant(
		typeof namespace === "string" && namespace !== "",
		"ENGINE_INIT",
		"EngineOptions.namespace must be a non-empty Cedar namespace.",
	);

	const instanceId = options.instanceId ?? generateInstanceId();
	invariant(
		typeof instanceId === "string" && instanceId !== "",
		"ENGINE_INIT",
		"EngineOptions.instanceId must be a non-empty string; omit it for a generated one.",
	);

	const maxScopes = options.policySetCache?.maxScopes ?? DEFAULT_MAX_SCOPES;
	assertPositiveInteger(maxScopes, "policySetCache.maxScopes");

	const staleAfterMs = options.policySetCache?.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
	assertPositiveInteger(staleAfterMs, "policySetCache.staleAfterMs");

	const planCacheMax = options.planCache?.max ?? DEFAULT_PLAN_CACHE_MAX;
	assertPositiveInteger(planCacheMax, "planCache.max");

	const planCacheTtlMs = options.planCache?.ttlMs ?? DEFAULT_PLAN_CACHE_TTL_MS;
	assertPositiveInteger(planCacheTtlMs, "planCache.ttlMs");

	const maxPostFilterRows = options.maxPostFilterRows ?? DEFAULT_MAX_POST_FILTER_ROWS;
	assertPositiveInteger(maxPostFilterRows, "maxPostFilterRows");

	const unsupportedResidual = options.unsupportedResidual ?? "error";
	invariant(
		typeof unsupportedResidual === "function" ||
			unsupportedResidual === "error" ||
			unsupportedResidual === "post-filter",
		"ENGINE_INIT",
		`EngineOptions.unsupportedResidual must be 'error', 'post-filter' or a function, received ` +
			`${String(unsupportedResidual)}.`,
	);

	const onErroredPolicy = options.onErroredPolicy ?? "error";
	invariant(
		onErroredPolicy === "error" || onErroredPolicy === "deny-all" || onErroredPolicy === "ignore",
		"ENGINE_INIT",
		`EngineOptions.onErroredPolicy must be 'error', 'deny-all' or 'ignore', received ` +
			`${String(onErroredPolicy)}.`,
	);

	return {
		vocabulary,
		policyStore: options.policyStore,
		entityProvider: options.entityProvider,
		namespace,
		instanceId,
		policySetCache: { maxScopes, staleAfterMs },
		planCache: { max: planCacheMax, ttlMs: planCacheTtlMs },
		unsupportedResidual,
		onErroredPolicy,
		maxPostFilterRows,
		entityCache: resolveEntityCache(options.entityCache),
		validateOnLoad: options.validateOnLoad ?? true,
		validateRequests: options.validateRequests ?? true,
		onDecision: options.onDecision,
		redactContext: options.redactContext ?? redactContextKeys,
		clock: options.clock ?? Date.now,
		cedar: options.cedar,
	};
}

function resolveEntityCache(
	tuning: false | EntityCacheTuning | undefined,
): Required<EntityCacheTuning> | undefined {
	// `undefined` and `false` both mean off: the cache is opt-in, and an option
	// object a caller forgot to fill in must not silently enable it.
	if (tuning === undefined || tuning === false) {
		return undefined;
	}

	const ttlMs = tuning.ttlMs ?? DEFAULT_ENTITY_CACHE_TTL_MS;
	assertPositiveInteger(ttlMs, "entityCache.ttlMs");

	const maxEntries = tuning.maxEntries ?? DEFAULT_ENTITY_CACHE_MAX_ENTRIES;
	assertPositiveInteger(maxEntries, "entityCache.maxEntries");

	return { ttlMs, maxEntries };
}

function assertPositiveInteger(value: number, option: string): void {
	invariant(
		Number.isInteger(value) && value > 0,
		"ENGINE_INIT",
		`EngineOptions.${option} must be a positive integer, received ${String(value)}.`,
	);
}
