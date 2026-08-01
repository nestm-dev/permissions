import { beforeAll, describe, expect, it } from "vitest";

import type { CedarBinding } from "../../src/cedar/binding.ts";
import { loadCedar } from "../../src/cedar/loader.ts";
import {
	formatPolicyText,
	isTemplateJson,
	parsePolicyText,
	policyKindOf,
	policyRecordFromText,
	renderPolicyText,
	templateSlotsOf,
	templateToJsonRecord,
} from "../../src/policy/policy-codec.ts";

const STATIC_TEXT = `permit(
	principal is Station::Member,
	action == Station::Action::"run:read",
	resource is Station::Run
) when { resource.status == "queued" };`;

const TEMPLATE_TEXT = `permit(principal == ?principal, action == Station::Action::"run:read", resource in ?resource);`;

const PRINCIPAL_ONLY_TEXT = `permit(principal == ?principal, action, resource);`;

let cedar: CedarBinding;

beforeAll(async () => {
	cedar = await loadCedar();
});

describe("parsePolicyText", () => {
	it("parses a static policy into canonical JSON", () => {
		const json = parsePolicyText(cedar, STATIC_TEXT);

		expect(json.effect).toBe("permit");
		expect(json.principal).toEqual({ op: "is", entity_type: "Station::Member" });
		expect(json.action).toEqual({
			op: "==",
			entity: { type: "Station::Action", id: "run:read" },
		});
		expect(json.conditions).toHaveLength(1);
		expect(templateSlotsOf(json)).toEqual([]);
		expect(policyKindOf(json)).toBe("static");
	});

	it("auto-detects a template", () => {
		const json = parsePolicyText(cedar, TEMPLATE_TEXT);

		expect(json.principal).toEqual({ op: "==", slot: "?principal" });
		expect(json.resource).toEqual({ op: "in", slot: "?resource" });
		expect(templateSlotsOf(json)).toEqual(["?principal", "?resource"]);
		expect(isTemplateJson(json)).toBe(true);
		expect(policyKindOf(json)).toBe("template");
	});

	it("detects a single declared slot", () => {
		expect(templateSlotsOf(parsePolicyText(cedar, PRINCIPAL_ONLY_TEXT))).toEqual(["?principal"]);
		expect(
			templateSlotsOf(parsePolicyText(cedar, `permit(principal, action, resource in ?resource);`)),
		).toEqual(["?resource"]);
	});

	it("honours an explicit kind", () => {
		expect(parsePolicyText(cedar, TEMPLATE_TEXT, { kind: "template" })).toEqual(
			parsePolicyText(cedar, TEMPLATE_TEXT),
		);

		expect(() => parsePolicyText(cedar, TEMPLATE_TEXT, { kind: "static" })).toThrowError(
			expect.objectContaining({ code: "POLICY_PARSE" }),
		);
		expect(() => parsePolicyText(cedar, STATIC_TEXT, { kind: "template" })).toThrow(
			/expected a template, got a static policy/,
		);
	});

	it("preserves Cedar's diagnostics on a parse failure", () => {
		try {
			parsePolicyText(cedar, "permit(principal", { scope: "org:1" });
			expect.unreachable("expected a POLICY_PARSE failure");
		} catch (error) {
			expect(error).toMatchObject({
				name: "PermissionsError",
				code: "POLICY_PARSE",
				scope: "org:1",
			});
			const details = (error as { details?: readonly { sourceLocations?: unknown[] }[] }).details;
			expect(details).toBeDefined();
			expect(details?.[0]?.sourceLocations).toBeDefined();
			expect((error as Error).message).toMatch(/unexpected end of input/);
		}
	});
});

describe("renderPolicyText", () => {
	it("round-trips a static policy", () => {
		const json = parsePolicyText(cedar, STATIC_TEXT);
		const text = renderPolicyText(cedar, json);

		expect(text).toContain('action == Station::Action::"run:read"');
		expect(parsePolicyText(cedar, text)).toEqual(json);
	});

	it("round-trips a template with both slots", () => {
		const json = parsePolicyText(cedar, TEMPLATE_TEXT);
		const text = renderPolicyText(cedar, json);

		expect(text).toContain("?principal");
		expect(text).toContain("?resource");
		expect(parsePolicyText(cedar, text)).toEqual(json);
	});

	it("round-trips a principal-only template", () => {
		const json = templateToJsonRecord(cedar, PRINCIPAL_ONLY_TEXT);

		expect(renderPolicyText(cedar, json)).toBe(
			"permit(principal == ?principal, action, resource);",
		);
	});

	it("survives an annotated policy", () => {
		const json = parsePolicyText(cedar, `@id("role:reader")\npermit(principal, action, resource);`);

		expect(json.annotations).toEqual({ id: "role:reader" });
		expect(parsePolicyText(cedar, renderPolicyText(cedar, json))).toEqual(json);
	});
});

describe("templateToJsonRecord", () => {
	it("rejects a static policy", () => {
		expect(() => templateToJsonRecord(cedar, STATIC_TEXT)).toThrowError(
			expect.objectContaining({ code: "POLICY_PARSE" }),
		);
	});

	it("carries the scope onto the error", () => {
		expect(() => templateToJsonRecord(cedar, "not a policy", { scope: "org:2" })).toThrowError(
			expect.objectContaining({ scope: "org:2" }),
		);
	});
});

describe("formatPolicyText", () => {
	it("formats policy text", () => {
		expect(formatPolicyText(cedar, "permit(principal,action,resource) when {   1 == 1 };")).toBe(
			"permit (principal, action, resource)\nwhen { 1 == 1 };\n",
		);
	});

	it("formats template text and honours the width options", () => {
		const formatted = formatPolicyText(cedar, TEMPLATE_TEXT, { lineWidth: 40, indentWidth: 2 });

		expect(formatted).toContain("?principal");
		expect(formatted.split("\n").length).toBeGreaterThan(1);
	});

	it("throws POLICY_PARSE with diagnostics on unformattable text", () => {
		expect(() => formatPolicyText(cedar, "permit(principal")).toThrowError(
			expect.objectContaining({ code: "POLICY_PARSE" }),
		);
	});
});

describe("policyRecordFromText", () => {
	it("builds a static record with defaults", () => {
		const record = policyRecordFromText(cedar, { id: "p1", text: STATIC_TEXT });

		expect(record).toMatchObject({ id: "p1", scope: "", kind: "static", enabled: true });
		expect(record.updatedAt).toBeInstanceOf(Date);
		expect(record.cedarJson).toEqual(parsePolicyText(cedar, STATIC_TEXT));
	});

	it("infers kind template from the text", () => {
		expect(
			policyRecordFromText(cedar, { id: "role:reader", text: TEMPLATE_TEXT, scope: "org:1" }),
		).toMatchObject({ kind: "template", scope: "org:1" });
	});

	it("carries description, annotations, enabled and updatedAt", () => {
		const updatedAt = new Date("2026-07-30T00:00:00.000Z");
		const record = policyRecordFromText(cedar, {
			id: "p1",
			text: STATIC_TEXT,
			description: "readers may read queued runs",
			annotations: { owner: "platform" },
			enabled: false,
			updatedAt,
		});

		expect(record).toMatchObject({
			description: "readers may read queued runs",
			annotations: { owner: "platform" },
			enabled: false,
		});
		expect(record.updatedAt).toBe(updatedAt);
	});

	it("reports the target scope on a parse failure", () => {
		expect(() =>
			policyRecordFromText(cedar, { id: "p1", text: "permit(principal", scope: "org:3" }),
		).toThrowError(expect.objectContaining({ code: "POLICY_PARSE", scope: "org:3" }));
	});
});
