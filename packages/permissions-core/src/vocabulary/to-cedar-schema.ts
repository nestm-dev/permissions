// `VocabularyDef` -> Cedar JSON schema.
//
// The output shape is pinned by cedar-wasm's own `SchemaJson<string>` /
// `NamespaceDefinition` types, and `tests/integration/cedar.test.ts` feeds a
// realistic vocabulary through the real `checkParseSchema` so the mapping is
// verified against Cedar itself, not against this comment.

import type {
	ActionEntityUID,
	ActionType,
	ApplySpec,
	EntityType,
	NamespaceDefinition,
	RecordType,
	SchemaJson,
	Type,
	TypeOfAttribute,
} from "../cedar/binding.ts";
import { ACTION_ENTITY_TYPE } from "../cedar/uid.ts";
import type { ActionDef, AnyAttrSpec, AttrSpecRecord, EntityDef, VocabularyDef } from "./types.ts";

/** A Cedar record type, the only shape allowed for entity shapes and action contexts. */
type CedarRecordType = { type: "Record" } & RecordType<string>;

/** An action entry that declares neither principal nor resource is an action group. */
export function isActionGroupDef(action: ActionDef): boolean {
	return action.principal === undefined && action.resource === undefined;
}

function required<T>(value: T | undefined, kind: string, field: string): T {
	if (value === undefined) {
		// Unreachable through `defineVocabulary`, which validates first; reachable
		// if someone hand-builds an `AttrSpec`.
		throw new TypeError(`A ${kind} attribute spec is missing its "${field}".`);
	}
	return value;
}

/** One attribute spec -> Cedar `Type`. Recurses through `Set` and `Record`. */
export function attrSpecToCedarType(spec: AnyAttrSpec): Type<string> {
	switch (spec.kind) {
		case "String": {
			return { type: "String" };
		}
		case "Long": {
			return { type: "Long" };
		}
		case "Boolean": {
			return { type: "Boolean" };
		}
		case "Set": {
			return {
				type: "Set",
				element: attrSpecToCedarType(required(spec.element, "Set", "element")),
			};
		}
		case "Record": {
			return attrsToCedarRecordType(required(spec.attributes, "Record", "attributes"));
		}
		case "Entity": {
			// Unqualified: Cedar resolves the name inside the declaring namespace.
			return { type: "Entity", name: required(spec.entity, "Entity", "entity") };
		}
		case "Extension": {
			return { type: "Extension", name: required(spec.extension, "Extension", "extension") };
		}
		default: {
			throw new TypeError(`Unknown attribute kind "${String(spec.kind)}".`);
		}
	}
}

/** One attribute spec -> Cedar `TypeOfAttribute`, i.e. a type plus `required`. */
export function attrSpecToTypeOfAttribute(spec: AnyAttrSpec): TypeOfAttribute<string> {
	const type = attrSpecToCedarType(spec);
	// Cedar defaults `required` to true; emitting it only when false keeps the
	// generated JSON small and diffable.
	return spec.required ? type : { ...type, required: false };
}

/** A bag of attribute specs -> a Cedar `Record` type. */
export function attrsToCedarRecordType(attrs: AttrSpecRecord): CedarRecordType {
	const attributes: Record<string, TypeOfAttribute<string>> = {};

	for (const [name, spec] of Object.entries(attrs)) {
		attributes[name] = attrSpecToTypeOfAttribute(spec);
	}

	return { type: "Record", attributes };
}

function entityDefToCedar(entity: EntityDef): EntityType<string> {
	const result: {
		memberOfTypes?: string[];
		shape?: CedarRecordType;
	} = {};

	if (entity.memberOf !== undefined && entity.memberOf.length > 0) {
		result.memberOfTypes = [...entity.memberOf];
	}

	if (entity.attrs !== undefined && Object.keys(entity.attrs).length > 0) {
		result.shape = attrsToCedarRecordType(entity.attrs);
	}

	return result;
}

function actionDefToCedar(action: ActionDef): ActionType<string> {
	const result: {
		memberOf?: ActionEntityUID<string>[];
		appliesTo?: ApplySpec<string>;
	} = {};

	if (action.memberOf !== undefined && action.memberOf.length > 0) {
		// `type` is omitted: an unqualified parent resolves to `Action` in the
		// declaring namespace, which is the only place a vocabulary can declare one.
		result.memberOf = action.memberOf.map((id) => ({ id }));
	}

	if (!isActionGroupDef(action)) {
		const appliesTo: {
			principalTypes: string[];
			resourceTypes: string[];
			context?: CedarRecordType;
		} = {
			principalTypes: [...(action.principal ?? [])],
			resourceTypes: [...(action.resource ?? [])],
		};

		if (action.context !== undefined && Object.keys(action.context).length > 0) {
			appliesTo.context = attrsToCedarRecordType(action.context);
		}

		result.appliesTo = appliesTo;
	}

	return result;
}

/**
 * Builds the Cedar JSON schema for a vocabulary definition.
 *
 * Pure and deterministic: key order follows the definition's declaration order,
 * so the output is stable enough to snapshot and to hash for a cache key.
 * Performs no validation — `defineVocabulary` validates first, then calls this.
 */
export function toCedarSchemaJson(def: VocabularyDef): SchemaJson<string> {
	const entityTypes: Record<string, EntityType<string>> = {};
	for (const [name, entity] of Object.entries(def.entities)) {
		entityTypes[name] = entityDefToCedar(entity);
	}

	const actions: Record<string, ActionType<string>> = {};
	for (const [id, action] of Object.entries(def.actions)) {
		actions[id] = actionDefToCedar(action);
	}

	const namespace: NamespaceDefinition<string> = { entityTypes, actions };

	return { [def.namespace]: namespace };
}

/** Namespace-qualified names of every entity type a definition declares. */
export function entityTypeNamesOf(def: VocabularyDef): string[] {
	return Object.keys(def.entities).map((name) => `${def.namespace}::${name}`);
}

/** The Cedar entity type actions live under, e.g. `Station::Action`. */
export function actionEntityTypeOf(def: VocabularyDef): string {
	return `${def.namespace}::${ACTION_ENTITY_TYPE}`;
}
