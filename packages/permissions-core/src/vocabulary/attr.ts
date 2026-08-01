import type { EntityRef } from "../cedar/uid.ts";
import type {
	AnyAttrSpec,
	AttrSpec,
	AttrSpecRecord,
	AttrValueOf,
	AttrsToObject,
	ExtensionName,
	ExtensionValue,
} from "./types.ts";

/** `t.string()` — Cedar `String`, authored as `string`. */
export type StringAttr = AttrSpec<"String", string>;

/** `t.long()` — Cedar `Long` (i64), authored as `number`. */
export type LongAttr = AttrSpec<"Long", number>;

/** `t.bool()` — Cedar `Boolean`. */
export type BoolAttr = AttrSpec<"Boolean", boolean>;

/** `t.set(el)` — Cedar `Set<el>`, authored as a readonly array. */
export type SetAttr<A extends AnyAttrSpec> = AttrSpec<"Set", readonly AttrValueOf<A>[]>;

/** `t.record(fields)` — Cedar `Record`, authored as an object. */
export type RecordAttr<R extends AttrSpecRecord> = AttrSpec<"Record", AttrsToObject<R>>;

/** `t.ref(name)` — Cedar `Entity`, authored as an {@link EntityRef}. */
export type RefAttr<N extends string> = AttrSpec<"Entity", EntityRef<N>>;

/** `t.ext(name)` — a Cedar extension type. */
export type ExtAttr<N extends ExtensionName> = AttrSpec<"Extension", ExtensionValue<N>>;

/** `t.optional(spec)` — same Cedar type, but the attribute may be absent. */
export type OptionalAttr<A extends AnyAttrSpec> = A & { readonly required: false };

/**
 * Attribute combinators for `defineVocabulary`.
 *
 * Every combinator returns a plain frozen object — there is no Cedar work here,
 * and no WASM is reachable from this module.
 *
 * @example
 * ```ts
 * attrs: {
 *   organization: t.ref("Organization"),
 *   labels: t.set(t.string()),
 *   startedAt: t.optional(t.ext("datetime")),
 * }
 * ```
 */
export const t = {
	/** Cedar `String`. */
	string(): StringAttr {
		return { kind: "String", required: true };
	},

	/** Cedar `Long` — a 64-bit integer. Authored as `number`; never a float. */
	long(): LongAttr {
		return { kind: "Long", required: true };
	},

	/** Cedar `Boolean`. */
	bool(): BoolAttr {
		return { kind: "Boolean", required: true };
	},

	/** Cedar `Set<element>`. */
	set<A extends AnyAttrSpec>(element: A): SetAttr<A> {
		return { kind: "Set", required: true, element };
	},

	/** Cedar `Record` with a closed set of fields. */
	record<R extends AttrSpecRecord>(attributes: R): RecordAttr<R> {
		return { kind: "Record", required: true, attributes };
	},

	/**
	 * Cedar `Entity` reference. `entity` is a **vocabulary-local** name; the
	 * builder rejects a name that is not declared under `entities`.
	 */
	ref<N extends string>(entity: N): RefAttr<N> {
		return { kind: "Entity", required: true, entity };
	},

	/** A Cedar extension type: `datetime`, `duration`, `ipaddr` or `decimal`. */
	ext<N extends ExtensionName>(name: N): ExtAttr<N> {
		return { kind: "Extension", required: true, extension: name };
	},

	/**
	 * Marks an attribute optional — Cedar `required: false`, and an optional
	 * property in the derived TypeScript type.
	 */
	optional<A extends AnyAttrSpec>(spec: A): OptionalAttr<A> {
		return { ...spec, required: false };
	},
} as const;

/** True when a spec was produced by `t.optional(...)`. */
export function isOptionalAttr(spec: AnyAttrSpec): boolean {
	return !spec.required;
}
