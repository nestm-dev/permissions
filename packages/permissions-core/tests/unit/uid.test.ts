import { describe, expect, it } from "vitest";

import {
	ACTION_ENTITY_TYPE,
	actionUid,
	entityRef,
	entityRefToUid,
	entityUidEquals,
	entityUidToRef,
	escapeCedarString,
	formatEntityRef,
	formatEntityUid,
	normalizeEntityUid,
	parseEntityUid,
	qualifyEntityType,
	unescapeCedarString,
	unqualifyEntityType,
} from "../../src/cedar/uid.ts";

const DEL = String.fromCodePoint(0x7f);
const BELL = String.fromCodePoint(0x07);

describe("qualifyEntityType / unqualifyEntityType", () => {
	it("qualifies a bare type", () => {
		expect(qualifyEntityType("Station", "Run")).toBe("Station::Run");
	});

	it("leaves an already-qualified type alone", () => {
		expect(qualifyEntityType("Station", "Other::Run")).toBe("Other::Run");
	});

	it("is a no-op for the anonymous namespace", () => {
		expect(qualifyEntityType("", "Run")).toBe("Run");
	});

	it("strips only its own prefix", () => {
		expect(unqualifyEntityType("Station", "Station::Run")).toBe("Run");
		expect(unqualifyEntityType("Station", "Other::Run")).toBe("Other::Run");
		expect(unqualifyEntityType("", "Station::Run")).toBe("Station::Run");
	});
});

describe("EntityRef <-> EntityUid", () => {
	it("round-trips through the namespace", () => {
		const ref = entityRef("Run", "r1");
		const uid = entityRefToUid(ref, "Station");

		expect(uid).toEqual({ type: "Station::Run", id: "r1" });
		expect(entityUidToRef(uid, "Station")).toEqual(ref);
	});

	it("accepts the __entity escape encoding", () => {
		expect(normalizeEntityUid({ __entity: { type: "Station::Run", id: "r1" } })).toEqual({
			type: "Station::Run",
			id: "r1",
		});
		expect(entityUidToRef({ __entity: { type: "Station::Run", id: "r1" } }, "Station")).toEqual({
			type: "Run",
			id: "r1",
		});
	});

	it("compares across encodings", () => {
		expect(
			entityUidEquals(
				{ type: "Station::Run", id: "r1" },
				{ __entity: { type: "Station::Run", id: "r1" } },
			),
		).toBe(true);
		expect(
			entityUidEquals({ type: "Station::Run", id: "r1" }, { type: "Station::Run", id: "r2" }),
		).toBe(false);
	});

	it("builds action UIDs under the reserved Action type", () => {
		expect(actionUid("Station", "run:dispatch")).toEqual({
			type: `Station::${ACTION_ENTITY_TYPE}`,
			id: "run:dispatch",
		});
	});
});

describe("escapeCedarString", () => {
	it("escapes quotes and backslashes", () => {
		expect(escapeCedarString('a"b')).toBe('a\\"b');
		expect(escapeCedarString("a\\b")).toBe("a\\\\b");
		expect(escapeCedarString('\\"')).toBe('\\\\\\"');
	});

	it("escapes the named control characters", () => {
		expect(escapeCedarString("a\nb\r\tc\0")).toBe("a\\nb\\r\\tc\\0");
	});

	it("escapes other control characters as braced code points", () => {
		expect(escapeCedarString(BELL)).toBe("\\u{7}");
		expect(escapeCedarString(DEL)).toBe("\\u{7f}");
	});

	it("leaves ordinary text untouched", () => {
		expect(escapeCedarString("run:dispatch")).toBe("run:dispatch");
		expect(escapeCedarString("héllo — 世界")).toBe("héllo — 世界");
	});
});

describe("escape / unescape round-trips", () => {
	const ids = [
		"plain",
		'quote-"-inside',
		"backslash-\\-inside",
		'both-"\\-inside',
		'\\"',
		'"\\"',
		"trailing-backslash-\\",
		"newline\nand\ttab",
		"nul\0byte",
		BELL,
		DEL,
		'Station::Run::"nested"',
		"héllo — 世界 🎉",
		"",
	];

	it.each(ids)("round-trips %j through escape/unescape", (id) => {
		expect(unescapeCedarString(escapeCedarString(id))).toBe(id);
	});

	it.each(ids)("round-trips %j through format/parse", (id) => {
		const uid = { type: "Station::Run", id };
		expect(parseEntityUid(formatEntityUid(uid))).toEqual(uid);
	});
});

describe("formatEntityUid / parseEntityUid", () => {
	it("renders the Cedar display form", () => {
		expect(formatEntityUid({ type: "Station::Run", id: "r1" })).toBe('Station::Run::"r1"');
		expect(formatEntityRef(entityRef("Run", "r1"), "Station")).toBe('Station::Run::"r1"');
	});

	it("escapes ids in the display form", () => {
		expect(formatEntityUid({ type: "Station::Run", id: 'a"b' })).toBe('Station::Run::"a\\"b"');
	});

	it("accepts the __entity encoding", () => {
		expect(formatEntityUid({ __entity: { type: "Station::Run", id: "r1" } })).toBe(
			'Station::Run::"r1"',
		);
	});

	it("parses ids containing the separator", () => {
		expect(parseEntityUid('Station::Run::"a::b"')).toEqual({ type: "Station::Run", id: "a::b" });
	});

	it("parses an empty id", () => {
		expect(parseEntityUid('Station::Run::""')).toEqual({ type: "Station::Run", id: "" });
	});

	it.each(["Station::Run", 'Station::Run"r1"', '::"r1"', '"r1"', 'Station::Run::"r1', ""])(
		"rejects %j",
		(bad) => {
			expect(() => parseEntityUid(bad)).toThrow(SyntaxError);
		},
	);
});

describe("unescapeCedarString", () => {
	it("decodes single-quote and braced escapes", () => {
		expect(unescapeCedarString("\\'")).toBe("'");
		expect(unescapeCedarString("\\u{1F389}")).toBe("🎉");
	});

	it.each(["\\", "\\q", "\\uABCD", "\\u{12"])("rejects the malformed escape %j", (bad) => {
		expect(() => unescapeCedarString(bad)).toThrow(SyntaxError);
	});
});
