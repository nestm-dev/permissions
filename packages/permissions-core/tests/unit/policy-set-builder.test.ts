import { describe, expect, it } from "vitest";

import { buildPolicySet } from "../../src/policy/policy-set-builder.ts";
import {
	FORBID_ALL,
	PERMIT_ALL,
	TEMPLATE_BOTH_SLOTS,
	TEMPLATE_PRINCIPAL_ONLY,
	TEMPLATE_RESOURCE_ONLY,
	bundle,
	linkRecord,
	policyRecord,
} from "../fixtures/policy-fixtures.ts";

const template = policyRecord({
	id: "role:reader",
	scope: "org:1",
	kind: "template",
	cedarJson: TEMPLATE_BOTH_SLOTS,
});

describe("buildPolicySet output", () => {
	it("splits static policies from templates", () => {
		const set = buildPolicySet(
			bundle({
				policies: [
					policyRecord({ id: "p1", cedarJson: PERMIT_ALL }),
					policyRecord({ id: "f1", cedarJson: FORBID_ALL }),
					template,
				],
			}),
		);

		expect(Object.keys(set.staticPolicies ?? {})).toEqual(["f1", "p1"]);
		expect(Object.keys(set.templates ?? {})).toEqual(["role:reader"]);
		expect(set.templateLinks).toEqual([]);
	});

	it("is deterministic regardless of input order", () => {
		const policies = [
			policyRecord({ id: "b" }),
			policyRecord({ id: "a" }),
			policyRecord({ id: "c" }),
			template,
		];
		const links = [
			linkRecord({
				id: "l2",
				templateId: "role:reader",
				values: {
					"?principal": { type: "Member", id: "m2" },
					"?resource": { type: "Project", id: "p2" },
				},
			}),
			linkRecord({
				id: "l1",
				templateId: "role:reader",
				values: {
					"?principal": { type: "Member", id: "m1" },
					"?resource": { type: "Project", id: "p1" },
				},
			}),
		];

		const forward = buildPolicySet(bundle({ policies, links }));
		const reversed = buildPolicySet(
			bundle({ policies: policies.toReversed(), links: links.toReversed() }),
		);

		expect(JSON.stringify(forward)).toBe(JSON.stringify(reversed));
		expect(Object.keys(forward.staticPolicies ?? {})).toEqual(["a", "b", "c"]);
		expect(forward.templateLinks?.map((link) => link.newId)).toEqual(["l1", "l2"]);
	});

	it("always emits all three collections", () => {
		expect(buildPolicySet(bundle())).toEqual({
			staticPolicies: {},
			templates: {},
			templateLinks: [],
		});
	});

	it("drops disabled records", () => {
		const set = buildPolicySet(
			bundle({
				policies: [
					policyRecord({ id: "on" }),
					policyRecord({ id: "off", enabled: false }),
					policyRecord({
						id: "tmpl-off",
						kind: "template",
						cedarJson: TEMPLATE_PRINCIPAL_ONLY,
						enabled: false,
					}),
				],
			}),
		);

		expect(Object.keys(set.staticPolicies ?? {})).toEqual(["on"]);
		expect(Object.keys(set.templates ?? {})).toEqual([]);
	});
});

describe("buildPolicySet template links (D6)", () => {
	it("maps both slots and qualifies types with the namespace", () => {
		const set = buildPolicySet(
			bundle({
				policies: [template],
				links: [
					linkRecord({
						id: "l1",
						templateId: "role:reader",
						values: {
							"?principal": { type: "Member", id: "m1" },
							"?resource": { type: "Project", id: "p1" },
						},
					}),
				],
			}),
			{ namespace: "Station" },
		);

		expect(set.templateLinks).toEqual([
			{
				templateId: "role:reader",
				newId: "l1",
				values: {
					"?principal": { type: "Station::Member", id: "m1" },
					"?resource": { type: "Station::Project", id: "p1" },
				},
			},
		]);
	});

	it("leaves an already-qualified type alone", () => {
		const set = buildPolicySet(
			bundle({
				policies: [template],
				links: [
					linkRecord({
						id: "l1",
						templateId: "role:reader",
						values: {
							"?principal": { type: "Station::Member", id: "m1" },
							"?resource": { type: "Station::Project", id: "p1" },
						},
					}),
				],
			}),
			{ namespace: "Station" },
		);

		expect(set.templateLinks?.[0]?.values["?principal"]).toEqual({
			type: "Station::Member",
			id: "m1",
		});
	});

	it("accepts a principal-only template with only ?principal", () => {
		const set = buildPolicySet(
			bundle({
				policies: [
					policyRecord({
						id: "role:global",
						kind: "template",
						cedarJson: TEMPLATE_PRINCIPAL_ONLY,
					}),
				],
				links: [
					linkRecord({
						id: "l1",
						templateId: "role:global",
						values: { "?principal": { type: "Member", id: "m1" } },
					}),
				],
			}),
		);

		expect(set.templateLinks?.[0]?.values).toEqual({ "?principal": { type: "Member", id: "m1" } });
	});

	it("accepts a resource-only template with only ?resource", () => {
		const set = buildPolicySet(
			bundle({
				policies: [
					policyRecord({
						id: "role:project",
						kind: "template",
						cedarJson: TEMPLATE_RESOURCE_ONLY,
					}),
				],
				links: [
					linkRecord({
						id: "l1",
						templateId: "role:project",
						values: { "?resource": { type: "Project", id: "p1" } },
					}),
				],
			}),
		);

		expect(set.templateLinks?.[0]?.values).toEqual({ "?resource": { type: "Project", id: "p1" } });
	});

	it("rejects a missing slot", () => {
		expect(() =>
			buildPolicySet(
				bundle({
					policies: [template],
					links: [
						linkRecord({
							id: "l1",
							templateId: "role:reader",
							values: { "?principal": { type: "Member", id: "m1" } },
						}),
					],
				}),
			),
		).toThrowError(
			expect.objectContaining({
				code: "POLICY_INVALID",
				message: expect.stringContaining('"l1" is missing a value for ?resource'),
			}),
		);
	});

	it("rejects a value the template does not declare", () => {
		expect(() =>
			buildPolicySet(
				bundle({
					policies: [
						policyRecord({
							id: "role:global",
							kind: "template",
							cedarJson: TEMPLATE_PRINCIPAL_ONLY,
						}),
					],
					links: [
						linkRecord({
							id: "l1",
							templateId: "role:global",
							values: {
								"?principal": { type: "Member", id: "m1" },
								"?resource": { type: "Project", id: "p1" },
							},
						}),
					],
				}),
			),
		).toThrow(/provides \?resource, which template "role:global" does not declare/);
	});

	it("rejects an unknown slot name before it reaches the WASM", () => {
		expect(() =>
			buildPolicySet(
				bundle({
					policies: [template],
					links: [
						linkRecord({
							id: "l1",
							templateId: "role:reader",
							values: { "?context": { type: "Member", id: "m1" } } as never,
						}),
					],
				}),
			),
		).toThrow(/provides the slot "\?context"/);
	});

	it("rejects a link to an unknown template", () => {
		expect(() =>
			buildPolicySet(bundle({ links: [linkRecord({ id: "l1", templateId: "missing" })] })),
		).toThrow(/references the unknown template "missing"/);
	});

	it("rejects a link to a static policy", () => {
		expect(() =>
			buildPolicySet(
				bundle({
					policies: [policyRecord({ id: "p1" })],
					links: [linkRecord({ id: "l1", templateId: "p1" })],
				}),
			),
		).toThrow(/which is a static policy/);
	});

	it("rejects a link to a disabled template", () => {
		expect(() =>
			buildPolicySet(
				bundle({
					policies: [{ ...template, enabled: false }],
					links: [
						linkRecord({
							id: "l1",
							templateId: "role:reader",
							values: {
								"?principal": { type: "Member", id: "m1" },
								"?resource": { type: "Project", id: "p1" },
							},
						}),
					],
				}),
			),
		).toThrow(/is disabled but link "l1" still references it/);
	});
});

describe("buildPolicySet id collisions", () => {
	it("rejects duplicate policy ids", () => {
		expect(() =>
			buildPolicySet(
				bundle({ policies: [policyRecord({ id: "dup" }), policyRecord({ id: "dup" })] }),
			),
		).toThrow(/Duplicate policy id "dup"/);
	});

	it("rejects duplicate link ids", () => {
		expect(() =>
			buildPolicySet(
				bundle({
					policies: [{ ...template, cedarJson: TEMPLATE_PRINCIPAL_ONLY }],
					links: [
						linkRecord({
							id: "dup",
							templateId: "role:reader",
							values: { "?principal": { type: "Member", id: "m1" } },
						}),
						linkRecord({
							id: "dup",
							templateId: "role:reader",
							values: { "?principal": { type: "Member", id: "m2" } },
						}),
					],
				}),
			),
		).toThrow(/Duplicate template link id "dup"/);
	});

	it("rejects a link id that collides with a policy id", () => {
		expect(() =>
			buildPolicySet(
				bundle({
					policies: [
						policyRecord({ id: "clash" }),
						{ ...template, cedarJson: TEMPLATE_PRINCIPAL_ONLY },
					],
					links: [
						linkRecord({
							id: "clash",
							templateId: "role:reader",
							values: { "?principal": { type: "Member", id: "m1" } },
						}),
					],
				}),
			),
		).toThrow(/collides with a policy of the same id/);
	});

	it("carries the bundle scope on the error", () => {
		expect(() =>
			buildPolicySet(
				bundle({
					scope: "org:9",
					policies: [policyRecord({ id: "d" }), policyRecord({ id: "d" })],
				}),
			),
		).toThrowError(expect.objectContaining({ scope: "org:9" }));
	});
});
