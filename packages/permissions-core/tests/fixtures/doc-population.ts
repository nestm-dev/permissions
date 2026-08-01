// The population the property suites plan over.
//
// One shape, used three ways, and that is the whole point: the same `DocRow`
// becomes a Cedar entity for the brute-force `check()` pass, a `PlanRow` for the
// reference interpreter, and (in the driver packages) a database row. If the
// three ever drifted apart, a set-equality assertion would be comparing two
// different populations and would pass for the wrong reason.
//
// The hierarchy is deliberately two levels deep with a *reflexive* case reachable
// at every level:
//
//     Org o1  ←  Folder f1..f3  ←  Doc d0..dN
//     Org o1  ←  Group g1..g2   ←  User  u1..u3
//
// so `resource in Folder::"f1"` (strict parent), `resource.folder in
// Folder::"f1"` (**self**) and `resource in Doc::"d3"` (**self**, at the row) are
// all expressible. Cedar's `in` is descendant-or-self; an interpreter or a driver
// that walked strict ancestors only would disagree with `check()` on exactly the
// self cases and nowhere else, which is the kind of bug a small fixture hides.

import { entity } from "../../src/entities/entity-builder.ts";
import type { EntityGraph } from "../../src/entities/entity-provider.ts";
import type { EntityRef } from "../../src/cedar/uid.ts";
import type { HierarchyQuery, PlanRow } from "../../src/plan/evaluate-plan.ts";
import { testVocabulary } from "../../src/testing/fixtures.ts";

// ---------------------------------------------------------------------------
// The fixed graph
// ---------------------------------------------------------------------------

/** The single organization every folder and user hangs off. */
export const ORG_ID = "o1";

/** Folder ids a generated `Doc` may sit in. */
export const FOLDER_IDS: readonly string[] = ["f1", "f2", "f3"];

/** Group ids a user may belong to. */
export const GROUP_IDS: readonly string[] = ["g1", "g2"];

/** User ids a generated `Doc` may name as owner or reviewer. */
export const USER_IDS: readonly string[] = ["u1", "u2", "u3"];

/** Which group each user belongs to. `u3` belongs to none — the empty-ancestor case. */
const USER_GROUPS: Readonly<Record<string, readonly string[]>> = {
	u1: ["g1"],
	u2: ["g2"],
	u3: [],
};

/** Statuses a generated `Doc` may carry. */
export const STATUSES: readonly string[] = ["draft", "review", "published", "archived"];

/**
 * Titles a generated `Doc` may carry.
 *
 * Every SQL and Cedar metacharacter appears in at least one of them: a `%` and a
 * `_` (SQL wildcards that Cedar treats as ordinary text), a `*` (Cedar's
 * wildcard, which a policy must escape as `\*` to mean literally), and a
 * backslash. A `like` fuzz that only ever saw alphanumeric titles would pass
 * against a driver with a `%`-injection bug.
 */
export const TITLES: readonly string[] = [
	"alpha",
	"alpha-beta",
	"beta",
	"a*b",
	"50% off",
	"under_score",
	"back\\slash",
	"",
];

/** Labels a generated `Doc` may carry, as a subset. */
export const LABELS: readonly string[] = ["nightly", "urgent", "draft"];

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

/**
 * One generated `Doc`.
 *
 * The three optional fields are absent as `undefined`, never as `null`, because
 * that is what a generator produces; the interpreter treats both as absent, and
 * `tests/unit/evaluate-plan.test.ts` pins the `null` half separately since that
 * is the shape a driver reads back out of a nullable column.
 */
export type DocRow = {
	readonly id: string;
	readonly folder: string;
	readonly owner: string;
	readonly status: string;
	readonly title: string;
	readonly size: number;
	readonly archived: boolean;
	readonly labels: readonly string[];
	readonly publishedAt?: Date;
	readonly reviewer?: string;
	readonly score?: number;
};

/** A `DocRow` as the reference interpreter sees it: attribute names to values. */
export function toPlanRow(row: DocRow): PlanRow {
	// The row object already *is* the plan row — same keys, same values. Returning
	// it unchanged rather than projecting is deliberate: a projection step is a
	// place for the two views to silently diverge.
	return row;
}

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------

/** The org, every folder and every user/group — everything but the docs. */
export function fixedEntities(): EntityGraph {
	return [
		entity(testVocabulary, "Org", ORG_ID, { attrs: {} }),
		...FOLDER_IDS.map((id) =>
			entity(testVocabulary, "Folder", id, {
				attrs: { org: { type: "Org", id: ORG_ID } },
				parents: [{ type: "Org", id: ORG_ID }],
			}),
		),
		...GROUP_IDS.map((id) => entity(testVocabulary, "Group", id, { attrs: {} })),
		...USER_IDS.map((id) =>
			entity(testVocabulary, "User", id, {
				attrs: { org: { type: "Org", id: ORG_ID } },
				parents: [
					...(USER_GROUPS[id] ?? []).map((group) => ({ type: "Group" as const, id: group })),
					{ type: "Org" as const, id: ORG_ID },
				],
			}),
		),
	];
}

/** The Cedar entity for one row. Optional attributes are *omitted*, never nulled. */
export function docEntity(row: DocRow): EntityGraph[number] {
	return entity(testVocabulary, "Doc", row.id, {
		attrs: {
			folder: { type: "Folder", id: row.folder },
			owner: { type: "User", id: row.owner },
			status: row.status,
			title: row.title,
			size: row.size,
			archived: row.archived,
			labels: [...row.labels],
			// Spread-if-present: a Cedar entity carrying an explicit `undefined` for an
			// optional attribute is not the same thing as one that omits it, and only
			// the omission matches what `resource has publishedAt` is asking about.
			...(row.publishedAt === undefined ? {} : { publishedAt: row.publishedAt }),
			...(row.reviewer === undefined ? {} : { reviewer: { type: "User", id: row.reviewer } }),
			...(row.score === undefined ? {} : { score: row.score }),
		},
		parents: [{ type: "Folder", id: row.folder }],
	});
}

/**
 * The graph one `check()` needs: the principal's side plus this one row.
 *
 * Deliberately *not* the whole population — §0's fourth finding is that 500
 * irrelevant entities cost 20× the latency, and a brute-force pass that shipped
 * every doc to every check would take minutes instead of seconds.
 */
export function checkEntities(row: DocRow, fixed: EntityGraph): EntityGraph {
	return [...fixed, docEntity(row)];
}

// ---------------------------------------------------------------------------
// Hierarchy
// ---------------------------------------------------------------------------

/** Which entity type each reference-valued attribute of `Doc` points at. */
const REFERENCE_TYPES: Readonly<Record<string, string>> = {
	folder: "Folder",
	owner: "User",
	reviewer: "User",
};

/** Transitive parents of one entity in the fixture graph, excluding itself. */
function ancestorsOf(reference: EntityRef<string>): EntityRef<string>[] {
	switch (reference.type) {
		case "Doc": {
			// A doc's folder is not derivable from its id alone; the resolver below
			// answers doc-rooted questions from the row instead, so this arm only ever
			// needs the part that is id-independent.
			return [];
		}
		case "Folder": {
			return [{ type: "Org", id: ORG_ID }];
		}
		case "User": {
			return [
				...(USER_GROUPS[reference.id] ?? []).map((group) => ({ type: "Group", id: group })),
				{ type: "Org", id: ORG_ID },
			];
		}
		default: {
			return [];
		}
	}
}

function isSelf(reference: EntityRef<string>, parent: EntityRef<string>): boolean {
	return reference.type === parent.type && reference.id === parent.id;
}

/**
 * Cedar `in`, over the fixture graph — **descendant-or-self**.
 *
 * The reflexive arm comes first and is not an optimisation: `Folder::"f1" in
 * Folder::"f1"` is `true` in Cedar, so a driver's `self` hierarchy mapping
 * compiles to `folder_id = $1` rather than to an ancestor lookup. Dropping the
 * self case here would make this oracle agree with a driver that made the same
 * mistake.
 */
export function isDescendantOrSelf(
	reference: EntityRef<string>,
	parent: EntityRef<string>,
): boolean {
	if (isSelf(reference, parent)) {
		return true;
	}
	return ancestorsOf(reference).some(
		(ancestor) =>
			isSelf(ancestor, parent) || ancestorsOf(ancestor).some((up) => isSelf(up, parent)),
	);
}

/**
 * The `HierarchyResolver` the property suites hand to `evaluatePlanNode`.
 *
 * Answers three shapes:
 *   * `attr: null` — the row itself, so `Doc::<rowId>` and its folder/org chain;
 *   * `attr: "folder"` — the folder the row points at, and *its* chain;
 *   * `attr: "owner"` / `"reviewer"` — a user, and its group/org chain.
 *
 * Anything else throws rather than answering `false`: a silent `false` from a
 * resolver is a restrictive divergence that would look exactly like a plan
 * compiler bug.
 */
export function resolveHierarchy(query: HierarchyQuery): boolean {
	const { attr, rowId, parent, value } = query;

	if (attr === null) {
		if (rowId === undefined) {
			throw new Error("resolveHierarchy was asked about the row itself with no rowId");
		}
		const self: EntityRef<string> = { type: "Doc", id: rowId };
		if (isSelf(self, parent)) {
			return true;
		}
		// A doc's parents come from the row, not from the id.
		const folder = query.row["folder"];
		if (typeof folder !== "string") {
			throw new Error(`row "${rowId}" has no folder to resolve its hierarchy through`);
		}
		return isDescendantOrSelf({ type: "Folder", id: folder }, parent);
	}

	const referencedType = REFERENCE_TYPES[attr];
	if (referencedType === undefined) {
		throw new Error(`resolveHierarchy has no reference type mapped for the attribute "${attr}"`);
	}
	if (typeof value !== "string") {
		throw new Error(`row attribute "${attr}" held ${typeof value}, expected an id string`);
	}

	return isDescendantOrSelf({ type: referencedType, id: value }, parent);
}
