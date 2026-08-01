// The typed entity constructor.
//
// This file exists to move one specific failure from evaluation time to
// construction time. core.md §0 records it as the sharpest security edge in the
// whole feature: a policy condition that touches an attribute the entity does
// **not** carry does not evaluate to `false` — it *errors*, the policy lands in
// `errored[]`, and an errored `forbid` is dropped from the decision entirely.
// A typo in an attribute name therefore silently disables a deny rule.
//
// `entity()` refuses to build an entity whose attributes disagree with the
// vocabulary, so that typo is a `SchemaValidationError` thrown by the line that
// wrote it rather than a missing forbid nobody notices.

import type { CedarValueJson, EntityJson, EntityUidJson } from "../cedar/binding.ts";
import {
	entityRefToUid,
	normalizeEntityUid,
	qualifyEntityType,
	type EntityRef,
} from "../cedar/uid.ts";
import { SchemaValidationError } from "../diagnostics/errors.ts";
import type {
	AnyAttrSpec,
	AnyVocabulary,
	AttrSpecRecord,
	AttrsFor,
	EntityNameOf,
	ExtensionName,
} from "../vocabulary/types.ts";
import type { EntityGraph } from "./entity-provider.ts";

/** Cedar constructor function backing each extension type. */
const EXTENSION_FUNCTIONS: Readonly<Record<ExtensionName, string>> = {
	datetime: "datetime",
	duration: "duration",
	// Cedar spells the ipaddr constructor `ip(...)`, not `ipaddr(...)`.
	ipaddr: "ip",
	decimal: "decimal",
};

/** Everything {@link entity} needs beyond the type and the id. */
export interface EntityInit<V extends AnyVocabulary, N extends EntityNameOf<V>> {
	/**
	 * The entity's attributes, exactly as the vocabulary declares them.
	 *
	 * Every required attribute must be present; `t.optional(...)` ones may be
	 * absent; anything undeclared is a throw.
	 */
	readonly attrs: AttrsFor<V, N>;
	/**
	 * Direct parents. Each parent's type must appear in the entity's `memberOf`,
	 * because a parent Cedar's schema does not allow is a validation failure the
	 * engine would only surface at `preparseSchema`/authorization time.
	 */
	readonly parents?: readonly EntityRef[];
	/**
	 * Cedar entity tags.
	 *
	 * Unvalidated: the vocabulary builder does not model tags yet, so these are
	 * converted structurally and passed through. With request validation on, Cedar
	 * rejects tags the schema does not declare — treat this as an escape hatch for
	 * a hand-extended schema, not as a supported attribute channel.
	 */
	readonly tags?: Readonly<Record<string, unknown>>;
}

/** Options for {@link toCedarValue}. */
export interface ToCedarValueOptions {
	/** Namespace used to qualify entity-reference values. Default: none. */
	readonly namespace?: string;
	/** Path reported on a conversion failure, e.g. `context.startedAt`. */
	readonly path?: string;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return (
		typeof value === "object" && value !== null && !Array.isArray(value) && !(value instanceof Date)
	);
}

/**
 * Whether `value` looks like an {@link EntityRef}: an object whose *only* own
 * keys are `type` and `id`, both strings.
 *
 * A heuristic, and deliberately a narrow one — it is used only where no
 * attribute spec is available (tags, request context). Anywhere a spec exists,
 * the spec decides.
 */
function isEntityRef(value: unknown): value is EntityRef {
	if (!isPlainRecord(value)) {
		return false;
	}
	const keys = Object.keys(value);
	return (
		keys.length === 2 &&
		keys.includes("type") &&
		keys.includes("id") &&
		typeof value["type"] === "string" &&
		typeof value["id"] === "string"
	);
}

function reject(message: string, namespace: string | undefined, path: string): never {
	throw new SchemaValidationError(message, {
		...(namespace === undefined ? {} : { namespace }),
		path,
	});
}

function listNames(names: Iterable<string>): string {
	const all = [...names];
	return all.length === 0 ? "(none)" : all.map((name) => `"${name}"`).join(", ");
}

/**
 * Converts an authored JavaScript value into Cedar's JSON value form **without**
 * a schema to check it against.
 *
 * - an {@link EntityRef} becomes `{ __entity: { type, id } }`, namespace-qualified;
 * - a `Date` becomes `{ __extn: { fn: "datetime", arg: <ISO 8601> } }`;
 * - strings, numbers, booleans, `null`, arrays and plain records pass through
 *   (arrays and records recursively);
 * - anything already written in Cedar's `{ __entity }` / `{ __extn }` escape form
 *   passes through untouched, which is the escape hatch for `duration`,
 *   `ipaddr` and `decimal` values in a request context.
 *
 * Used for entity tags and for the request context, where the vocabulary either
 * declares nothing (tags) or where validation is Cedar's job under
 * `validateRequests` (context). Entity **attributes** go through the
 * spec-directed path inside {@link entity} instead.
 */
export function toCedarValue(value: unknown, options: ToCedarValueOptions = {}): CedarValueJson {
	const path = options.path ?? "value";

	if (value === null || value === undefined) {
		return null;
	}
	if (typeof value === "string" || typeof value === "boolean") {
		return value;
	}
	if (typeof value === "number") {
		return value;
	}
	if (value instanceof Date) {
		return { __extn: { fn: EXTENSION_FUNCTIONS.datetime, arg: value.toISOString() } };
	}
	if (Array.isArray(value)) {
		return value.map((element, index) =>
			toCedarValue(element, { ...options, path: `${path}[${String(index)}]` }),
		);
	}
	if (isEntityRef(value)) {
		return { __entity: normalizeEntityUid(entityRefToUid(value, options.namespace ?? "")) };
	}
	if (isPlainRecord(value)) {
		// Already-escaped Cedar forms are structurally records; recursing into them
		// would rewrite `__entity`/`__extn` payloads that are already correct.
		if ("__entity" in value || "__extn" in value) {
			return cedarEscapeThrough(value, path);
		}

		const record: Record<string, CedarValueJson> = {};
		for (const [key, nested] of Object.entries(value)) {
			if (nested === undefined) {
				continue;
			}
			record[key] = toCedarValue(nested, { ...options, path: `${path}.${key}` });
		}
		return record;
	}

	return reject(
		`${path} has type "${typeof value}", which has no Cedar representation.`,
		undefined,
		path,
	);
}

function cedarEscapeThrough(value: Record<string, unknown>, path: string): CedarValueJson {
	const entityPayload = value["__entity"];
	if (entityPayload !== undefined) {
		if (
			isPlainRecord(entityPayload) &&
			typeof entityPayload["type"] === "string" &&
			typeof entityPayload["id"] === "string"
		) {
			return { __entity: { type: entityPayload["type"], id: entityPayload["id"] } };
		}
		return reject(`${path}.__entity must be { type, id }, both strings.`, undefined, path);
	}

	const extensionPayload = value["__extn"];
	if (isPlainRecord(extensionPayload) && typeof extensionPayload["fn"] === "string") {
		const argument = extensionPayload["arg"];
		const argumentList = extensionPayload["args"];
		if (argument !== undefined) {
			return {
				__extn: {
					fn: extensionPayload["fn"],
					arg: toCedarValue(argument, { path: `${path}.__extn.arg` }),
				},
			};
		}
		if (Array.isArray(argumentList)) {
			return {
				__extn: {
					fn: extensionPayload["fn"],
					args: argumentList.map((element, index) =>
						toCedarValue(element, { path: `${path}.__extn.args[${String(index)}]` }),
					),
				},
			};
		}
	}

	return reject(`${path}.__extn must be { fn, arg } or { fn, args }.`, undefined, path);
}

function specToValue(
	spec: AnyAttrSpec,
	value: unknown,
	path: string,
	namespace: string,
): CedarValueJson {
	switch (spec.kind) {
		case "String": {
			if (typeof value !== "string") {
				reject(`${path} must be a string, received ${describe(value)}.`, namespace, path);
			}
			return value;
		}
		case "Long": {
			if (typeof value !== "number" || !Number.isInteger(value)) {
				reject(
					`${path} must be an integer (Cedar Long), received ${describe(value)}.`,
					namespace,
					path,
				);
			}
			return value;
		}
		case "Boolean": {
			if (typeof value !== "boolean") {
				reject(`${path} must be a boolean, received ${describe(value)}.`, namespace, path);
			}
			return value;
		}
		case "Set": {
			if (!Array.isArray(value)) {
				reject(
					`${path} must be an array (Cedar Set), received ${describe(value)}.`,
					namespace,
					path,
				);
			}
			const element = spec.element;
			if (element === undefined) {
				reject(`${path} is declared as a Set with no element type.`, namespace, path);
			}
			return value.map((entry, index) =>
				specToValue(element, entry, `${path}[${String(index)}]`, namespace),
			);
		}
		case "Record": {
			if (!isPlainRecord(value)) {
				reject(
					`${path} must be an object (Cedar Record), received ${describe(value)}.`,
					namespace,
					path,
				);
			}
			return specRecordToValue(spec.attributes ?? {}, value, path, namespace);
		}
		case "Entity": {
			return entityValue(spec, value, path, namespace);
		}
		case "Extension": {
			return extensionValue(spec, value, path, namespace);
		}
		default: {
			return reject(
				`${path} has an unknown attribute kind "${String(spec.kind)}".`,
				namespace,
				path,
			);
		}
	}
}

function entityValue(
	spec: AnyAttrSpec,
	value: unknown,
	path: string,
	namespace: string,
): CedarValueJson {
	const declared = spec.entity ?? "";

	if (isPlainRecord(value) && "__entity" in value) {
		return cedarEscapeThrough(value, path);
	}
	if (
		!isPlainRecord(value) ||
		typeof value["type"] !== "string" ||
		typeof value["id"] !== "string"
	) {
		reject(
			`${path} must be an entity reference { type: "${declared}", id }, received ${describe(value)}.`,
			namespace,
			path,
		);
	}

	const type: string = value["type"];
	const qualified = qualifyEntityType(namespace, declared);

	if (type !== declared && type !== qualified) {
		reject(
			`${path} references a "${type}", but the vocabulary declares it as a "${declared}".`,
			namespace,
			path,
		);
	}

	return { __entity: { type: qualified, id: value["id"] } };
}

function extensionValue(
	spec: AnyAttrSpec,
	value: unknown,
	path: string,
	namespace: string,
): CedarValueJson {
	const extension = spec.extension;

	if (extension === undefined) {
		reject(`${path} is declared as an extension type with no name.`, namespace, path);
	}
	if (isPlainRecord(value) && "__extn" in value) {
		return cedarEscapeThrough(value, path);
	}

	const fn = EXTENSION_FUNCTIONS[extension];

	switch (extension) {
		case "datetime": {
			if (value instanceof Date) {
				if (Number.isNaN(value.getTime())) {
					reject(`${path} is an Invalid Date.`, namespace, path);
				}
				return { __extn: { fn, arg: value.toISOString() } };
			}
			if (typeof value === "string") {
				return { __extn: { fn, arg: value } };
			}
			return reject(
				`${path} must be a Date (or a Cedar datetime literal), received ${describe(value)}.`,
				namespace,
				path,
			);
		}
		case "duration": {
			// The vocabulary authors durations as milliseconds; Cedar parses them
			// from a unit-suffixed literal, and `<n>ms` is the lossless spelling.
			if (typeof value === "number" && Number.isInteger(value)) {
				return { __extn: { fn, arg: `${String(value)}ms` } };
			}
			if (typeof value === "string") {
				return { __extn: { fn, arg: value } };
			}
			return reject(
				`${path} must be a whole number of milliseconds (or a Cedar duration literal), ` +
					`received ${describe(value)}.`,
				namespace,
				path,
			);
		}
		default: {
			// `ipaddr` and `decimal` are authored as strings — a float would lose
			// precision for `decimal`, which is the whole reason it is a string.
			if (typeof value === "string") {
				return { __extn: { fn, arg: value } };
			}
			return reject(
				`${path} must be a string holding a Cedar ${extension} literal, received ${describe(value)}.`,
				namespace,
				path,
			);
		}
	}
}

function specRecordToValue(
	specs: AttrSpecRecord,
	values: Readonly<Record<string, unknown>>,
	path: string,
	namespace: string,
): Record<string, CedarValueJson> {
	const declared = new Set(Object.keys(specs));

	for (const key of Object.keys(values)) {
		if (!declared.has(key)) {
			reject(
				`${path}.${key} is not declared by the vocabulary. Declared: ${listNames(declared)}. ` +
					`An undeclared attribute is invisible to Cedar: a policy that reads it errors, and an ` +
					`errored forbid is dropped from the decision.`,
				namespace,
				`${path}.${key}`,
			);
		}
	}

	const out: Record<string, CedarValueJson> = {};

	for (const [key, spec] of Object.entries(specs)) {
		const value = values[key];
		const memberPath = `${path}.${key}`;

		if (value === undefined) {
			if (spec.required) {
				reject(
					`${memberPath} is required by the vocabulary but was not provided.`,
					namespace,
					memberPath,
				);
			}
			continue;
		}

		out[key] = specToValue(spec, value, memberPath, namespace);
	}

	return out;
}

function describe(value: unknown): string {
	if (value === null) {
		return "null";
	}
	if (Array.isArray(value)) {
		return "an array";
	}
	if (value instanceof Date) {
		return "a Date";
	}
	return `a ${typeof value}`;
}

/**
 * Builds one Cedar entity from a vocabulary-checked description.
 *
 * Everything is namespace-qualified on the way out — the entity's own UID, its
 * parents, and every entity-typed attribute — so callers keep writing
 * vocabulary-local type names (`"Run"`, never `"Station::Run"`).
 *
 * Conversions: an `EntityRef` attribute becomes `{ __entity: { type, id } }`, a
 * `Date` becomes `{ __extn: { fn: "datetime", arg } }`, a duration becomes
 * `{ __extn: { fn: "duration", arg: "<ms>ms" } }`, and strings, numbers,
 * booleans, sets and records pass through structurally.
 *
 * @throws {@link SchemaValidationError} when the entity type is not declared, an
 * attribute is not declared, a **required** attribute is missing, an attribute
 * has the wrong shape, or a parent's type is not one of the entity's declared
 * `memberOf` types. Every one of those would otherwise become an *evaluation
 * error* inside Cedar — and an errored `forbid` disappears from the decision
 * (core.md §0), so catching it here is the difference between a loud failure at
 * construction and a silently missing deny rule at runtime.
 *
 * @example
 * ```ts
 * entity(stationVocabulary, "Run", "r1", {
 *   attrs: {
 *     project: { type: "Project", id: "p1" },
 *     status: "queued",
 *     createdBy: { type: "Member", id: "m1" },
 *     startedAt: new Date("2026-07-30T00:00:00Z"),   // optional, may be omitted
 *   },
 *   parents: [{ type: "Project", id: "p1" }],
 * });
 * ```
 */
export function entity<V extends AnyVocabulary, N extends EntityNameOf<V>>(
	vocabulary: V,
	type: N,
	id: string,
	init: EntityInit<V, N>,
): EntityJson {
	const namespace = vocabulary.namespace;
	const definition = vocabulary.def.entities[type];

	if (definition === undefined) {
		reject(
			`Entity type "${type}" is not declared by vocabulary "${namespace}". ` +
				`Declared: ${listNames(Object.keys(vocabulary.def.entities))}.`,
			namespace,
			`entities.${type}`,
		);
	}
	if (typeof id !== "string" || id === "") {
		reject(`Entity ${namespace}::${type} needs a non-empty id.`, namespace, `entities.${type}.id`);
	}

	const attrsInput: unknown = init.attrs;

	if (!isPlainRecord(attrsInput)) {
		reject(
			`entity(${namespace}::${type}) needs an "attrs" object; pass {} when the type ` +
				`declares no attributes.`,
			namespace,
			`entities.${type}.attrs`,
		);
	}

	const attrs = specRecordToValue(definition.attrs ?? {}, attrsInput, `${type}.attrs`, namespace);

	const allowedParents = new Set(definition.memberOf ?? []);
	const parents: EntityUidJson[] = [];

	for (const [index, parent] of (init.parents ?? []).entries()) {
		const parentPath = `entities.${type}.parents[${String(index)}]`;

		if (typeof parent?.type !== "string" || typeof parent.id !== "string") {
			reject(`${parentPath} must be an entity reference { type, id }.`, namespace, parentPath);
		}

		const local = parent.type.startsWith(`${namespace}::`)
			? parent.type.slice(namespace.length + 2)
			: parent.type;

		if (!allowedParents.has(local)) {
			reject(
				`${parentPath} is a "${local}", but "${type}" declares memberOf ` +
					`${listNames(allowedParents)}. Cedar rejects a parent the schema does not allow.`,
				namespace,
				parentPath,
			);
		}

		parents.push(entityRefToUid({ type: local, id: parent.id }, namespace));
	}

	const built: {
		uid: EntityUidJson;
		attrs: Record<string, CedarValueJson>;
		parents: EntityUidJson[];
		tags?: Record<string, CedarValueJson>;
	} = {
		uid: entityRefToUid({ type, id }, namespace),
		attrs,
		parents,
	};

	if (init.tags !== undefined) {
		const tags: Record<string, CedarValueJson> = {};
		for (const [key, value] of Object.entries(init.tags)) {
			if (value === undefined) {
				continue;
			}
			tags[key] = toCedarValue(value, { namespace, path: `${type}.tags.${key}` });
		}
		built.tags = tags;
	}

	return built;
}

function uidKey(uid: EntityUidJson): string {
	const flat = normalizeEntityUid(uid);
	return `${flat.type}\u0000${flat.id}`;
}

/**
 * Collects entities into a graph, dropping duplicate UIDs.
 *
 * Later entries win, so a caller can append a more complete version of an entity
 * an earlier resolver only stubbed. Deduplication is not cosmetic: Cedar rejects
 * an entity slice that lists the same UID twice, and the engine merges up to
 * three provider results into one call.
 *
 * ```ts
 * const graph = entityGraph(...principalGraph, ...resourceGraph);
 * ```
 */
export function entityGraph(...entities: readonly EntityJson[]): EntityGraph {
	const byUid = new Map<string, EntityJson>();

	for (const candidate of entities) {
		byUid.set(uidKey(candidate.uid), candidate);
	}

	return [...byUid.values()];
}
