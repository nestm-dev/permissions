import type { CedarBinding, EntityUid, SchemaJson } from "../cedar/binding.ts";
import type { EntityRef } from "../cedar/uid.ts";

// ---------------------------------------------------------------------------
// Attribute specs
// ---------------------------------------------------------------------------

/** The Cedar type kinds an attribute spec can describe. */
export type AttrKind = "String" | "Long" | "Boolean" | "Set" | "Record" | "Entity" | "Extension";

/** Cedar extension types usable as attribute or context types. */
export type ExtensionName = "datetime" | "duration" | "ipaddr" | "decimal";

/** TypeScript value each Cedar extension type is authored as. */
export interface ExtensionValueMap {
	readonly datetime: Date;
	/** Milliseconds. */
	readonly duration: number;
	readonly ipaddr: string;
	/** Decimal literal, e.g. `"1.25"` — never a float, which would lose precision. */
	readonly decimal: string;
}

/** The authored TypeScript value for an extension type. */
export type ExtensionValue<N extends ExtensionName> = ExtensionValueMap[N];

/**
 * A declared attribute or context field.
 *
 * `V` is a phantom type parameter: `valueType` is never present at runtime, it
 * exists so `ContextFor` / `AttrsFor` can recover the authored TypeScript type
 * of an attribute from the spec alone.
 */
export interface AttrSpec<K extends AttrKind = AttrKind, V = unknown> {
	readonly kind: K;
	/** `false` only via `t.optional(...)`. Drives Cedar's `required` flag. */
	readonly required: boolean;
	/** Element spec, for `Set`. */
	readonly element?: AnyAttrSpec;
	/** Field specs, for `Record`. */
	readonly attributes?: AttrSpecRecord;
	/** Vocabulary-local entity name, for `Entity`. */
	readonly entity?: string;
	/** Extension name, for `Extension`. */
	readonly extension?: ExtensionName;
	/** Phantom carrier. Never assigned; reading it at runtime always yields `undefined`. */
	readonly valueType?: V;
}

/** Any attribute spec, whatever its kind or authored value type. */
export type AnyAttrSpec = AttrSpec<AttrKind, unknown>;

/** A bag of named attribute specs — entity `attrs`, action `context`, `t.record(...)`. */
export type AttrSpecRecord = Readonly<Record<string, AnyAttrSpec>>;

/** Recovers the authored TypeScript value type of an attribute spec. */
export type AttrValueOf<A> = A extends AttrSpec<AttrKind, infer V> ? V : never;

type OptionalMarker = { readonly required: false };

type RequiredAttrKeys<R extends AttrSpecRecord> = {
	[K in keyof R]: R[K] extends OptionalMarker ? never : K;
}[keyof R];

type OptionalAttrKeys<R extends AttrSpecRecord> = {
	[K in keyof R]: R[K] extends OptionalMarker ? K : never;
}[keyof R];

/** Collapses an intersection into one object type so hover text and errors stay readable. */
export type Simplify<T> = { [K in keyof T]: T[K] } & {};

/**
 * Turns a bag of attribute specs into the object type an author writes, with
 * `t.optional(...)` fields becoming optional properties.
 */
export type AttrsToObject<R extends AttrSpecRecord> = Simplify<
	{ readonly [K in RequiredAttrKeys<R>]: AttrValueOf<R[K]> } & {
		readonly [K in OptionalAttrKeys<R>]?: AttrValueOf<R[K]>;
	}
>;

// ---------------------------------------------------------------------------
// Vocabulary definition
// ---------------------------------------------------------------------------

/** One entity type in a vocabulary. */
export interface EntityDef {
	/** Entity types this one may be `in` (Cedar `memberOfTypes`). */
	readonly memberOf?: readonly string[];
	/** Declared attributes. Anything absent here is an evaluation error in Cedar. */
	readonly attrs?: AttrSpecRecord;
}

/**
 * One action in a vocabulary.
 *
 * An entry that declares **neither** `principal` nor `resource` is an **action
 * group** — the Cedar-native `run:*` idiom. Groups are not requestable (Cedar
 * rejects a request whose action has no valid principal type), so they are
 * excluded from `ActionOf<V>` and only appear in `ActionGroupOf<V>`.
 * Declaring exactly one of the two is a validation error.
 */
export interface ActionDef {
	/** Entity types allowed as the principal. Required for a requestable action. */
	readonly principal?: readonly string[];
	/** Entity types allowed as the resource. Required for a requestable action. */
	readonly resource?: readonly string[];
	/** Declared request-context fields. */
	readonly context?: AttrSpecRecord;
	/** Action groups this action belongs to. */
	readonly memberOf?: readonly string[];
}

/** The literal object passed to `defineVocabulary`. */
export interface VocabularyDef {
	/** Cedar namespace, e.g. `"Station"`. Must be a non-empty Cedar identifier path. */
	readonly namespace: string;
	readonly entities: Readonly<Record<string, EntityDef>>;
	readonly actions: Readonly<Record<string, ActionDef>>;
}

// ---------------------------------------------------------------------------
// The built vocabulary
// ---------------------------------------------------------------------------

/**
 * The result of `defineVocabulary` — one source, two outputs: a Cedar
 * `SchemaJson` for the engine and a set of string-literal unions for callers.
 *
 * Building one performs **no** Cedar work (delta D3): it is pure TypeScript, so
 * importing a vocabulary never pulls the WASM into a bundle. Cedar-side
 * validation is on demand via `validateVocabulary` and at `PermissionsEngine.create()`.
 */
export interface Vocabulary<D extends VocabularyDef = VocabularyDef> {
	/** Cedar namespace every entity and action in this vocabulary lives in. */
	readonly namespace: D["namespace"];
	/** The definition as authored. Retained so derived types stay recoverable. */
	readonly def: D;
	/** Cedar JSON schema, ready for `preparseSchema` / `checkParseSchema`. */
	readonly cedarSchemaJson: SchemaJson<string>;
	/** Namespace-qualified entity type names, in declaration order. */
	readonly entityTypeNames: readonly string[];
	/** Action ids that can be the `action` of a request, in declaration order. */
	readonly actionNames: readonly ActionNameOf<D>[];
	/** Action ids that are groups, in declaration order. */
	readonly actionGroupNames: readonly ActionGroupNameOf<D>[];
	/**
	 * Renders the schema as Cedar schema text. Docs and debugging only.
	 *
	 * Takes the binding explicitly rather than loading it, so that neither this
	 * interface nor its implementation can pull the WASM in (delta D3). Callers
	 * that want the convenience use `renderVocabularySchemaText`.
	 */
	toCedarSchemaText(binding: CedarBinding): string;
	/** `"run:dispatch"` -> `Station::Action::"run:dispatch"`. */
	actionUid(action: AnyActionNameOf<D>): EntityUid;
	/** `{ type: "Run", id: "r1" }` -> `Station::Run::"r1"`. */
	entityUid(ref: EntityRef<EntityNameOfDef<D>>): EntityUid;
	/**
	 * Requestable actions that are transitively members of `group`, in
	 * declaration order. Nested groups are traversed but not themselves returned.
	 */
	actionsInGroup(group: ActionGroupNameOf<D>): readonly ActionNameOf<D>[];
}

/**
 * Any vocabulary, whatever it declares — the bound for every engine, request
 * and decorator generic.
 *
 * Written out rather than aliased to `Vocabulary<VocabularyDef>` because the
 * erased instantiation collapses the derived unions to `never`: `ActionDef`
 * declares `principal` optionally, so `ActionNameOf<VocabularyDef>` is empty and
 * nothing would satisfy the constraint. The `VocabularyBoundCheck` below keeps
 * the two shapes from drifting apart.
 */
export interface AnyVocabulary {
	readonly namespace: string;
	readonly def: VocabularyDef;
	readonly cedarSchemaJson: SchemaJson<string>;
	readonly entityTypeNames: readonly string[];
	readonly actionNames: readonly string[];
	readonly actionGroupNames: readonly string[];
	toCedarSchemaText(binding: CedarBinding): string;
	actionUid(action: string): EntityUid;
	entityUid(ref: EntityRef<string>): EntityUid;
	actionsInGroup(group: string): readonly string[];
}

type Assert<T extends true> = T;

/**
 * Compile-time guard: this alias stops resolving the moment `Vocabulary<D>`
 * drifts out of {@link AnyVocabulary}.
 *
 * @internal
 */
export type AssertVocabularyBound = Assert<
	Vocabulary<VocabularyDef> extends AnyVocabulary ? true : false
>;

/** The definition behind a vocabulary. */
export type DefOf<V extends AnyVocabulary> = V["def"];

// ---------------------------------------------------------------------------
// Derived unions — all defined over the definition, then lifted to `Vocabulary`
// ---------------------------------------------------------------------------

/** Every action id in a definition, groups included. */
export type AnyActionNameOf<D extends VocabularyDef> = Extract<keyof D["actions"], string>;

/** Every entity type name in a definition. */
export type EntityNameOfDef<D extends VocabularyDef> = Extract<keyof D["entities"], string>;

/** An action entry is requestable iff it declares a principal or a resource list. */
type IsRequestable<A> = A extends { readonly principal: readonly string[] }
	? true
	: A extends { readonly resource: readonly string[] }
		? true
		: false;

/** Requestable action ids in a definition. */
export type ActionNameOf<D extends VocabularyDef> = {
	[K in AnyActionNameOf<D>]: IsRequestable<D["actions"][K]> extends true ? K : never;
}[AnyActionNameOf<D>];

/** Action-group ids in a definition. */
export type ActionGroupNameOf<D extends VocabularyDef> = {
	[K in AnyActionNameOf<D>]: IsRequestable<D["actions"][K]> extends true ? never : K;
}[AnyActionNameOf<D>];

/** The definition entry for one action. */
type ActionDefFor<D extends VocabularyDef, A> = D["actions"][A & keyof D["actions"]];

type PrincipalTypesOf<A> = A extends { readonly principal: readonly (infer P extends string)[] }
	? P
	: never;

type ResourceTypesOf<A> = A extends { readonly resource: readonly (infer R extends string)[] }
	? R
	: never;

type ContextAttrsOf<A> = A extends { readonly context: infer C extends AttrSpecRecord } ? C : never;

/** An action that declares no context accepts no context fields. */
export type EmptyContext = Readonly<Record<string, never>>;

/** Entity type names declared by a vocabulary. */
export type EntityNameOf<V extends AnyVocabulary> = EntityNameOfDef<DefOf<V>>;

/** Requestable action ids — the union `@RequirePermission(...)` type-checks against. */
export type ActionOf<V extends AnyVocabulary> = ActionNameOf<DefOf<V>>;

/** Action-group ids. Groups are never requestable; they exist to be named in policies. */
export type ActionGroupOf<V extends AnyVocabulary> = ActionGroupNameOf<DefOf<V>>;

/** Entity types allowed as the principal of `A`. */
export type PrincipalTypeFor<V extends AnyVocabulary, A extends ActionOf<V>> = PrincipalTypesOf<
	ActionDefFor<DefOf<V>, A>
>;

/** Entity types allowed as the resource of `A`. A mismatched pair is a compile error. */
export type ResourceTypeFor<V extends AnyVocabulary, A extends ActionOf<V>> = ResourceTypesOf<
	ActionDefFor<DefOf<V>, A>
>;

/** Every entity type that is the resource of at least one action. */
export type ResourceOf<V extends AnyVocabulary> = ResourceTypeFor<V, ActionOf<V>>;

/** Every entity type that is the principal of at least one action. */
export type PrincipalOf<V extends AnyVocabulary> = PrincipalTypeFor<V, ActionOf<V>>;

/** The request-context object type `A` accepts. */
export type ContextFor<V extends AnyVocabulary, A extends ActionOf<V>> = [
	ContextAttrsOf<ActionDefFor<DefOf<V>, A>>,
] extends [never]
	? EmptyContext
	: AttrsToObject<ContextAttrsOf<ActionDefFor<DefOf<V>, A>>>;

type EntityDefFor<D extends VocabularyDef, N> = D["entities"][N & keyof D["entities"]];

type EntityAttrsOf<E> = E extends { readonly attrs: infer A extends AttrSpecRecord } ? A : never;

/** The attribute object type entity `N` declares. `{}` when it declares none. */
export type AttrsFor<V extends AnyVocabulary, N extends EntityNameOf<V>> = [
	EntityAttrsOf<EntityDefFor<DefOf<V>, N>>,
] extends [never]
	? EmptyContext
	: AttrsToObject<EntityAttrsOf<EntityDefFor<DefOf<V>, N>>>;
