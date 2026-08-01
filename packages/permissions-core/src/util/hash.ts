// Stable structural hashing.
//
// Cache keys derived from `JSON.stringify` are wrong the moment two objects
// agree on content but not on key order — which is exactly what happens when a
// bundle round-trips through a database. Everything hashed in this package goes
// through `stableStringify` first.
//
// `node:crypto` is a Node builtin, not a dependency: core stays framework-free,
// not runtime-free (the package already declares `engines.node >= 22.12`).

import { createHash } from "node:crypto";

/** Default length of {@link shortHash} output, in hex characters. */
export const SHORT_HASH_LENGTH = 16;

function serialize(value: unknown, seen: Set<object>): string {
	if (value === null || value === undefined) {
		return "null";
	}

	switch (typeof value) {
		case "string": {
			return JSON.stringify(value);
		}
		case "number": {
			// `NaN`/`Infinity` are not JSON; tagging them keeps them distinguishable
			// from the string `"NaN"` because a real string would carry quotes.
			return Number.isFinite(value) ? JSON.stringify(value) : `#${String(value)}`;
		}
		case "boolean": {
			return value ? "true" : "false";
		}
		case "bigint": {
			return `#${value.toString()}n`;
		}
		case "function":
		case "symbol": {
			throw new TypeError(`stableStringify cannot hash a ${typeof value}`);
		}
		default: {
			break;
		}
	}

	const object: object = value;
	if (seen.has(object)) {
		throw new TypeError("stableStringify cannot hash a circular structure");
	}
	seen.add(object);

	try {
		if (Array.isArray(value)) {
			return `[${value.map((element) => serialize(element, seen)).join(",")}]`;
		}
		if (value instanceof Date) {
			return `#${value.toISOString()}`;
		}

		const record = value as Record<string, unknown>;
		const parts: string[] = [];
		for (const key of Object.keys(record).toSorted()) {
			const entry = record[key];
			// `undefined` members are dropped, matching `JSON.stringify`, so an
			// explicitly-absent optional property hashes like a missing one.
			if (entry === undefined || typeof entry === "function") {
				continue;
			}
			parts.push(`${JSON.stringify(key)}:${serialize(entry, seen)}`);
		}
		return `{${parts.join(",")}}`;
	} finally {
		seen.delete(object);
	}
}

/**
 * Deterministic JSON-ish serialisation: object keys sorted, `Date` rendered as
 * ISO, `bigint` tagged, `undefined` members dropped.
 *
 * Not a JSON parser's inverse — it is only ever fed to a hash.
 *
 * @throws {TypeError} on circular structures, functions and symbols.
 */
export function stableStringify(value: unknown): string {
	return serialize(value, new Set<object>());
}

/** Hex-encoded SHA-256 of a UTF-8 string. */
export function sha256Hex(input: string): string {
	return createHash("sha256").update(input, "utf8").digest("hex");
}

/** Hex-encoded SHA-256 of {@link stableStringify}`(value)`. */
export function stableHash(value: unknown): string {
	return sha256Hex(stableStringify(value));
}

/**
 * {@link stableHash} truncated to `length` characters.
 *
 * Used where the hash is an identifier rather than a security boundary — a
 * preparsed schema name, a cache key segment.
 */
export function shortHash(value: unknown, length: number = SHORT_HASH_LENGTH): string {
	return stableHash(value).slice(0, length);
}
