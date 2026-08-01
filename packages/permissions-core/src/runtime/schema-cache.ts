// `preparseSchema` registry.
//
// Cedar's stateful call takes a `preparsedSchemaName` instead of the schema
// itself. Registration is process-global and, like the policy-set registry, has
// no unregister API — so names are derived from a content hash and registered
// exactly once per distinct schema.

import type { CedarBinding, Schema, SchemaJson } from "../cedar/binding.ts";
import { unwrapCheckParse } from "../cedar/answers.ts";
import { shortHash } from "../util/hash.ts";

/** Prefix of every generated `preparsedSchemaName`. */
export const DEFAULT_SCHEMA_NAME_PREFIX = "vocab-";

/** Construction options for {@link SchemaCache}. */
export interface SchemaCacheOptions {
	/** Prefix for generated schema names. Defaults to {@link DEFAULT_SCHEMA_NAME_PREFIX}. */
	readonly prefix?: string;
}

/**
 * Content hash of a Cedar schema, stable across key ordering.
 *
 * The natural argument for {@link SchemaCache.ensure}; a vocabulary can also
 * supply its own hash as long as it changes whenever the schema does.
 */
export function schemaHash(schema: SchemaJson<string>): string {
	return shortHash(schema);
}

/**
 * Memoises `preparseSchema` calls by hash.
 *
 * Registration is idempotent from the caller's point of view: the same hash
 * returns the same name without touching the WASM a second time.
 */
export class SchemaCache {
	readonly #names = new Set<string>();
	readonly #prefix: string;
	#preparses = 0;

	constructor(options: SchemaCacheOptions = {}) {
		this.#prefix = options.prefix ?? DEFAULT_SCHEMA_NAME_PREFIX;
	}

	/** Number of distinct schemas registered by this cache. */
	get size(): number {
		return this.#names.size;
	}

	/** How many `preparseSchema` calls this cache has made. */
	get preparses(): number {
		return this.#preparses;
	}

	/** The name `ensure` would use for `vocabHash`, registered or not. */
	nameFor(vocabHash: string): string {
		return `${this.#prefix}${vocabHash}`;
	}

	/** Whether `vocabHash` has already been registered by this cache. */
	has(vocabHash: string): boolean {
		return this.#names.has(this.nameFor(vocabHash));
	}

	/** Registered names, sorted. */
	names(): readonly string[] {
		return [...this.#names].toSorted();
	}

	/**
	 * Registers `schemaJson` under a name derived from `vocabHash` if it is not
	 * registered yet, and returns that name for use as `preparsedSchemaName`.
	 *
	 * Synchronous: `preparseSchema` is a synchronous WASM call.
	 *
	 * @throws `PermissionsError` with code `SCHEMA_INVALID` carrying Cedar's
	 * diagnostics when the schema does not parse.
	 */
	ensure(binding: CedarBinding, vocabHash: string, schemaJson: Schema): string {
		const name = this.nameFor(vocabHash);
		if (this.#names.has(name)) {
			return name;
		}

		this.#preparses += 1;
		unwrapCheckParse(binding.preparseSchema(name, schemaJson), {
			code: "SCHEMA_INVALID",
			message: `Cedar rejected the schema registered as "${name}"`,
		});

		this.#names.add(name);
		return name;
	}

	/**
	 * Forgets every registered name.
	 *
	 * Only drops the JS-side memo — cedar-wasm has no unregister API, so the
	 * schemas stay resident and a later `ensure` for the same hash simply
	 * re-registers over them.
	 */
	clear(): void {
		this.#names.clear();
	}
}
