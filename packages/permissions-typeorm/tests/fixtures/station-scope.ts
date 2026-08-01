// A station-shaped scope column: `uuid NOT NULL`, no global scope.
//
// Station's real codec is `toScope: (id) => 'org:' + id` over a uuid primary key.
// That cannot be used verbatim here, because core's conformance suite writes to
// the fixed scope ids `conformance:a` and `conformance:b` and a codec has to be a
// *pair of inverses* over whatever it is handed — `fromScope('conformance:a')`
// must produce a uuid that `toScope` turns back into `conformance:a`.
//
// So the fixture packs the scope id into the 16 bytes of a uuid: one length byte,
// then the UTF-8 bytes, then zero padding. Bijective for any scope id of at most
// 15 bytes, which both conformance scopes are. Postgres's `uuid` type stores 128
// arbitrary bits and does not validate the version nibble, so these are perfectly
// ordinary uuids as far as the database is concerned.
//
// What this fixture is actually testing is the *shape*: a `NOT NULL uuid` column
// with a non-identity codec and `supportsGlobalScope: false`, so `''` is rejected
// on write and skipped in the `load()` union — the branch station's deployment
// takes on every single query.

import type { ScopeColumnOptions } from "../../src/entities/create-entities.ts";

const UUID_BYTES = 16;
const MAX_PAYLOAD_BYTES = UUID_BYTES - 1;

/** Packs a scope id into a uuid's 16 bytes. Throws for the global scope. */
export function scopeToUuid(scope: string): string {
	if (scope === "") {
		throw new TypeError(
			"This schema's scope column is a NOT NULL uuid and cannot hold the global scope. " +
				"Seed per-tenant templates instead.",
		);
	}

	const payload = new TextEncoder().encode(scope);
	if (payload.length > MAX_PAYLOAD_BYTES) {
		throw new TypeError(
			`The station-shaped fixture codec holds at most ${String(MAX_PAYLOAD_BYTES)} UTF-8 ` +
				`bytes; "${scope}" is ${String(payload.length)}.`,
		);
	}

	const packed = new Uint8Array(UUID_BYTES);
	packed[0] = payload.length;
	packed.set(payload, 1);

	return formatUuid(packed);
}

/** The inverse of {@link scopeToUuid}. */
export function uuidToScope(value: string): string {
	const digits = value.replaceAll("-", "");
	const packed = new Uint8Array(UUID_BYTES);
	for (let index = 0; index < UUID_BYTES; index += 1) {
		packed[index] = Number.parseInt(digits.slice(index * 2, index * 2 + 2), 16);
	}
	const length = packed[0] ?? 0;
	return new TextDecoder().decode(packed.subarray(1, 1 + length));
}

/** The station-shaped scope column: `organization_id uuid NOT NULL`, no global scope. */
export function stationScopeColumn(): ScopeColumnOptions<string> {
	return {
		name: "organization_id",
		type: "uuid",
		toScope: uuidToScope,
		fromScope: scopeToUuid,
		supportsGlobalScope: false,
	};
}

function formatUuid(bytes: Uint8Array): string {
	const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
	return [
		hex.slice(0, 8),
		hex.slice(8, 12),
		hex.slice(12, 16),
		hex.slice(16, 20),
		hex.slice(20),
	].join("-");
}
