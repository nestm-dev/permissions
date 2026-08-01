-- ==========================================================================
-- COPY-IN DESTINATION: packages/database/drizzle/0004_cedar-policy-store.sql
--
-- Also required (S3, mechanical): add the journal entry so drizzle-kit does not
-- try to regenerate this migration.
--
--   packages/database/drizzle/meta/_journal.json  ->  entries[]:
--     { "idx": 4, "version": "7", "when": <epoch-ms>, "tag": "0004_cedar-policy-store", "breakpoints": true }
--
--   packages/database/drizzle/meta/0004_snapshot.json  ->  produced by
--   `pnpm database:generate`; do NOT hand-write it.
--
-- HOW TO PRODUCE THIS FILE FOR REAL (the staged copy is the reference, and the
-- reason it exists is so the hand-appended half is not archaeology):
--
--   1. merge `schema-permissions.ts` into packages/database/src/schema.ts
--      (including the `role_grants_organization_id_id_unique` line)
--   2. pnpm database:generate            # writes 0004_*.sql + 0004_snapshot.json
--   3. append everything below the "HAND-APPENDED" banner to the generated file
--   4. pnpm database:drift               # must report no diff
--
-- Steps 1-2 emit the tables, constraints, indexes and CREATE POLICY statements.
-- They do NOT emit GRANTs, and `FORCE ROW LEVEL SECURITY` — the half that makes
-- RLS apply to the table's owner too — has no schema-level representation at
-- all. That is exactly the split `0003_audit-trail.sql:17-19` already has.
--
-- The hand-appended block is `permissionsPostgresPolicyStatements({ role:
-- "station_app" })` verbatim, minus the two `ENABLE ROW LEVEL SECURITY`
-- statements drizzle-kit already emitted for the two policy-carrying tables.
-- ==========================================================================

-- ---------------------------------------------------------------------------
-- The composite unique `permission_policy_links` points at.
--
-- `role_grants.id` is already the PRIMARY KEY, so this adds an index but no new
-- invariant; a composite FOREIGN KEY needs a UNIQUE on exactly the referenced
-- column pair. Every other Organization-scoped table already carries the same
-- constraint under the same name shape.
-- ---------------------------------------------------------------------------
ALTER TABLE "role_grants" ADD CONSTRAINT "role_grants_organization_id_id_unique" UNIQUE("organization_id","id");--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- permission_policies — static policies AND templates in one table, so "list
-- everything in this scope" stays a single query. `kind` is checked, not
-- trusted. `cedar_json` is the canonical persisted form; `cedar_text` beside it
-- is denormalised for humans and is never parsed back.
-- ---------------------------------------------------------------------------
CREATE TABLE "permission_policies" (
	"organization_id" uuid NOT NULL,
	"policy_id" text NOT NULL,
	"kind" text NOT NULL,
	"cedar_json" jsonb NOT NULL,
	"cedar_text" text,
	"description" text,
	"annotations" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "permission_policies_pk" PRIMARY KEY("organization_id","policy_id"),
	CONSTRAINT "permission_policies_kind_check" CHECK ("permission_policies"."kind" in ('static', 'template'))
);
--> statement-breakpoint
ALTER TABLE "permission_policies" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- permission_policy_links — template instantiations; the role-grant primitive.
--
-- Slot values are COLUMNS, not a `values jsonb`: "revoke every grant for member
-- X" and "who holds this Role?" stay plain indexed statements, which is exactly
-- `role_grants`' access pattern. Both slot pairs are nullable with a pair check
-- because a template declaring only `?principal` must be linkable without
-- inventing a `?resource` (core delta D6); Station always fills both.
--
-- `link_id` is `uuid`, not the driver's default `text`: it IS `role_grants.id`,
-- and PostgreSQL refuses a text->uuid foreign key. Produced by the factory's
-- `linkIdColumn: () => uuid("link_id").notNull()` option, so this DDL is
-- generated rather than hand-edited and `pnpm database:drift` stays clean.
-- ---------------------------------------------------------------------------
CREATE TABLE "permission_policy_links" (
	"organization_id" uuid NOT NULL,
	"link_id" uuid NOT NULL,
	"template_id" text NOT NULL,
	"principal_type" text,
	"principal_id" text,
	"resource_type" text,
	"resource_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "permission_policy_links_pk" PRIMARY KEY("organization_id","link_id"),
	CONSTRAINT "permission_policy_links_principal_slot_check" CHECK (("permission_policy_links"."principal_type" is null) = ("permission_policy_links"."principal_id" is null)),
	CONSTRAINT "permission_policy_links_resource_slot_check" CHECK (("permission_policy_links"."resource_type" is null) = ("permission_policy_links"."resource_id" is null))
);
--> statement-breakpoint
ALTER TABLE "permission_policy_links" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- permission_scope_versions — the invalidation stamp. One monotonic counter per
-- Organization, bumped in the SAME transaction as every write it describes.
-- A counter and not a timestamp: immune to clock skew between replicas.
--
-- DELIBERATELY NO ROW LEVEL SECURITY. See the ADR-0020 carve-out and the
-- docs/SECURITY.md amendment; the short version is that the poller reads this
-- table with no Organization context (it does not know which tenants changed
-- until it reads), so under RLS it returns zero rows and no replica ever
-- invalidates its policy cache.
-- ---------------------------------------------------------------------------
CREATE TABLE "permission_scope_versions" (
	"organization_id" uuid NOT NULL,
	"version" bigint DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "permission_scope_versions_pk" PRIMARY KEY("organization_id")
);
--> statement-breakpoint

ALTER TABLE "permission_policies" ADD CONSTRAINT "permission_policies_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "permission_policy_links" ADD CONSTRAINT "permission_policy_links_template_fk" FOREIGN KEY ("organization_id","template_id") REFERENCES "public"."permission_policies"("organization_id","policy_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "permission_policy_links" ADD CONSTRAINT "permission_policy_links_role_grant_fk" FOREIGN KEY ("organization_id","link_id") REFERENCES "public"."role_grants"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "permission_scope_versions" ADD CONSTRAINT "permission_scope_versions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

-- The load path is "everything enabled in this Organization", so the index is
-- partial on exactly that predicate.
CREATE INDEX "permission_policies_organization_id_enabled_index" ON "permission_policies" USING btree ("organization_id") WHERE "permission_policies"."enabled";--> statement-breakpoint
-- Answers "which policies mention Run?" without a scan, for a future policy
-- admin surface. `jsonb_path_ops` is the containment-only opclass: smaller and
-- faster than the default for `@>`, which is the only operator that query uses.
CREATE INDEX "permission_policies_cedar_json_index" ON "permission_policies" USING gin ("cedar_json" jsonb_path_ops);--> statement-breakpoint
CREATE INDEX "permission_policy_links_principal_index" ON "permission_policy_links" USING btree ("organization_id","principal_type","principal_id");--> statement-breakpoint
-- The poller's only query is `updated_at > $since`.
CREATE INDEX "permission_scope_versions_updated_at_index" ON "permission_scope_versions" USING btree ("updated_at");--> statement-breakpoint

CREATE POLICY "permission_policies_isolation_policy" ON "permission_policies" AS PERMISSIVE FOR ALL TO public USING ("permission_policies"."organization_id" = nullif(current_setting('station.organization_id', true), '')::uuid) WITH CHECK ("permission_policies"."organization_id" = nullif(current_setting('station.organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "permission_policy_links_isolation_policy" ON "permission_policy_links" AS PERMISSIVE FOR ALL TO public USING ("permission_policy_links"."organization_id" = nullif(current_setting('station.organization_id', true), '')::uuid) WITH CHECK ("permission_policy_links"."organization_id" = nullif(current_setting('station.organization_id', true), '')::uuid);--> statement-breakpoint

-- ==========================================================================
-- HAND-APPENDED  (everything below this banner; mirrors 0003_audit-trail.sql:17-19)
--
-- Source: permissionsPostgresPolicyStatements({ role: "station_app" }) from
-- `@nestm/permissions-drizzle`, minus the two ENABLE statements drizzle-kit
-- already emitted above, and with `rowLevelSecurityOnScopeVersions` left at its
-- default `false` — the approved carve-out.
-- ==========================================================================

-- Without FORCE, the table OWNER bypasses every policy — and the owner is the
-- role migrations run as. `station_app` is NOBYPASSRLS, but FORCE is what makes
-- an isolation test meaningful when it is run by anyone else.
ALTER TABLE "permission_policies" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "permission_policy_links" FORCE ROW LEVEL SECURITY;--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE ON "permission_policies", "permission_policy_links" TO "station_app";--> statement-breakpoint
-- No DELETE on the version table: a role that cannot delete a row cannot reset
-- an invalidation stamp backwards, which would make every replica believe its
-- cache is fresh.
GRANT SELECT, INSERT, UPDATE ON "permission_scope_versions" TO "station_app";

-- ==========================================================================
-- DOWN MIGRATION
--
-- drizzle-kit does not generate one; this is the Phase-0 rollback referenced by
-- RUNBOOK.md. It is a comment on purpose — `drizzle-kit migrate` would execute
-- anything left uncommented. Run it by hand, in a transaction, against the
-- database being rolled back.
--
-- Safe to run at any point before S7 (cutover): nothing reads these tables
-- while STATION_AUTHZ_ENGINE is `legacy` or `shadow`. After S7 it is a data
-- loss event, and the rollback is the environment flag instead.
--
-- BEGIN;
--   DROP TABLE IF EXISTS "permission_policy_links";
--   DROP TABLE IF EXISTS "permission_policies";
--   DROP TABLE IF EXISTS "permission_scope_versions";
--   ALTER TABLE "role_grants" DROP CONSTRAINT IF EXISTS "role_grants_organization_id_id_unique";
-- COMMIT;
--
-- The two policy tables drop their own policies, indexes and grants with them.
-- `role_grants` keeps its PRIMARY KEY and both partial unique indexes; only the
-- constraint this migration added is removed. Then delete the `0004` entry from
-- `drizzle/meta/_journal.json`, delete `drizzle/meta/0004_snapshot.json`, and
-- revert the `schema.ts` merge — `pnpm database:drift` is the check that the
-- three stayed in step.
-- ==========================================================================
