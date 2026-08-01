// A fixed-name table and a mapping that covers every DSL arm, for the suites
// that never touch Postgres.
//
// Separate from `doc-population.ts` on purpose. That fixture's tables carry a
// per-worker prefix so two vitest workers cannot drop each other's rows, which
// is exactly right for the differential suite and exactly wrong for a golden SQL
// snapshot — the table name is *in* the rendered statement, so a random prefix
// would make every snapshot unstable. Nothing here is ever created in a
// database; these tables exist only to be rendered.

import type {
	AttrPath,
	PlanApproximation,
	PlanDiagnostics,
	PlanNode,
	PostFilter,
	QueryPlan,
} from "@nestm/permissions-core/plan";
import {
	PgDialect,
	bigint,
	boolean,
	inet,
	jsonb,
	numeric,
	pgTable,
	text,
	timestamp,
} from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

import type { DrizzleResourceMapping } from "../../src/compile/mapping.ts";

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

export const docs = pgTable("docs", {
	id: text("id").primaryKey(),
	folderId: text("folder_id"),
	tenantId: text("tenant_id"),
	ownerId: text("owner_id"),
	status: text("status"),
	title: text("title"),
	size: bigint("size", { mode: "number" }),
	archived: boolean("archived"),
	labels: text("labels").array(),
	publishedAt: timestamp("published_at", { withTimezone: true, mode: "date" }),
	rate: numeric("rate"),
	addr: inet("addr"),
	ttlMs: bigint("ttl_ms", { mode: "number" }),
	meta: jsonb("meta"),
});

export const closure = pgTable("doc_closure", {
	ancestor: text("ancestor").notNull(),
	descendant: text("descendant").notNull(),
});

export const nodes = pgTable("doc_nodes", {
	id: text("id").primaryKey(),
	parentId: text("parent_id"),
});

// ---------------------------------------------------------------------------
// Mappings
// ---------------------------------------------------------------------------

const closureMapping = {
	kind: "closure",
	table: closure,
	ancestor: closure.ancestor,
	descendant: closure.descendant,
} as const;

const recursiveMapping = {
	kind: "recursive",
	parentColumn: nodes.parentId,
	idColumn: nodes.id,
} as const;

/**
 * One mapping exercising every arm of the DSL.
 *
 * Four *distinct* parent entity types at row level, one per
 * `DrizzleHierarchyMapping` kind, because the golden-SQL suite has to render all
 * four and a mapping can only declare one strategy per parent type.
 */
export const docMapping: DrizzleResourceMapping<"Doc"> = {
	resourceType: "Doc",
	table: docs,
	id: docs.id,
	attributes: {
		status: { kind: "scalar", column: docs.status, valueKind: "string" },
		title: { kind: "scalar", column: docs.title, valueKind: "string" },
		size: { kind: "scalar", column: docs.size, valueKind: "long" },
		archived: { kind: "scalar", column: docs.archived, valueKind: "bool" },
		publishedAt: { kind: "scalar", column: docs.publishedAt, valueKind: "datetime" },
		rate: { kind: "scalar", column: docs.rate, valueKind: "decimal" },
		addr: { kind: "scalar", column: docs.addr, valueKind: "ipaddr" },
		ttl: { kind: "scalar", column: docs.ttlMs, valueKind: "duration" },
		owner: { kind: "entity", column: docs.ownerId, entityType: "User" },
		folder: {
			kind: "entity",
			column: docs.folderId,
			entityType: "Folder",
			hierarchy: { Folder: { kind: "self" }, Org: closureMapping },
		},
		labels: { kind: "array", column: docs.labels, elementKind: "string" },
		tier: { kind: "jsonPath", column: docs.meta, path: ["tier"], valueKind: "string" },
		tags: { kind: "jsonPath", column: docs.meta, path: ["tags"], valueKind: "string" },
	},
	hierarchy: {
		Doc: { kind: "self" },
		Folder: { kind: "column", column: docs.folderId },
		Org: closureMapping,
		Tenant: recursiveMapping,
	},
};

/** The same mapping, declared to sit under a case-insensitive collation. */
export const caseInsensitiveMapping: DrizzleResourceMapping<"Doc"> = {
	...docMapping,
	text: { collation: "case-insensitive" },
};

/** The same mapping with a non-default `LIKE … ESCAPE` character. */
export const tildeEscapeMapping: DrizzleResourceMapping<"Doc"> = {
	...docMapping,
	text: { escapeChar: "~" },
};

/** A mapping declaring nothing at all — the "every question is unanswerable" case. */
export const emptyMapping: DrizzleResourceMapping<"Doc"> = {
	resourceType: "Doc",
	table: docs,
	id: docs.id,
	attributes: {},
};

// ---------------------------------------------------------------------------
// AST builders
// ---------------------------------------------------------------------------

/** `resource.<name>`. */
export function attr(name: string): AttrPath {
	return { root: "resource", path: [name] };
}

/** `principal.<name>` — never compilable; rows carry resource attributes only. */
export function principalAttr(name: string): AttrPath {
	return { root: "principal", path: [name] };
}

const diagnostics: PlanDiagnostics = {
	residualPolicyIds: [],
	erroredPolicyIds: [],
	policySetVersion: "g0:s1",
	cache: "miss",
	durationMs: 0,
	explain: () => "test plan",
};

/** Options shared by the three plan builders. */
export interface PlanOptions {
	readonly resourceType?: string;
	readonly approximations?: readonly PlanApproximation[];
}

/** A `CONDITIONAL` plan around `condition`. */
export function conditionalPlan(
	condition: PlanNode,
	options: PlanOptions & { readonly postFilter?: PostFilter } = {},
): QueryPlan<string> {
	return {
		kind: "CONDITIONAL",
		resourceType: options.resourceType ?? "Doc",
		approximations: options.approximations ?? [],
		diagnostics,
		condition,
		...(options.postFilter === undefined ? {} : { postFilter: options.postFilter }),
	};
}

/** An `ALWAYS_ALLOW` plan. */
export function allowPlan(options: PlanOptions = {}): QueryPlan<string> {
	return {
		kind: "ALWAYS_ALLOW",
		resourceType: options.resourceType ?? "Doc",
		approximations: options.approximations ?? [],
		diagnostics,
	};
}

/** An `ALWAYS_DENY` plan. */
export function denyPlan(options: PlanOptions = {}): QueryPlan<string> {
	return {
		kind: "ALWAYS_DENY",
		resourceType: options.resourceType ?? "Doc",
		approximations: options.approximations ?? [],
		diagnostics,
	};
}

/** One recorded approximation, in either direction. */
export function approximation(
	direction: "permissive" | "restrictive",
	overrides: Partial<PlanApproximation> = {},
): PlanApproximation {
	return {
		policyId: "p1",
		effect: "permit",
		direction,
		reason: "arithmetic",
		expr: { Value: true } as PlanApproximation["expr"],
		message: `a ${direction} approximation`,
		...overrides,
	};
}

/** A `postFilter` that re-checks nothing — the suites only assert its presence. */
export const noopPostFilter: PostFilter = async (rows) => [...rows];

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const dialect = new PgDialect();

/** The statement text and bound parameters a compiled condition would produce. */
export function renderSql(condition: SQL): { readonly sql: string; readonly params: unknown[] } {
	const query = dialect.sqlToQuery(condition);
	return { sql: query.sql, params: [...query.params] };
}
