import type { CedarBinding, EntityUid } from "../cedar/binding.ts";
import { unwrapSchemaToText } from "../cedar/answers.ts";
import { actionUid as buildActionUid, entityRefToUid, type EntityRef } from "../cedar/uid.ts";
import { SchemaValidationError } from "../diagnostics/errors.ts";
import { entityTypeNamesOf, isActionGroupDef, toCedarSchemaJson } from "./to-cedar-schema.ts";
import type {
	ActionGroupNameOf,
	ActionNameOf,
	AnyActionNameOf,
	AnyAttrSpec,
	AttrSpecRecord,
	EntityNameOfDef,
	Vocabulary,
	VocabularyDef,
} from "./types.ts";

// ---------------------------------------------------------------------------
// Cedar identifier grammar
// ---------------------------------------------------------------------------

const IDENTIFIER = /^[_a-zA-Z][_a-zA-Z0-9]*$/;

/**
 * Cedar keywords, which the grammar forbids as bare identifiers.
 * `__cedar` is reserved for the language's own namespace.
 */
const RESERVED_IDENTIFIERS: ReadonlySet<string> = new Set([
	"true",
	"false",
	"if",
	"then",
	"else",
	"in",
	"is",
	"like",
	"has",
	"__cedar",
]);

function isCedarIdentifier(value: string): boolean {
	return IDENTIFIER.test(value) && !RESERVED_IDENTIFIERS.has(value);
}

/** A Cedar namespace is one or more `::`-joined identifiers. */
function isCedarNamespace(value: string): boolean {
	return value !== "" && value.split("::").every((segment) => isCedarIdentifier(segment));
}

// ---------------------------------------------------------------------------
// Structural validation
// ---------------------------------------------------------------------------

function fail(def: VocabularyDef, path: string, message: string): never {
	throw new SchemaValidationError(`${def.namespace || "<anonymous>"}: ${message}`, {
		namespace: def.namespace,
		path,
	});
}

function validateAttrs(
	def: VocabularyDef,
	path: string,
	attrs: AttrSpecRecord,
	entityNames: ReadonlySet<string>,
): void {
	for (const [name, spec] of Object.entries(attrs)) {
		validateAttr(def, `${path}.${name}`, name, spec, entityNames);
	}
}

function validateAttr(
	def: VocabularyDef,
	path: string,
	name: string,
	spec: AnyAttrSpec,
	entityNames: ReadonlySet<string>,
): void {
	if (name === "") {
		fail(def, path, `attribute names cannot be empty (at ${path}).`);
	}

	switch (spec.kind) {
		case "Set": {
			if (spec.element === undefined) {
				fail(def, path, `${path} is a Set with no element type; use t.set(t.string()).`);
			}
			validateAttr(def, `${path}[]`, name, spec.element, entityNames);
			return;
		}
		case "Record": {
			if (spec.attributes === undefined) {
				fail(def, path, `${path} is a Record with no fields; use t.record({ ... }).`);
			}
			validateAttrs(def, path, spec.attributes, entityNames);
			return;
		}
		case "Entity": {
			if (spec.entity === undefined || spec.entity === "") {
				fail(def, path, `${path} is an entity reference with no target; use t.ref("Name").`);
			}
			if (!entityNames.has(spec.entity)) {
				fail(
					def,
					path,
					`${path} references entity type "${spec.entity}", which is not declared under ` +
						`"entities". Declared: ${listNames(entityNames)}.`,
				);
			}
			return;
		}
		case "Extension": {
			if (spec.extension === undefined) {
				fail(def, path, `${path} is an extension type with no name; use t.ext("datetime").`);
			}
			return;
		}
		default: {
			return;
		}
	}
}

function listNames(names: Iterable<string>): string {
	const all = [...names];
	return all.length === 0 ? "(none)" : all.map((name) => `"${name}"`).join(", ");
}

function validateEntities(def: VocabularyDef, entityNames: ReadonlySet<string>): void {
	for (const [name, entity] of Object.entries(def.entities)) {
		const path = `entities.${name}`;

		if (!isCedarIdentifier(name)) {
			fail(
				def,
				path,
				`entity type "${name}" is not a valid Cedar identifier ` +
					`(letters, digits and underscores, not starting with a digit, not a keyword).`,
			);
		}

		if (name === "Action") {
			fail(def, path, `"Action" is reserved by Cedar and cannot be declared as an entity type.`);
		}

		const seen = new Set<string>();
		for (const [index, parent] of (entity.memberOf ?? []).entries()) {
			const parentPath = `${path}.memberOf[${index}]`;

			if (!entityNames.has(parent)) {
				fail(
					def,
					parentPath,
					`entity type "${name}" declares memberOf "${parent}", which is not declared under ` +
						`"entities". Declared: ${listNames(entityNames)}.`,
				);
			}
			if (seen.has(parent)) {
				fail(def, parentPath, `entity type "${name}" declares memberOf "${parent}" twice.`);
			}
			seen.add(parent);
		}

		if (entity.attrs !== undefined) {
			validateAttrs(def, `${path}.attrs`, entity.attrs, entityNames);
		}
	}
}

function validateActionAppliesTo(
	def: VocabularyDef,
	id: string,
	path: string,
	list: readonly string[] | undefined,
	role: "principal" | "resource",
	entityNames: ReadonlySet<string>,
): void {
	if (list === undefined) {
		return;
	}

	if (list.length === 0) {
		fail(
			def,
			`${path}.${role}`,
			`action "${id}" declares an empty ${role} list. Omit the key to make it an action group, ` +
				`or name at least one entity type.`,
		);
	}

	const seen = new Set<string>();
	for (const [index, type] of list.entries()) {
		const typePath = `${path}.${role}[${index}]`;

		if (!entityNames.has(type)) {
			fail(
				def,
				typePath,
				`action "${id}" declares ${role} type "${type}", which is not declared under ` +
					`"entities". Declared: ${listNames(entityNames)}.`,
			);
		}
		if (seen.has(type)) {
			fail(def, typePath, `action "${id}" declares ${role} type "${type}" twice.`);
		}
		seen.add(type);
	}
}

function validateActions(def: VocabularyDef, entityNames: ReadonlySet<string>): void {
	const actionIds = new Set(Object.keys(def.actions));
	const groupIds = new Set(
		Object.entries(def.actions)
			.filter(([, action]) => isActionGroupDef(action))
			.map(([id]) => id),
	);

	for (const [id, action] of Object.entries(def.actions)) {
		const path = `actions.${id}`;

		// Cedar action ids are arbitrary strings (verified), so the only hard
		// constraints are non-emptiness and printability.
		if (id === "") {
			fail(def, path, `action ids cannot be empty.`);
		}

		const isGroup = isActionGroupDef(action);

		if (!isGroup && (action.principal === undefined || action.resource === undefined)) {
			const missing = action.principal === undefined ? "principal" : "resource";
			fail(
				def,
				path,
				`action "${id}" declares ${missing === "principal" ? "resource" : "principal"} but not ` +
					`${missing}. A requestable action needs both; an action group needs neither.`,
			);
		}

		if (isGroup && action.context !== undefined) {
			fail(
				def,
				`${path}.context`,
				`action group "${id}" declares a context. Groups are never requested directly, so a ` +
					`context on one is dead weight — declare it on the member actions instead.`,
			);
		}

		validateActionAppliesTo(def, id, path, action.principal, "principal", entityNames);
		validateActionAppliesTo(def, id, path, action.resource, "resource", entityNames);

		if (action.context !== undefined) {
			validateAttrs(def, `${path}.context`, action.context, entityNames);
		}

		const seen = new Set<string>();
		for (const [index, group] of (action.memberOf ?? []).entries()) {
			const groupPath = `${path}.memberOf[${index}]`;

			if (!actionIds.has(group)) {
				fail(
					def,
					groupPath,
					`action "${id}" declares memberOf "${group}", which is not declared under "actions". ` +
						`Declare the group as an action with neither "principal" nor "resource".`,
				);
			}
			if (!groupIds.has(group)) {
				fail(
					def,
					groupPath,
					`action "${id}" declares memberOf "${group}", but "${group}" is a requestable action, ` +
						`not an action group. Only actions declaring neither "principal" nor "resource" ` +
						`can be group parents.`,
				);
			}
			if (group === id) {
				fail(def, groupPath, `action "${id}" declares itself as its own group.`);
			}
			if (seen.has(group)) {
				fail(def, groupPath, `action "${id}" declares memberOf "${group}" twice.`);
			}
			seen.add(group);
		}
	}

	assertNoGroupCycles(def);
}

/**
 * Cedar rejects a cyclic action hierarchy, but only once the schema reaches the
 * WASM — which under delta D3 may be much later than `defineVocabulary`.
 */
function assertNoGroupCycles(def: VocabularyDef): void {
	const visiting = new Set<string>();
	const done = new Set<string>();

	const visit = (id: string, trail: readonly string[]): void => {
		if (done.has(id)) {
			return;
		}
		if (visiting.has(id)) {
			fail(
				def,
				`actions.${id}.memberOf`,
				`action group cycle: ${[...trail, id].map((step) => `"${step}"`).join(" -> ")}.`,
			);
		}

		visiting.add(id);
		for (const parent of def.actions[id]?.memberOf ?? []) {
			visit(parent, [...trail, id]);
		}
		visiting.delete(id);
		done.add(id);
	};

	for (const id of Object.keys(def.actions)) {
		visit(id, []);
	}
}

/**
 * Validates a vocabulary definition structurally, without Cedar.
 *
 * Catches everything reachable from the definition alone: identifier grammar,
 * unknown `memberOf` / `t.ref` targets, malformed action groups and group
 * cycles. Cedar-level checks stay in `validateVocabulary`.
 *
 * @throws {@link SchemaValidationError} with a `path` into the definition.
 */
export function assertValidVocabularyDef(def: VocabularyDef): void {
	if (!isCedarNamespace(def.namespace)) {
		fail(
			def,
			"namespace",
			def.namespace === ""
				? `a vocabulary needs a non-empty namespace, e.g. { namespace: "Station", ... }.`
				: `namespace "${def.namespace}" is not a valid Cedar namespace. Expected one or more ` +
						`"::"-joined identifiers, e.g. "Station" or "Acme::Station".`,
		);
	}

	const entityNames = new Set(Object.keys(def.entities));
	validateEntities(def, entityNames);
	validateActions(def, entityNames);
}

// ---------------------------------------------------------------------------
// The builder
// ---------------------------------------------------------------------------

function collectGroupMembers(def: VocabularyDef): ReadonlyMap<string, readonly string[]> {
	const directMembers = new Map<string, string[]>();

	for (const [id, action] of Object.entries(def.actions)) {
		for (const group of action.memberOf ?? []) {
			const members = directMembers.get(group);
			if (members === undefined) {
				directMembers.set(group, [id]);
			} else {
				members.push(id);
			}
		}
	}

	const transitive = new Map<string, readonly string[]>();

	for (const [id, action] of Object.entries(def.actions)) {
		if (!isActionGroupDef(action)) {
			continue;
		}

		const collected: string[] = [];
		const seen = new Set<string>();
		const queue = [...(directMembers.get(id) ?? [])];

		while (queue.length > 0) {
			const member = queue.shift() as string;
			if (seen.has(member)) {
				continue;
			}
			seen.add(member);

			if (isActionGroupDef(def.actions[member] ?? {})) {
				queue.push(...(directMembers.get(member) ?? []));
			} else {
				collected.push(member);
			}
		}

		// Declaration order, not discovery order: a vocabulary is read top-down.
		const order = Object.keys(def.actions);
		transitive.set(
			id,
			collected.toSorted((left, right) => order.indexOf(left) - order.indexOf(right)),
		);
	}

	return transitive;
}

/**
 * Builds a typed vocabulary: one Cedar JSON schema plus the string-literal
 * unions the engine, the guard decorators and the ORM drivers narrow against.
 *
 * **No Cedar work happens here** (delta D3). The builder is pure TypeScript, so
 * importing a vocabulary from a browser bundle costs nothing; Cedar validates
 * the generated schema on demand via `validateVocabulary`, and unconditionally
 * inside `PermissionsEngine.create()`.
 *
 * @throws {@link SchemaValidationError} when the definition is structurally
 * invalid — unknown `memberOf` or `t.ref` targets, a malformed action group, a
 * group cycle, or an identifier Cedar's grammar rejects.
 *
 * @example
 * ```ts
 * export const stationVocabulary = defineVocabulary({
 *   namespace: "Station",
 *   entities: {
 *     Organization: {},
 *     Run: { memberOf: ["Project"], attrs: { status: t.string() } },
 *   },
 *   actions: {
 *     "run:*": {},
 *     "run:dispatch": { memberOf: ["run:*"], principal: ["Member"], resource: ["Run"] },
 *   },
 * });
 *
 * type StationAction = ActionOf<typeof stationVocabulary>;   // "run:dispatch"
 * ```
 */
export function defineVocabulary<const D extends VocabularyDef>(def: D): Vocabulary<D> {
	assertValidVocabularyDef(def);

	const cedarSchemaJson = toCedarSchemaJson(def);
	const groupMembers = collectGroupMembers(def);
	const entries = Object.entries(def.actions);

	const vocabulary: Vocabulary<D> = {
		namespace: def.namespace,
		def,
		cedarSchemaJson,
		entityTypeNames: entityTypeNamesOf(def),
		actionNames: entries
			.filter(([, action]) => !isActionGroupDef(action))
			.map(([id]) => id) as ActionNameOf<D>[],
		actionGroupNames: entries
			.filter(([, action]) => isActionGroupDef(action))
			.map(([id]) => id) as ActionGroupNameOf<D>[],

		toCedarSchemaText(binding: CedarBinding): string {
			return unwrapSchemaToText(binding.schemaToText(cedarSchemaJson), {
				code: "SCHEMA_INVALID",
				message: `Cedar could not render the schema for namespace "${def.namespace}"`,
			});
		},

		actionUid(action: AnyActionNameOf<D>): EntityUid {
			return buildActionUid(def.namespace, action);
		},

		entityUid(ref: EntityRef<EntityNameOfDef<D>>): EntityUid {
			return entityRefToUid(ref, def.namespace);
		},

		actionsInGroup(group: ActionGroupNameOf<D>): readonly ActionNameOf<D>[] {
			return (groupMembers.get(group) ?? []) as readonly ActionNameOf<D>[];
		},
	};

	return Object.freeze(vocabulary);
}
