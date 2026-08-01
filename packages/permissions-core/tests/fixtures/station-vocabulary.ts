import { defineVocabulary } from "../../src/vocabulary/define-vocabulary.ts";
import { t } from "../../src/vocabulary/attr.ts";

/**
 * The station-shaped vocabulary from docs/design/core.md §2, plus one action
 * group (`run:*`) and one optional extension attribute so the generated schema
 * exercises every branch of `to-cedar-schema.ts`.
 */
export const stationVocabulary = defineVocabulary({
	namespace: "Station",
	entities: {
		Organization: {},
		Role: {},
		Project: {
			memberOf: ["Organization"],
			attrs: { organization: t.ref("Organization"), archived: t.bool() },
		},
		Member: {
			memberOf: ["Role", "Organization"],
			attrs: { organization: t.ref("Organization"), identitySubject: t.string() },
		},
		Run: {
			memberOf: ["Project"],
			attrs: {
				project: t.ref("Project"),
				status: t.string(),
				createdBy: t.ref("Member"),
				attempt: t.long(),
				labels: t.set(t.string()),
				startedAt: t.optional(t.ext("datetime")),
				trigger: t.record({ kind: t.string(), actor: t.optional(t.string()) }),
			},
		},
	},
	actions: {
		"run:*": {},
		"run:dispatch": {
			memberOf: ["run:*"],
			principal: ["Member"],
			resource: ["Run"],
			context: { mfa: t.optional(t.bool()), reason: t.string() },
		},
		"run:read": { memberOf: ["run:*"], principal: ["Member"], resource: ["Run"] },
		"project:manage": { principal: ["Member"], resource: ["Project"] },
	},
});

/** Handy alias so tests can name the vocabulary's own type. */
export type StationVocabulary = typeof stationVocabulary;
