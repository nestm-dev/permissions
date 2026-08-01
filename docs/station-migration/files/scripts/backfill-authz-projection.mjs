// ===========================================================================
// COPY-IN DESTINATION: packages/database/scripts/backfill-authz-projection.mjs
//
// NOT the repository root. Station's root `node_modules` holds only the build
// toolchain — `pg` and `dotenv` resolve from `packages/database/node_modules`,
// so a script at `scripts/` cannot import either. Add the runner to the ROOT
// package.json instead, next to `database:migrate`:
//
//   "authz:backfill": "pnpm --filter=@station/database exec node scripts/backfill-authz-projection.mjs",
//   "authz:drift":    "pnpm --filter=@station/database exec node scripts/assert-authz-projection.mjs",
//
// Usage:
//   pnpm authz:backfill                       # every Organization
//   pnpm authz:backfill --dry-run             # counts only, no writes
//   pnpm authz:backfill --organization <uuid> # repeatable; skips enumeration
//
// Connection: the OPERATIONAL connection, the same one `pnpm database:migrate`
// uses (`DATABASE_URL` from the root `.env`). It works on a `station_app`
// connection too — every statement runs inside an Organization context — but
// enumerating Organizations needs a role that can read `organizations` with no
// context, which under FORCE RLS means a superuser or an explicit
// `--organization` list.
// ===========================================================================
//
// IDEMPOTENT BY CONSTRUCTION. Templates are keyed `role:<roles.id>` and links
// reuse `role_grants.id`, so re-running converges rather than duplicating. Safe
// to run before, during and after the cutover; safe to run repeatedly.
//
// The SQL below must stay semantically identical to
// `packages/database/src/authorization-projection.ts` — same `policy_id`
// derivation, same `permissions.key` ordering inside `action.entities`, same
// annotation keys. `assert-authz-projection.mjs` compares the two by `jsonb`
// equality, so a divergence is caught, but it is caught as drift rather than as
// the bug it is. Change both or neither.

import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";
import pg from "pg";

loadDotenv({
  path: fileURLToPath(new URL("../../../.env", import.meta.url)),
  override: false,
  quiet: true,
});

const databaseUrl = process.env.DATABASE_URL?.trim();

if (!databaseUrl) {
  process.stderr.write("Missing required environment variable: DATABASE_URL\n");
  process.exit(1);
}

const argv = process.argv.slice(2);
const dryRun = argv.includes("--dry-run");
const explicitOrganizations = argv.flatMap((value, index) =>
  argv[index - 1] === "--organization" ? [value] : [],
);

// ---------------------------------------------------------------------------
// The projection, as set-based SQL. One statement per invariant.
// ---------------------------------------------------------------------------

/**
 * Upsert one template per Role that carries at least one Permission.
 *
 * The `JOIN LATERAL … ON b.entities IS NOT NULL` is the empty-bundle filter:
 * `jsonb_agg` over no rows is NULL, so a Role with no Permissions produces no
 * row here and is removed by DELETE_EMPTY_OR_ORPHANED_TEMPLATES below. Cedar's
 * `action in []` is parseable but never satisfiable, and carrying an
 * unsatisfiable policy through `validateOnLoad` on every cold load is worse
 * than the row not existing.
 */
const UPSERT_TEMPLATES = `
INSERT INTO permission_policies (
  organization_id, policy_id, kind, cedar_json, cedar_text,
  description, annotations, enabled
)
SELECT
  r.organization_id,
  'role:' || r.id::text,
  'template',
  jsonb_build_object(
    'effect',     'permit',
    'principal',  jsonb_build_object('op', '==', 'slot', '?principal'),
    'action',     jsonb_build_object('op', 'in', 'entities', bundle.entities),
    'resource',   jsonb_build_object('op', 'in', 'slot', '?resource'),
    'conditions', '[]'::jsonb,
    'annotations', jsonb_build_object(
      'station_role_id',  r.id::text,
      'station_role_key', r.key
    )
  ),
  NULL,
  'Role bundle "' || r.key || '".',
  jsonb_build_object('station_role_id', r.id::text, 'station_role_key', r.key),
  true
FROM roles r
JOIN LATERAL (
  SELECT jsonb_agg(
           jsonb_build_object('type', 'Station::Action', 'id', p.key)
           ORDER BY p.key
         ) AS entities
  FROM role_permissions rp
  JOIN permissions p ON p.id = rp.permission_id
  WHERE rp.organization_id = r.organization_id
    AND rp.role_id = r.id
) bundle ON bundle.entities IS NOT NULL
WHERE r.organization_id = $1
ON CONFLICT (organization_id, policy_id) DO UPDATE
SET kind        = 'template',
    cedar_json  = EXCLUDED.cedar_json,
    description = EXCLUDED.description,
    annotations = EXCLUDED.annotations,
    enabled     = true,
    updated_at  = now()
WHERE permission_policies.cedar_json  IS DISTINCT FROM EXCLUDED.cedar_json
   OR permission_policies.description IS DISTINCT FROM EXCLUDED.description
   OR permission_policies.annotations IS DISTINCT FROM EXCLUDED.annotations
   OR permission_policies.enabled     IS DISTINCT FROM true
`;

/**
 * Remove templates whose Role is gone or whose bundle is now empty.
 *
 * `ON DELETE CASCADE` on `permission_policy_links_template_fk` takes the links
 * with them, which is correct: a Role with no Permissions grants nothing.
 *
 * Scoped to `policy_id LIKE 'role:%'` so a hand-written policy (there are none
 * today; there will be when a policy admin surface lands) is never collateral.
 */
const DELETE_EMPTY_OR_ORPHANED_TEMPLATES = `
DELETE FROM permission_policies pp
WHERE pp.organization_id = $1
  AND pp.policy_id LIKE 'role:%'
  AND NOT EXISTS (
    SELECT 1
    FROM roles r
    JOIN role_permissions rp
      ON rp.organization_id = r.organization_id AND rp.role_id = r.id
    WHERE r.organization_id = pp.organization_id
      AND 'role:' || r.id::text = pp.policy_id
  )
`;

/**
 * One link per grant whose Role has a template.
 *
 * `link_id` IS `role_grants.id` — that is what makes this idempotent and what
 * makes a revoke a delete by the same key. Slot values carry vocabulary-local
 * entity types; the engine namespace-qualifies them when it builds the policy
 * set, so `Member` here and `Station::Member` in Cedar are the same thing.
 */
const UPSERT_LINKS = `
INSERT INTO permission_policy_links (
  organization_id, link_id, template_id,
  principal_type, principal_id, resource_type, resource_id
)
SELECT
  g.organization_id,
  g.id,
  'role:' || g.role_id::text,
  'Member',
  g.member_id::text,
  CASE WHEN g.scope = 'project' THEN 'Project' ELSE 'Organization' END,
  CASE WHEN g.scope = 'project' THEN g.project_id::text ELSE g.organization_id::text END
FROM role_grants g
WHERE g.organization_id = $1
  AND EXISTS (
    SELECT 1 FROM permission_policies pp
    WHERE pp.organization_id = g.organization_id
      AND pp.policy_id = 'role:' || g.role_id::text
  )
ON CONFLICT (organization_id, link_id) DO UPDATE
SET template_id    = EXCLUDED.template_id,
    principal_type = EXCLUDED.principal_type,
    principal_id   = EXCLUDED.principal_id,
    resource_type  = EXCLUDED.resource_type,
    resource_id    = EXCLUDED.resource_id,
    updated_at     = now()
WHERE permission_policy_links.template_id    IS DISTINCT FROM EXCLUDED.template_id
   OR permission_policy_links.principal_id   IS DISTINCT FROM EXCLUDED.principal_id
   OR permission_policy_links.principal_type IS DISTINCT FROM EXCLUDED.principal_type
   OR permission_policy_links.resource_type  IS DISTINCT FROM EXCLUDED.resource_type
   OR permission_policy_links.resource_id    IS DISTINCT FROM EXCLUDED.resource_id
`;

/**
 * Remove links with no surviving grant.
 *
 * The composite FK already cascades, so this only ever fires for rows written
 * before the constraint existed — or in a deployment that chose not to create
 * it. Cheap, and it is the statement that makes the drift check's
 * "links ⊆ grants" half provable rather than assumed.
 */
const DELETE_ORPHANED_LINKS = `
DELETE FROM permission_policy_links l
WHERE l.organization_id = $1
  AND NOT EXISTS (
    SELECT 1 FROM role_grants g
    WHERE g.organization_id = l.organization_id AND g.id = l.link_id
  )
`;

const BUMP_VERSION = `
INSERT INTO permission_scope_versions (organization_id, version, updated_at)
VALUES ($1, 1, now())
ON CONFLICT (organization_id) DO UPDATE
SET version    = permission_scope_versions.version + 1,
    updated_at = now()
`;

// ---------------------------------------------------------------------------

async function listOrganizations(client) {
  if (explicitOrganizations.length > 0) {
    return explicitOrganizations;
  }

  const { rows } = await client.query(
    "SELECT id FROM organizations ORDER BY created_at, id",
  );

  if (rows.length === 0) {
    process.stderr.write(
      "No Organizations were readable on this connection.\n" +
        "`organizations` is FORCE ROW LEVEL SECURITY, so a non-superuser role reads\n" +
        "zero rows with no Organization context. Either connect as the operational\n" +
        "role that runs migrations, or pass the ids explicitly:\n" +
        "  pnpm authz:backfill --organization <uuid> --organization <uuid>\n",
    );
    process.exit(1);
  }

  return rows.map((row) => row.id);
}

async function backfillOrganization(client, organizationId) {
  await client.query("BEGIN");

  try {
    // Transaction-local, exactly like `withOrganizationContext`. Required when
    // the connecting role is subject to RLS; harmless when it is not.
    await client.query(
      "SELECT set_config('station.organization_id', ($1::uuid)::text, true)",
      [organizationId],
    );

    const templates = await client.query(UPSERT_TEMPLATES, [organizationId]);
    const removedTemplates = await client.query(
      DELETE_EMPTY_OR_ORPHANED_TEMPLATES,
      [organizationId],
    );
    const links = await client.query(UPSERT_LINKS, [organizationId]);
    const removedLinks = await client.query(DELETE_ORPHANED_LINKS, [
      organizationId,
    ]);

    const changed =
      templates.rowCount +
      removedTemplates.rowCount +
      links.rowCount +
      removedLinks.rowCount;

    // Only bump when something moved: an unconditional bump on every run would
    // make every replica reload every scope for nothing.
    if (changed > 0) {
      await client.query(BUMP_VERSION, [organizationId]);
    }

    if (dryRun) {
      await client.query("ROLLBACK");
    } else {
      await client.query("COMMIT");
    }

    return {
      organizationId,
      templates: templates.rowCount,
      removedTemplates: removedTemplates.rowCount,
      links: links.rowCount,
      removedLinks: removedLinks.rowCount,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

const client = new pg.Client({ connectionString: databaseUrl });
await client.connect();

let failed = false;

try {
  const organizationIds = await listOrganizations(client);
  const totals = {
    templates: 0,
    removedTemplates: 0,
    links: 0,
    removedLinks: 0,
  };

  for (const organizationId of organizationIds) {
    const result = await backfillOrganization(client, organizationId);

    totals.templates += result.templates;
    totals.removedTemplates += result.removedTemplates;
    totals.links += result.links;
    totals.removedLinks += result.removedLinks;

    process.stdout.write(
      `${organizationId}  templates +${result.templates}/-${result.removedTemplates}` +
        `  links +${result.links}/-${result.removedLinks}\n`,
    );
  }

  process.stdout.write(
    `\n${dryRun ? "[dry run] " : ""}${organizationIds.length} Organization(s): ` +
      `templates +${totals.templates}/-${totals.removedTemplates}, ` +
      `links +${totals.links}/-${totals.removedLinks}\n`,
  );
} catch (error) {
  failed = true;
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
} finally {
  await client.end();
}

process.exit(failed ? 1 : 0);
