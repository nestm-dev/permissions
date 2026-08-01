import { describe, expect, it } from "vitest";

import { normalizeEntityUid } from "../../src/cedar/uid.ts";
import { entity, entityGraph, toCedarValue } from "../../src/entities/entity-builder.ts";
import { t } from "../../src/vocabulary/attr.ts";
import { defineVocabulary } from "../../src/vocabulary/define-vocabulary.ts";
import { stationVocabulary } from "../fixtures/station-vocabulary.ts";

/** A second vocabulary covering the extension types the station fixture does not use. */
const extensionVocabulary = defineVocabulary({
	namespace: "Ext",
	entities: {
		Tenant: {},
		Widget: {
			memberOf: ["Tenant"],
			attrs: {
				window: t.ext("duration"),
				source: t.ext("ipaddr"),
				price: t.ext("decimal"),
				owner: t.ref("Tenant"),
				flags: t.set(t.bool()),
				nested: t.record({ deep: t.record({ value: t.long() }) }),
			},
		},
	},
	actions: { "widget:read": { principal: ["Tenant"], resource: ["Widget"] } },
});

const RUN_ATTRS = {
	project: { type: "Project", id: "p1" },
	status: "queued",
	createdBy: { type: "Member", id: "m1" },
	attempt: 3,
	labels: ["nightly", "eu"],
	trigger: { kind: "manual" },
} as const;

describe("entity - shape", () => {
	it("namespace-qualifies the uid and every parent", () => {
		const built = entity(stationVocabulary, "Run", "r1", {
			attrs: RUN_ATTRS,
			parents: [{ type: "Project", id: "p1" }],
		});

		expect(built.uid).toEqual({ type: "Station::Run", id: "r1" });
		expect(built.parents).toEqual([{ type: "Station::Project", id: "p1" }]);
	});

	it("accepts an already-qualified parent type", () => {
		const built = entity(stationVocabulary, "Run", "r1", {
			attrs: RUN_ATTRS,
			parents: [{ type: "Station::Project", id: "p1" }],
		});

		expect(built.parents).toEqual([{ type: "Station::Project", id: "p1" }]);
	});

	it("builds an entity with no attributes at all", () => {
		expect(entity(stationVocabulary, "Organization", "o1", { attrs: {} })).toEqual({
			uid: { type: "Station::Organization", id: "o1" },
			attrs: {},
			parents: [],
		});
	});

	it("carries tags through structurally", () => {
		const built = entity(stationVocabulary, "Organization", "o1", {
			attrs: {},
			tags: { tier: "gold", seats: 12, since: new Date("2026-01-01T00:00:00.000Z") },
		});

		expect(built.tags).toEqual({
			tier: "gold",
			seats: 12,
			since: { __extn: { fn: "datetime", arg: "2026-01-01T00:00:00.000Z" } },
		});
	});
});

describe("entity - value conversion", () => {
	it("converts EntityRef attributes to the qualified __entity form", () => {
		const built = entity(stationVocabulary, "Run", "r1", { attrs: RUN_ATTRS });

		expect(built.attrs["project"]).toEqual({ __entity: { type: "Station::Project", id: "p1" } });
		expect(built.attrs["createdBy"]).toEqual({ __entity: { type: "Station::Member", id: "m1" } });
	});

	it("accepts an already-qualified entity reference", () => {
		const built = entity(stationVocabulary, "Run", "r1", {
			// @ts-expect-error -- types are vocabulary-local at the type level; the
			// runtime still accepts the qualified spelling a database may have stored
			attrs: { ...RUN_ATTRS, project: { type: "Station::Project", id: "p1" } },
		});

		expect(built.attrs["project"]).toEqual({ __entity: { type: "Station::Project", id: "p1" } });
	});

	it("converts a Date to the datetime extension call", () => {
		const built = entity(stationVocabulary, "Run", "r1", {
			attrs: { ...RUN_ATTRS, startedAt: new Date("2026-07-30T12:34:56.789Z") },
		});

		expect(built.attrs["startedAt"]).toEqual({
			__extn: { fn: "datetime", arg: "2026-07-30T12:34:56.789Z" },
		});
	});

	it("passes strings, longs, sets and records through structurally", () => {
		const built = entity(stationVocabulary, "Run", "r1", {
			attrs: { ...RUN_ATTRS, trigger: { kind: "manual", actor: "m1" } },
		});

		expect(built.attrs["status"]).toBe("queued");
		expect(built.attrs["attempt"]).toBe(3);
		expect(built.attrs["labels"]).toEqual(["nightly", "eu"]);
		expect(built.attrs["trigger"]).toEqual({ kind: "manual", actor: "m1" });
	});

	it("converts duration, ipaddr and decimal to their Cedar constructors", () => {
		const built = entity(extensionVocabulary, "Widget", "w1", {
			attrs: {
				window: 90_000,
				source: "10.0.0.1",
				price: "12.50",
				owner: { type: "Tenant", id: "t1" },
				flags: [true, false],
				nested: { deep: { value: 7 } },
			},
		});

		// Cedar spells the ipaddr constructor `ip(...)`; a duration is authored in
		// milliseconds and rendered as the lossless `<n>ms` literal.
		expect(built.attrs["window"]).toEqual({ __extn: { fn: "duration", arg: "90000ms" } });
		expect(built.attrs["source"]).toEqual({ __extn: { fn: "ip", arg: "10.0.0.1" } });
		expect(built.attrs["price"]).toEqual({ __extn: { fn: "decimal", arg: "12.50" } });
		expect(built.attrs["flags"]).toEqual([true, false]);
		expect(built.attrs["nested"]).toEqual({ deep: { value: 7 } });
	});

	it("lets a pre-escaped Cedar value through untouched", () => {
		const built = entity(extensionVocabulary, "Widget", "w1", {
			attrs: {
				// @ts-expect-error -- durations are authored as milliseconds; the escape
				// form is the runtime hatch for a literal Cedar cannot express in ms
				window: { __extn: { fn: "duration", arg: "1h30m" } },
				source: "10.0.0.1",
				price: "12.50",
				owner: { type: "Tenant", id: "t1" },
				flags: [],
				nested: { deep: { value: 0 } },
			},
		});

		expect(built.attrs["window"]).toEqual({ __extn: { fn: "duration", arg: "1h30m" } });
	});
});

describe("entity - optional attributes", () => {
	it("omits an absent optional attribute entirely", () => {
		const built = entity(stationVocabulary, "Run", "r1", { attrs: RUN_ATTRS });

		expect(Object.hasOwn(built.attrs, "startedAt")).toBe(false);
		// The record attribute is emitted without its absent optional field, rather
		// than with an explicit `undefined` Cedar would reject.
		expect(built.attrs["trigger"]).toEqual({ kind: "manual" });
	});

	it("includes an optional attribute that was provided", () => {
		const built = entity(stationVocabulary, "Run", "r1", {
			attrs: { ...RUN_ATTRS, startedAt: new Date(0) },
		});

		expect(built.attrs["startedAt"]).toEqual({
			__extn: { fn: "datetime", arg: "1970-01-01T00:00:00.000Z" },
		});
	});
});

describe("entity - validation", () => {
	it("rejects an attribute the vocabulary does not declare", () => {
		expect(() =>
			entity(stationVocabulary, "Run", "r1", {
				// @ts-expect-error -- `statuss` is the typo this builder exists to catch
				attrs: { ...RUN_ATTRS, statuss: "queued" },
			}),
		).toThrowError(/Run.attrs.statuss is not declared/);
	});

	it("explains why an undeclared attribute is dangerous, not just wrong", () => {
		try {
			entity(stationVocabulary, "Run", "r1", {
				// @ts-expect-error -- deliberate typo
				attrs: { ...RUN_ATTRS, ownr: "m1" },
			});
			expect.unreachable("entity() should have thrown");
		} catch (error) {
			expect(error).toMatchObject({
				name: "SchemaValidationError",
				code: "SCHEMA_INVALID",
				namespace: "Station",
				path: "Run.attrs.ownr",
				message: expect.stringContaining("errored forbid is dropped"),
			});
		}
	});

	it("rejects a missing required attribute", () => {
		const { status: _dropped, ...withoutStatus } = RUN_ATTRS;

		expect(() =>
			// @ts-expect-error -- `status` is required
			entity(stationVocabulary, "Run", "r1", { attrs: withoutStatus }),
		).toThrowError(/Run.attrs.status is required/);
	});

	it("rejects a required attribute explicitly set to undefined", () => {
		expect(() =>
			entity(stationVocabulary, "Run", "r1", {
				// @ts-expect-error -- `undefined` is not a string
				attrs: { ...RUN_ATTRS, status: undefined },
			}),
		).toThrowError(/Run.attrs.status is required/);
	});

	it("rejects a wrongly typed attribute", () => {
		expect(() =>
			entity(stationVocabulary, "Project", "p1", {
				// @ts-expect-error -- `archived` is a boolean
				attrs: { organization: { type: "Organization", id: "o1" }, archived: "no" },
			}),
		).toThrowError(/Project.attrs.archived must be a boolean, received a string/);
	});

	it("rejects a non-integer Long", () => {
		expect(() =>
			entity(stationVocabulary, "Run", "r1", { attrs: { ...RUN_ATTRS, attempt: 1.5 } }),
		).toThrowError(/Run.attrs.attempt must be an integer/);
	});

	it("rejects an entity reference of the wrong type", () => {
		expect(() =>
			entity(stationVocabulary, "Run", "r1", {
				// @ts-expect-error -- `project` must reference a Project
				attrs: { ...RUN_ATTRS, project: { type: "Organization", id: "o1" } },
			}),
		).toThrowError(/references a "Organization", but the vocabulary declares it as a "Project"/);
	});

	it("rejects a set whose element has the wrong type", () => {
		expect(() =>
			// @ts-expect-error -- labels is a Set<String>
			entity(stationVocabulary, "Run", "r1", { attrs: { ...RUN_ATTRS, labels: [1, 2] } }),
		).toThrowError(/Run.attrs.labels\[0\] must be a string/);
	});

	it("rejects an undeclared field inside a record attribute", () => {
		expect(() =>
			entity(stationVocabulary, "Run", "r1", {
				// @ts-expect-error -- `source` is not a declared field of `trigger`
				attrs: { ...RUN_ATTRS, trigger: { kind: "manual", source: "api" } },
			}),
		).toThrowError(/Run.attrs.trigger.source is not declared/);
	});

	it("rejects a datetime that is not a Date", () => {
		expect(() =>
			entity(stationVocabulary, "Run", "r1", {
				// @ts-expect-error -- startedAt is a Date
				attrs: { ...RUN_ATTRS, startedAt: 1_700_000_000 },
			}),
		).toThrowError(/Run.attrs.startedAt must be a Date/);
	});

	it("rejects an Invalid Date", () => {
		expect(() =>
			entity(stationVocabulary, "Run", "r1", {
				attrs: { ...RUN_ATTRS, startedAt: new Date("nope") },
			}),
		).toThrowError(/Run.attrs.startedAt is an Invalid Date/);
	});

	it("rejects a decimal authored as a float", () => {
		expect(() =>
			entity(extensionVocabulary, "Widget", "w1", {
				attrs: {
					window: 1,
					source: "10.0.0.1",
					// @ts-expect-error -- decimals are strings so precision survives
					price: 12.5,
					owner: { type: "Tenant", id: "t1" },
					flags: [],
					nested: { deep: { value: 0 } },
				},
			}),
		).toThrowError(/Widget.attrs.price must be a string holding a Cedar decimal literal/);
	});

	it("rejects an entity type the vocabulary does not declare", () => {
		expect(() =>
			// @ts-expect-error -- "Widget" is not a Station entity type
			entity(stationVocabulary, "Widget", "w1", { attrs: {} }),
		).toThrowError(/Entity type "Widget" is not declared by vocabulary "Station"/);
	});

	it("rejects an empty id", () => {
		expect(() => entity(stationVocabulary, "Organization", "", { attrs: {} })).toThrowError(
			/needs a non-empty id/,
		);
	});
});

describe("entity - parents", () => {
	it("rejects a parent type the entity does not declare memberOf", () => {
		expect(() =>
			entity(stationVocabulary, "Run", "r1", {
				attrs: RUN_ATTRS,
				parents: [{ type: "Organization", id: "o1" }],
			}),
		).toThrowError(/is a "Organization", but "Run" declares memberOf "Project"/);
	});

	it("reports (none) for an entity that declares no memberOf at all", () => {
		expect(() =>
			entity(stationVocabulary, "Organization", "o1", {
				attrs: {},
				parents: [{ type: "Role", id: "admin" }],
			}),
		).toThrowError(/declares memberOf \(none\)/);
	});

	it("accepts every declared parent type", () => {
		const built = entity(stationVocabulary, "Member", "m1", {
			attrs: { organization: { type: "Organization", id: "o1" }, identitySubject: "sub-1" },
			parents: [
				{ type: "Role", id: "admin" },
				{ type: "Organization", id: "o1" },
			],
		});

		expect(built.parents).toEqual([
			{ type: "Station::Role", id: "admin" },
			{ type: "Station::Organization", id: "o1" },
		]);
	});

	it("rejects a malformed parent reference", () => {
		expect(() =>
			entity(stationVocabulary, "Run", "r1", {
				attrs: RUN_ATTRS,
				// @ts-expect-error -- a parent needs an id
				parents: [{ type: "Project" }],
			}),
		).toThrowError(/must be an entity reference \{ type, id \}/);
	});
});

describe("toCedarValue", () => {
	it("qualifies a bare EntityRef", () => {
		expect(toCedarValue({ type: "Run", id: "r1" }, { namespace: "Station" })).toEqual({
			__entity: { type: "Station::Run", id: "r1" },
		});
	});

	it("treats a three-key object as a plain record, not a reference", () => {
		expect(toCedarValue({ type: "Run", id: "r1", extra: 1 })).toEqual({
			type: "Run",
			id: "r1",
			extra: 1,
		});
	});

	it("converts nested Dates inside arrays and records", () => {
		expect(toCedarValue({ at: [new Date(0)] })).toEqual({
			at: [{ __extn: { fn: "datetime", arg: "1970-01-01T00:00:00.000Z" } }],
		});
	});

	it("maps undefined and null to null", () => {
		expect(toCedarValue(undefined)).toBeNull();
		expect(toCedarValue(null)).toBeNull();
	});

	it("drops undefined record members", () => {
		expect(toCedarValue({ a: 1, b: undefined })).toEqual({ a: 1 });
	});

	it("passes an ext call with an argument list through", () => {
		expect(toCedarValue({ __extn: { fn: "ip", args: ["10.0.0.1"] } })).toEqual({
			__extn: { fn: "ip", args: ["10.0.0.1"] },
		});
	});

	it("rejects a value with no Cedar representation", () => {
		expect(() => toCedarValue(() => 1)).toThrowError(/has no Cedar representation/);
		expect(() => toCedarValue(1n)).toThrowError(/has no Cedar representation/);
	});

	it("rejects a malformed escape form", () => {
		expect(() => toCedarValue({ __entity: { type: "Run" } })).toThrowError(
			/__entity must be \{ type, id \}/,
		);
		expect(() => toCedarValue({ __extn: { fn: 1 } })).toThrowError(/__extn must be/);
	});
});

describe("entityGraph", () => {
	const organization = entity(stationVocabulary, "Organization", "o1", { attrs: {} });
	const member = entity(stationVocabulary, "Member", "m1", {
		attrs: { organization: { type: "Organization", id: "o1" }, identitySubject: "sub-1" },
	});

	it("keeps distinct entities in insertion order", () => {
		expect(entityGraph(organization, member).map((each) => each.uid)).toEqual([
			{ type: "Station::Organization", id: "o1" },
			{ type: "Station::Member", id: "m1" },
		]);
	});

	it("deduplicates by uid, last write winning", () => {
		const richer = entity(stationVocabulary, "Member", "m1", {
			attrs: { organization: { type: "Organization", id: "o1" }, identitySubject: "sub-2" },
		});

		const graph = entityGraph(member, organization, richer);

		expect(graph).toHaveLength(2);
		expect(
			graph.find((each) => normalizeEntityUid(each.uid).type === "Station::Member")?.attrs,
		).toEqual({
			organization: { __entity: { type: "Station::Organization", id: "o1" } },
			identitySubject: "sub-2",
		});
	});

	it("treats both uid encodings as the same entity", () => {
		const escaped = {
			uid: { __entity: { type: "Station::Organization", id: "o1" } },
			attrs: {},
			parents: [],
		};

		expect(entityGraph(organization, escaped)).toHaveLength(1);
	});

	it("returns an empty graph for no arguments", () => {
		expect(entityGraph()).toEqual([]);
	});
});
