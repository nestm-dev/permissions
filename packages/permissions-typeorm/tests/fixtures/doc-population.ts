// The population the differential suite plans over.
//
// One shape used three ways, which is the whole point: the same `DocRow` becomes
// a Cedar entity for the brute-force `check()` pass, a `PlanRow` for core's
// reference interpreter, and a real Postgres row for the compiled `WHERE` clause.
// If the three drifted apart, a set-equality assertion would be comparing
// different populations and would pass for the wrong reason.
//
// The vocabulary is a **superset** of core's `testVocabulary`: same entities,
// same attributes, plus `rate` (decimal), `addr` (ipaddr) and `ttl` (duration).
// Core's fixture has no decimal or ipaddr attribute, and those two are exactly
// the kinds whose SQL binding is non-obvious — `numeric` is exact decimal where a
// float is not, and `inet` equality compares address *and* prefix, which is
// Cedar's rule and neither text equality nor network containment.
//
// The hierarchy is two levels with a reflexive case reachable at every level:
//
//     Org o1  ←  Folder f1..f3  ←  Doc d0..dN
//
// so `resource in Folder::"f1"` (parent), `resource.folder in Folder::"f1"`
// (self, at an attribute) and `resource in Doc::"d3"` (self, at the row) are all
// expressible. It is materialised three times over — a denormalised column, a
// closure table and a parent pointer — so all four hierarchy mapping kinds are
// exercised against the same ground truth.
//
// Every scalar attribute is *also* mirrored into a `meta` jsonb column, so a
// third mapping reads the identical population through `#>>` + casts. That is the
// one code path with no drizzle counterpart worth trusting on inspection: a
// `bigint` that arrives as text and a `numeric` that arrives as text have to
// compare the way Cedar's `long` and `decimal` do, and only Postgres can say.

import {
	entity,
	type EntityGraph,
	type EntityRef,
	defineVocabulary,
	t,
} from "@nestm/permissions-core";
import type { HierarchyQuery, PlanRow } from "@nestm/permissions-core/testing";
import { EntitySchema, type DataSource } from "typeorm";

import {
	createTypeOrmResourceMapping,
	type TypeOrmResourceMapping,
} from "../../src/compile/mapping.ts";

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

export const docVocabulary = defineVocabulary({
	namespace: "Test",
	entities: {
		Org: {},
		Group: {},
		User: { memberOf: ["Group", "Org"], attrs: { org: t.ref("Org") } },
		Folder: { memberOf: ["Org"], attrs: { org: t.ref("Org") } },
		Doc: {
			memberOf: ["Folder"],
			attrs: {
				folder: t.ref("Folder"),
				owner: t.ref("User"),
				status: t.string(),
				title: t.string(),
				size: t.long(),
				archived: t.bool(),
				labels: t.set(t.string()),
				/** Optional on purpose: forces `has`-guarded policies, which is where plan and check diverge. */
				publishedAt: t.optional(t.ext("datetime")),
				reviewer: t.optional(t.ref("User")),
				score: t.optional(t.long()),
				/** NUMERIC. `decimal("1.5") == decimal("1.50")` in Cedar, and `1.5 = 1.50` in Postgres. */
				rate: t.optional(t.ext("decimal")),
				/** INET. Cedar compares address + prefix; so does Postgres. */
				addr: t.optional(t.ext("ipaddr")),
				/** BIGINT milliseconds. Orderable in Cedar, unlike decimal. */
				ttl: t.optional(t.ext("duration")),
			},
		},
	},
	actions: {
		"doc:read": { principal: ["User"], resource: ["Doc"] },
		"doc:write": { principal: ["User"], resource: ["Doc"] },
	},
});

export type DocVocabulary = typeof docVocabulary;

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------

/** One generated `Doc`, as the fixture stores it. */
export interface DocEntityRow {
	id: string;
	folderId: string;
	orgId: string;
	ownerId: string;
	status: string;
	title: string;
	size: string;
	archived: boolean;
	labels: string[];
	publishedAt: Date | null;
	reviewerId: string | null;
	score: string | null;
	rate: string | null;
	addr: string | null;
	ttlMs: string | null;
	meta: Record<string, unknown>;
}

/** A transitive-closure row, **without** self-pairs — the compiler adds reflexivity itself. */
export interface ClosureRow {
	ancestor: string;
	descendant: string;
}

/** A parent pointer, for the `WITH RECURSIVE` strategy. */
export interface NodeRow {
	id: string;
	parentId: string | null;
}

/**
 * Builds the fixture entity schemas under a unique prefix.
 *
 * A factory rather than three module-level schemas because vitest runs files in
 * separate workers against one database, and two workers sharing a table name
 * would drop each other's rows mid-assertion. The entity *name* is prefixed too:
 * two `EntitySchema`s with the same name in one `DataSource` is a silent
 * last-one-wins.
 */
export function createDocEntities(schemaName: string, prefix: string) {
	const docs = new EntitySchema<DocEntityRow>({
		name: `${prefix}docs`,
		tableName: `${prefix}docs`,
		schema: schemaName,
		columns: {
			id: { primary: true, type: "text" },
			folderId: { name: "folder_id", type: "text" },
			orgId: { name: "org_id", type: "text" },
			ownerId: { name: "owner_id", type: "text" },
			status: { type: "text" },
			title: { type: "text" },
			// `bigint`, not `integer`: this is the column that proves the `::bigint`
			// binding works, and node-postgres hands int8 back as a string.
			size: { type: "bigint" },
			archived: { type: "boolean" },
			labels: { type: "text", array: true },
			publishedAt: { name: "published_at", type: "timestamptz", nullable: true },
			reviewerId: { name: "reviewer_id", type: "text", nullable: true },
			score: { type: "bigint", nullable: true },
			rate: { type: "numeric", nullable: true },
			addr: { type: "inet", nullable: true },
			ttlMs: { name: "ttl_ms", type: "bigint", nullable: true },
			meta: { type: "jsonb" },
		},
	});

	const closure = new EntitySchema<ClosureRow>({
		name: `${prefix}closure`,
		tableName: `${prefix}closure`,
		schema: schemaName,
		columns: {
			ancestor: { primary: true, type: "text" },
			descendant: { primary: true, type: "text" },
		},
	});

	const nodes = new EntitySchema<NodeRow>({
		name: `${prefix}nodes`,
		tableName: `${prefix}nodes`,
		schema: schemaName,
		columns: {
			id: { primary: true, type: "text" },
			parentId: { name: "parent_id", type: "text", nullable: true },
		},
	});

	return { docs, closure, nodes };
}

export type DocEntities = ReturnType<typeof createDocEntities>;

// ---------------------------------------------------------------------------
// The fixed graph
// ---------------------------------------------------------------------------

export const ORG_ID = "o1";
export const FOLDER_IDS: readonly string[] = ["f1", "f2", "f3"];
export const GROUP_IDS: readonly string[] = ["g1", "g2"];
export const USER_IDS: readonly string[] = ["u1", "u2", "u3"];

/** `u3` belongs to no group — the empty-ancestor case. */
const USER_GROUPS: Readonly<Record<string, readonly string[]>> = { u1: ["g1"], u2: ["g2"], u3: [] };

export const STATUSES: readonly string[] = ["draft", "review", "published", "archived"];

/**
 * Every SQL and Cedar metacharacter appears in at least one title: `%` and `_`
 * (SQL wildcards Cedar treats as ordinary text), `*` (Cedar's wildcard, written
 * `\*` to mean literally), a backslash, a quote and a semicolon. A `like` fuzz
 * over alphanumeric titles alone would pass against a driver with a
 * `%`-injection bug.
 */
export const TITLES: readonly string[] = [
	"alpha",
	"alpha-beta",
	"beta",
	"a*b",
	"50% off",
	"under_score",
	"back\\slash",
	"quote'; drop table docs; --",
	":nestmp_0",
	"",
];

export const LABELS: readonly string[] = ["nightly", "urgent", "draft"];

export const RATES: readonly string[] = ["0.5", "1.5", "1.50", "2.25", "-3.125"];
export const ADDRESSES: readonly string[] = ["10.0.0.1", "10.0.0.2", "192.168.1.1", "fe80::1"];
export const TTLS: readonly number[] = [1000, 60_000, 3_600_000];

export const PUBLISH_DATES: readonly Date[] = [
	new Date("2025-01-01T00:00:00.000Z"),
	new Date("2026-01-01T00:00:00.000Z"),
	new Date("2026-07-30T12:00:00.000Z"),
	new Date("2027-01-01T00:00:00.000Z"),
];

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

/** One generated `Doc`. Optional fields are absent as `undefined`, never `null`. */
export interface DocRow {
	readonly id: string;
	readonly folder: string;
	readonly owner: string;
	readonly status: string;
	readonly title: string;
	readonly size: number;
	readonly archived: boolean;
	readonly labels: readonly string[];
	readonly publishedAt?: Date | undefined;
	readonly reviewer?: string | undefined;
	readonly score?: number | undefined;
	readonly rate?: string | undefined;
	readonly addr?: string | undefined;
	readonly ttl?: number | undefined;
}

/**
 * The row as core's reference interpreter sees it.
 *
 * Keys are *attribute* names, values are what a driver reads back out of the
 * column — which is why `null` and `undefined` both have to mean "absent" to the
 * interpreter, and do.
 */
export function toPlanRow(row: DocRow): PlanRow {
	return {
		folder: row.folder,
		owner: row.owner,
		status: row.status,
		title: row.title,
		size: row.size,
		archived: row.archived,
		labels: [...row.labels],
		publishedAt: row.publishedAt,
		reviewer: row.reviewer,
		score: row.score,
		rate: row.rate,
		addr: row.addr,
		ttl: row.ttl,
	};
}

/** The `meta` jsonb document: the same values, reachable through `#>>`. */
export function toMetaDocument(row: DocRow): Record<string, unknown> {
	return {
		status: row.status,
		title: row.title,
		size: row.size,
		archived: row.archived,
		labels: [...row.labels],
		// Spread-if-present: an absent key and a JSON `null` both read back as SQL
		// NULL through `#>>`, but only the absent key matches what Cedar means.
		...(row.publishedAt === undefined ? {} : { publishedAt: row.publishedAt.toISOString() }),
		...(row.score === undefined ? {} : { score: row.score }),
		...(row.rate === undefined ? {} : { rate: row.rate }),
		...(row.addr === undefined ? {} : { addr: row.addr }),
		...(row.ttl === undefined ? {} : { ttl: row.ttl }),
	};
}

// ---------------------------------------------------------------------------
// Cedar entities
// ---------------------------------------------------------------------------

/** The org, folders, groups and users — everything but the docs. */
export function fixedEntities(): EntityGraph {
	return [
		entity(docVocabulary, "Org", ORG_ID, { attrs: {} }),
		...FOLDER_IDS.map((id) =>
			entity(docVocabulary, "Folder", id, {
				attrs: { org: { type: "Org", id: ORG_ID } },
				parents: [{ type: "Org", id: ORG_ID }],
			}),
		),
		...GROUP_IDS.map((id) => entity(docVocabulary, "Group", id, { attrs: {} })),
		...USER_IDS.map((id) =>
			entity(docVocabulary, "User", id, {
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
	return entity(docVocabulary, "Doc", row.id, {
		attrs: {
			folder: { type: "Folder", id: row.folder },
			owner: { type: "User", id: row.owner },
			status: row.status,
			title: row.title,
			size: row.size,
			archived: row.archived,
			labels: [...row.labels],
			...(row.publishedAt === undefined ? {} : { publishedAt: row.publishedAt }),
			...(row.reviewer === undefined ? {} : { reviewer: { type: "User", id: row.reviewer } }),
			...(row.score === undefined ? {} : { score: row.score }),
			...(row.rate === undefined ? {} : { rate: row.rate }),
			...(row.addr === undefined ? {} : { addr: row.addr }),
			...(row.ttl === undefined ? {} : { ttl: row.ttl }),
		},
		parents: [{ type: "Folder", id: row.folder }],
	});
}

/** The graph one `check()` needs: the principal's side plus this one row. */
export function checkEntities(row: DocRow, fixed: EntityGraph): EntityGraph {
	return [...fixed, docEntity(row)];
}

// ---------------------------------------------------------------------------
// Hierarchy oracle
// ---------------------------------------------------------------------------

const REFERENCE_TYPES: Readonly<Record<string, string>> = {
	folder: "Folder",
	owner: "User",
	reviewer: "User",
};

function ancestorsOf(reference: EntityRef<string>): EntityRef<string>[] {
	switch (reference.type) {
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

/** Cedar `in` over the fixture graph — **descendant-or-self**. */
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

/** The `HierarchyResolver` handed to `evaluatePlanNode`. Throws rather than guessing. */
export function resolveHierarchy(query: HierarchyQuery): boolean {
	const { attr, rowId, parent, value } = query;

	if (attr === null) {
		if (rowId === undefined) {
			throw new Error("resolveHierarchy was asked about the row itself with no rowId");
		}
		if (isSelf({ type: "Doc", id: rowId }, parent)) {
			return true;
		}
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

// ---------------------------------------------------------------------------
// Mappings
// ---------------------------------------------------------------------------

/** Attributes read from their own columns. */
function columnAttributes(): Record<
	string,
	import("../../src/compile/mapping.ts").TypeOrmAttributeMapping
> {
	return {
		owner: { kind: "entity", column: "ownerId", entityType: "User" },
		reviewer: { kind: "entity", column: "reviewerId", entityType: "User" },
		status: { kind: "scalar", column: "status", valueKind: "string" },
		title: { kind: "scalar", column: "title", valueKind: "string" },
		size: { kind: "scalar", column: "size", valueKind: "long" },
		archived: { kind: "scalar", column: "archived", valueKind: "bool" },
		labels: { kind: "array", column: "labels", elementKind: "string" },
		publishedAt: { kind: "scalar", column: "publishedAt", valueKind: "datetime" },
		score: { kind: "scalar", column: "score", valueKind: "long" },
		rate: { kind: "scalar", column: "rate", valueKind: "decimal" },
		addr: { kind: "scalar", column: "addr", valueKind: "ipaddr" },
		ttl: { kind: "scalar", column: "ttlMs", valueKind: "duration" },
	};
}

/** The same attributes, read out of the `meta` jsonb document instead. */
function jsonAttributes(): Record<
	string,
	import("../../src/compile/mapping.ts").TypeOrmAttributeMapping
> {
	const json = (
		key: string,
		valueKind: import("../../src/compile/mapping.ts").TypeOrmScalarKind,
	): import("../../src/compile/mapping.ts").TypeOrmAttributeMapping => ({
		kind: "jsonPath",
		column: "meta",
		path: [key],
		valueKind,
	});

	return {
		// Entity references stay on their own columns: a jsonPath mapping cannot be
		// an entity mapping, and the hierarchy strategies are keyed by real ids.
		owner: { kind: "entity", column: "ownerId", entityType: "User" },
		reviewer: { kind: "entity", column: "reviewerId", entityType: "User" },
		status: json("status", "string"),
		title: json("title", "string"),
		size: json("size", "long"),
		archived: json("archived", "bool"),
		labels: json("labels", "string"),
		publishedAt: json("publishedAt", "datetime"),
		score: json("score", "long"),
		rate: json("rate", "decimal"),
		addr: json("addr", "ipaddr"),
		ttl: json("ttl", "duration"),
	};
}

/**
 * Mapping A — the row's ancestry through a denormalised column and a recursive
 * walk; the `folder` attribute's through the closure table.
 */
export function docMappingColumnAndRecursive(
	dataSource: DataSource,
	entities: DocEntities,
): TypeOrmResourceMapping<"Doc"> {
	return createTypeOrmResourceMapping(dataSource, {
		resourceType: "Doc",
		entity: entities.docs,
		id: "id",
		attributes: {
			...columnAttributes(),
			folder: {
				kind: "entity",
				column: "folderId",
				entityType: "Folder",
				hierarchy: {
					// Reflexive: `Folder::"f1" in Folder::"f1"` is true.
					Folder: { kind: "self" },
					Org: {
						kind: "closure",
						entity: entities.closure,
						ancestor: "ancestor",
						descendant: "descendant",
					},
				},
			},
		},
		hierarchy: {
			Doc: { kind: "self" },
			Folder: { kind: "column", column: "folderId" },
			Org: { kind: "recursive", entity: entities.nodes, parentColumn: "parentId", idColumn: "id" },
		},
	});
}

/** Mapping B — the same relation through the other two strategies, to prove they agree. */
export function docMappingClosureAndRecursive(
	dataSource: DataSource,
	entities: DocEntities,
): TypeOrmResourceMapping<"Doc"> {
	const closure = {
		kind: "closure",
		entity: entities.closure,
		ancestor: "ancestor",
		descendant: "descendant",
	} as const;

	return createTypeOrmResourceMapping(dataSource, {
		resourceType: "Doc",
		entity: entities.docs,
		id: "id",
		attributes: {
			...columnAttributes(),
			folder: {
				kind: "entity",
				column: "folderId",
				entityType: "Folder",
				hierarchy: {
					Folder: { kind: "self" },
					Org: {
						kind: "recursive",
						entity: entities.nodes,
						parentColumn: "parentId",
						idColumn: "id",
					},
				},
			},
		},
		hierarchy: { Doc: { kind: "self" }, Folder: closure, Org: closure },
	});
}

/** Mapping C — every scalar through the `meta` jsonb document. */
export function docMappingJsonPath(
	dataSource: DataSource,
	entities: DocEntities,
): TypeOrmResourceMapping<"Doc"> {
	return createTypeOrmResourceMapping(dataSource, {
		resourceType: "Doc",
		entity: entities.docs,
		id: "id",
		attributes: {
			...jsonAttributes(),
			folder: {
				kind: "entity",
				column: "folderId",
				entityType: "Folder",
				hierarchy: {
					Folder: { kind: "self" },
					Org: {
						kind: "closure",
						entity: entities.closure,
						ancestor: "ancestor",
						descendant: "descendant",
					},
				},
			},
		},
		hierarchy: {
			Doc: { kind: "self" },
			Folder: { kind: "column", column: "folderId" },
			Org: { kind: "recursive", entity: entities.nodes, parentColumn: "parentId", idColumn: "id" },
		},
	});
}

// ---------------------------------------------------------------------------
// Provisioning
// ---------------------------------------------------------------------------

/** `CREATE TABLE` for the fixture, hand-written because it is a test fixture, not the product. */
export function docTableDdl(schemaName: string, prefix: string): readonly string[] {
	const table = (name: string): string => `"${schemaName}"."${prefix}${name}"`;
	return [
		`create schema if not exists "${schemaName}"`,
		`create table ${table("docs")} (
			"id" text primary key,
			"folder_id" text not null,
			"org_id" text not null,
			"owner_id" text not null,
			"status" text not null,
			"title" text not null,
			"size" bigint not null,
			"archived" boolean not null,
			"labels" text[] not null,
			"published_at" timestamptz,
			"reviewer_id" text,
			"score" bigint,
			"rate" numeric,
			"addr" inet,
			"ttl_ms" bigint,
			"meta" jsonb not null
		)`,
		`create table ${table("closure")} ("ancestor" text not null, "descendant" text not null, primary key ("ancestor", "descendant"))`,
		`create table ${table("nodes")} ("id" text primary key, "parent_id" text)`,
	];
}

export function docTableDropDdl(schemaName: string, prefix: string): string {
	const table = (name: string): string => `"${schemaName}"."${prefix}${name}"`;
	return `drop table if exists ${table("docs")}, ${table("closure")}, ${table("nodes")} cascade`;
}

/**
 * Seeds the two hierarchy materialisations.
 *
 * The closure deliberately carries **no self-pairs**: the compiled SQL supplies
 * reflexivity itself (`seed = $parent OR EXISTS …`), and a fixture that stored
 * self-pairs would hide a compiler that had forgotten to.
 */
export async function seedHierarchy(
	dataSource: DataSource,
	entities: DocEntities,
	rows: readonly DocRow[],
): Promise<void> {
	const closureRows: ClosureRow[] = [];
	const nodeRows: NodeRow[] = [{ id: ORG_ID, parentId: null }];

	for (const folder of FOLDER_IDS) {
		closureRows.push({ ancestor: ORG_ID, descendant: folder });
		nodeRows.push({ id: folder, parentId: ORG_ID });
	}
	for (const group of GROUP_IDS) {
		nodeRows.push({ id: group, parentId: null });
	}
	for (const user of USER_IDS) {
		closureRows.push({ ancestor: ORG_ID, descendant: user });
		for (const group of USER_GROUPS[user] ?? []) {
			closureRows.push({ ancestor: group, descendant: user });
		}
		nodeRows.push({ id: user, parentId: ORG_ID });
	}
	for (const row of rows) {
		closureRows.push({ ancestor: row.folder, descendant: row.id });
		closureRows.push({ ancestor: ORG_ID, descendant: row.id });
		nodeRows.push({ id: row.id, parentId: row.folder });
	}

	await dataSource.getRepository(entities.closure).clear();
	await dataSource.getRepository(entities.nodes).clear();
	await insertChunked(dataSource, entities.closure, closureRows);
	await insertChunked(dataSource, entities.nodes, nodeRows);
}

/** Replaces the `docs` table's contents with `rows`. */
export async function seedDocs(
	dataSource: DataSource,
	entities: DocEntities,
	rows: readonly DocRow[],
): Promise<void> {
	await dataSource.getRepository(entities.docs).clear();
	if (rows.length === 0) {
		return;
	}

	await insertChunked(
		dataSource,
		entities.docs,
		rows.map((row) => ({
			id: row.id,
			folderId: row.folder,
			orgId: ORG_ID,
			ownerId: row.owner,
			status: row.status,
			title: row.title,
			// TypeORM's `bigint` round-trips as a string; handing it a number works but
			// is one implicit conversion away from a rounding surprise.
			size: String(row.size),
			archived: row.archived,
			labels: [...row.labels],
			publishedAt: row.publishedAt ?? null,
			reviewerId: row.reviewer ?? null,
			score: row.score === undefined ? null : String(row.score),
			rate: row.rate ?? null,
			addr: row.addr ?? null,
			ttlMs: row.ttl === undefined ? null : String(row.ttl),
			meta: toMetaDocument(row),
		})),
	);
}

async function insertChunked<T extends object>(
	dataSource: DataSource,
	target: EntitySchema<T>,
	rows: readonly T[],
): Promise<void> {
	if (rows.length === 0) {
		return;
	}
	// Postgres caps a statement at 65535 bind parameters; a 16-column insert hits
	// it at ~4000 rows. Chunking keeps the fixture usable at any population size.
	const chunkSize = 500;
	for (let index = 0; index < rows.length; index += chunkSize) {
		await dataSource
			.createQueryBuilder()
			.insert()
			.into(target)
			.values(rows.slice(index, index + chunkSize) as never)
			.execute();
	}
}
