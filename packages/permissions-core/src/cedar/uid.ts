import type { EntityUid, EntityUidJson, TypeAndId } from "./binding.ts";

/**
 * A typed reference to a Cedar entity.
 *
 * `type` is the vocabulary-local entity name (`"Run"`), not the Cedar-qualified
 * one (`"Station::Run"`) — qualification is the vocabulary's job, so the same
 * ref is reusable across namespaces and readable in logs.
 */
export interface EntityRef<T extends string = string> {
	readonly type: T;
	readonly id: string;
}

/** Cedar's namespace separator. */
export const NAMESPACE_SEPARATOR = "::";

/** Cedar reserves the `Action` entity type inside every namespace. */
export const ACTION_ENTITY_TYPE = "Action";

/** Terse constructor for an {@link EntityRef}, mostly for tests and fixtures. */
export function entityRef<T extends string>(type: T, id: string): EntityRef<T> {
	return { type, id };
}

/**
 * Prefixes `type` with `namespace`. A blank namespace, or a `type` that is
 * already qualified, is returned untouched.
 */
export function qualifyEntityType(namespace: string, type: string): string {
	if (namespace === "" || type.includes(NAMESPACE_SEPARATOR)) {
		return type;
	}
	return `${namespace}${NAMESPACE_SEPARATOR}${type}`;
}

/** Inverse of {@link qualifyEntityType}; leaves unrelated qualifications alone. */
export function unqualifyEntityType(namespace: string, type: string): string {
	const prefix = `${namespace}${NAMESPACE_SEPARATOR}`;
	return namespace !== "" && type.startsWith(prefix) ? type.slice(prefix.length) : type;
}

/**
 * Flattens Cedar's two accepted UID encodings (`{ type, id }` and the
 * `{ __entity: { type, id } }` escape form) into the plain one.
 */
export function normalizeEntityUid(uid: EntityUidJson): TypeAndId {
	return "__entity" in uid ? uid.__entity : uid;
}

/** `EntityRef` -> Cedar `EntityUid`, qualifying the type with `namespace`. */
export function entityRefToUid(ref: EntityRef, namespace = ""): EntityUid {
	return { type: qualifyEntityType(namespace, ref.type), id: ref.id };
}

/** Cedar `EntityUid` -> `EntityRef`, stripping a leading `namespace::`. */
export function entityUidToRef(uid: EntityUidJson, namespace = ""): EntityRef {
	const { type, id } = normalizeEntityUid(uid);
	return { type: unqualifyEntityType(namespace, type), id };
}

/** Cedar `EntityUid` for an action id inside `namespace`, e.g. `Station::Action::"run:dispatch"`. */
export function actionUid(namespace: string, actionId: string): EntityUid {
	return { type: qualifyEntityType(namespace, ACTION_ENTITY_TYPE), id: actionId };
}

// A backslash or a double quote inside a Cedar literal terminates it early (or,
// in a hand-built policy string, injects); control characters are not
// representable verbatim. Everything else passes through unchanged.
const ESCAPE_SEQUENCES: Readonly<Record<string, string>> = {
	"\\": "\\\\",
	'"': '\\"',
	"\n": "\\n",
	"\r": "\\r",
	"\t": "\\t",
	"\0": "\\0",
};

/** Exclusive upper bound of the C0 control range. */
const C0_END = 0x20;
/** Inclusive bounds of the DEL + C1 control range. */
const C1_START = 0x7f;
const C1_END = 0x9f;

/**
 * Escapes a string for use inside a Cedar double-quoted literal.
 *
 * Getting this wrong is how an entity id containing `"` becomes a syntax error
 * — or, in a hand-built policy string, an injection.
 */
export function escapeCedarString(value: string): string {
	let out = "";

	for (const character of value) {
		const known = ESCAPE_SEQUENCES[character];
		if (known !== undefined) {
			out += known;
			continue;
		}

		const code = character.codePointAt(0) ?? 0;
		out +=
			code < C0_END || (code >= C1_START && code <= C1_END)
				? `\\u{${code.toString(16)}}`
				: character;
	}

	return out;
}

const ESCAPE_CHARACTERS: Readonly<Record<string, string>> = {
	"\\": "\\",
	'"': '"',
	"'": "'",
	n: "\n",
	r: "\r",
	t: "\t",
	"0": "\0",
};

/** Inverse of {@link escapeCedarString}. Throws `SyntaxError` on a malformed escape. */
export function unescapeCedarString(value: string): string {
	let out = "";

	for (let index = 0; index < value.length; index += 1) {
		const character = value[index];

		if (character !== "\\") {
			out += character;
			continue;
		}

		const next = value[index + 1];
		if (next === undefined) {
			throw new SyntaxError(`Unterminated escape sequence in Cedar string: ${value}`);
		}

		if (next === "u") {
			if (value[index + 2] !== "{") {
				throw new SyntaxError(`Expected a braced unicode escape in Cedar string: ${value}`);
			}
			const end = value.indexOf("}", index + 3);
			if (end === -1) {
				throw new SyntaxError(`Unterminated unicode escape in Cedar string: ${value}`);
			}
			out += String.fromCodePoint(Number.parseInt(value.slice(index + 3, end), 16));
			index = end;
			continue;
		}

		const decoded = ESCAPE_CHARACTERS[next];
		if (decoded === undefined) {
			throw new SyntaxError(`Unknown escape sequence in Cedar string: ${value}`);
		}
		out += decoded;
		index += 1;
	}

	return out;
}

/** Cedar display form of a UID: `Ns::Type::"id"`, with `id` fully escaped. */
export function formatEntityUid(uid: EntityUidJson): string {
	const { type, id } = normalizeEntityUid(uid);
	return `${type}${NAMESPACE_SEPARATOR}"${escapeCedarString(id)}"`;
}

/** {@link formatEntityUid} for an {@link EntityRef}, qualified with `namespace`. */
export function formatEntityRef(ref: EntityRef, namespace = ""): string {
	return formatEntityUid(entityRefToUid(ref, namespace));
}

/** Inverse of {@link formatEntityUid}. Throws `SyntaxError` on malformed input. */
export function parseEntityUid(display: string): EntityUid {
	const quoteStart = display.indexOf('"');
	const typeEnd = quoteStart - NAMESPACE_SEPARATOR.length;

	if (
		typeEnd < 1 ||
		!display.endsWith('"') ||
		display.length < quoteStart + 2 ||
		display.slice(typeEnd, quoteStart) !== NAMESPACE_SEPARATOR
	) {
		throw new SyntaxError(`Not a Cedar entity UID: ${display}`);
	}

	return {
		type: display.slice(0, typeEnd),
		id: unescapeCedarString(display.slice(quoteStart + 1, -1)),
	};
}

/** Structural equality for UIDs written in either encoding. */
export function entityUidEquals(left: EntityUidJson, right: EntityUidJson): boolean {
	const a = normalizeEntityUid(left);
	const b = normalizeEntityUid(right);
	return a.type === b.type && a.id === b.id;
}
