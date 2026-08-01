// ===========================================================================
// COPY-IN DESTINATION: packages/database/scripts/assert-authz-projection.mjs
//
// Root package.json runner (see backfill-authz-projection.mjs for why it is not
// at `scripts/`):
//
//   "authz:drift": "pnpm --filter=@station/database exec node scripts/assert-authz-projection.mjs",
//
// And in the root `check` script, next to `dependencies:check`, once S4 has
// landed — this is the CI tripwire that keeps `role_grants` and its Cedar
// projection in step.
// ===========================================================================
//
// Exit 0 when the projection is exact. Exit 1 with a per-Organization report of
// every discrepancy otherwise.
//
// SIX INVARIANTS, and the direction of each one matters:
//
//   1. MISSING LINK      a grant with no link. **Dangerous**: the Member holds
//                        the grant under the legacy engine and nothing under
//                        Cedar — a silent under-grant during shadow, a broken
//                        user after cutover.
//   2. EXTRA LINK        a link with no grant. **Dangerous the other way**:
//                        Cedar grants what `role_grants` says was revoked. The
//                        composite `ON DELETE CASCADE` FK is supposed to make
//                        this impossible; if it ever appears, the FK is gone.
//   3. WRONG LINK        a link whose template/principal/resource disagrees
//                        with its grant. Either direction, depending on the
//                        field.
//   4. MISSING TEMPLATE  a Role with a non-empty bundle and no template. Every
//                        grant of that Role is inert under Cedar.
//   5. EXTRA TEMPLATE    a `role:%` policy whose Role is gone or whose bundle
//                        is now empty. Inert (no links can reference it once
//                        the Role's grants cascade away) but still drift.
//   6. STALE TEMPLATE    a template whose `action.entities` no longer equals
//                        the Role's current `role_permissions`. **Dangerous
//                        both ways**: a Permission added to a Role is not
//                        granted, one removed is still granted.
//
// Invariant 6 is the one the design did not have. It exists because
// `role_permissions` can be written outside `createRoleGrant` — the seeds do
// it, and `authorization.blackbox.test.ts:136-165` does it — so "the template
// was written once when the Role was created" is not the same statement as
// "the template is correct now".

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
const explicitOrganizations = argv.flatMap((value, index) =>
  argv[index - 1] === "--organization" ? [value] : [],
);

/**
 * The expected link for every grant, and the actual link for every link, in one
 * FULL OUTER JOIN. A row survives only when the two disagree.
 */
const LINK_DRIFT = `
WITH expected AS (
  SELECT
    g.id AS link_id,
    'role:' || g.role_id::text AS template_id,
    'Member'::text AS principal_type,
    g.member_id::text AS principal_id,
    (CASE WHEN g.scope = 'project' THEN 'Project' ELSE 'Organization' END)::text
      AS resource_type,
    (CASE WHEN g.scope = 'project' THEN g.project_id::text
          ELSE g.organization_id::text END) AS resource_id,
    EXISTS (
      SELECT 1 FROM permission_policies pp
      WHERE pp.organization_id = g.organization_id
        AND pp.policy_id = 'role:' || g.role_id::text
    ) AS templated
  FROM role_grants g
  WHERE g.organization_id = $1
),
actual AS (
  SELECT link_id, template_id, principal_type, principal_id,
         resource_type, resource_id
  FROM permission_policy_links
  WHERE organization_id = $1
)
SELECT
  coalesce(expected.link_id, actual.link_id) AS link_id,
  CASE
    WHEN actual.link_id IS NULL AND expected.templated THEN 'missing-link'
    WHEN actual.link_id IS NULL AND NOT expected.templated THEN 'missing-template-for-grant'
    WHEN expected.link_id IS NULL THEN 'extra-link'
    ELSE 'wrong-link'
  END AS problem,
  expected.template_id    AS expected_template_id,
  actual.template_id      AS actual_template_id,
  expected.principal_id   AS expected_principal_id,
  actual.principal_id     AS actual_principal_id,
  expected.resource_type  AS expected_resource_type,
  actual.resource_type    AS actual_resource_type,
  expected.resource_id    AS expected_resource_id,
  actual.resource_id      AS actual_resource_id
FROM expected
FULL OUTER JOIN actual ON actual.link_id = expected.link_id
WHERE expected.link_id IS NULL
   OR actual.link_id IS NULL
   OR expected.template_id    IS DISTINCT FROM actual.template_id
   OR expected.principal_type IS DISTINCT FROM actual.principal_type
   OR expected.principal_id   IS DISTINCT FROM actual.principal_id
   OR expected.resource_type  IS DISTINCT FROM actual.resource_type
   OR expected.resource_id    IS DISTINCT FROM actual.resource_id
ORDER BY 1
`;

/**
 * Same shape for templates. `cedar_json` is compared by `jsonb` equality, which
 * is key-order independent — the only thing that must match is the content,
 * including the `ORDER BY p.key` inside `action.entities`, because a reordered
 * array is a different `jsonb` value.
 */
const TEMPLATE_DRIFT = `
WITH expected AS (
  SELECT
    'role:' || r.id::text AS policy_id,
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
    ) AS cedar_json
  FROM roles r
  JOIN LATERAL (
    SELECT jsonb_agg(
             jsonb_build_object('type', 'Station::Action', 'id', p.key)
             ORDER BY p.key
           ) AS entities
    FROM role_permissions rp
    JOIN permissions p ON p.id = rp.permission_id
    WHERE rp.organization_id = r.organization_id AND rp.role_id = r.id
  ) bundle ON bundle.entities IS NOT NULL
  WHERE r.organization_id = $1
),
actual AS (
  SELECT policy_id, cedar_json, kind, enabled
  FROM permission_policies
  WHERE organization_id = $1 AND policy_id LIKE 'role:%'
)
SELECT
  coalesce(expected.policy_id, actual.policy_id) AS policy_id,
  CASE
    WHEN actual.policy_id IS NULL THEN 'missing-template'
    WHEN expected.policy_id IS NULL THEN 'extra-template'
    WHEN actual.kind <> 'template' THEN 'not-a-template'
    WHEN NOT actual.enabled THEN 'template-disabled'
    ELSE 'stale-template'
  END AS problem,
  expected.cedar_json -> 'action' -> 'entities' AS expected_actions,
  actual.cedar_json   -> 'action' -> 'entities' AS actual_actions
FROM expected
FULL OUTER JOIN actual ON actual.policy_id = expected.policy_id
WHERE expected.policy_id IS NULL
   OR actual.policy_id IS NULL
   OR actual.kind <> 'template'
   OR NOT actual.enabled
   OR expected.cedar_json IS DISTINCT FROM actual.cedar_json
ORDER BY 1
`;

async function listOrganizations(client) {
  if (explicitOrganizations.length > 0) {
    return explicitOrganizations;
  }

  const { rows } = await client.query(
    "SELECT id FROM organizations ORDER BY created_at, id",
  );

  if (rows.length === 0) {
    process.stderr.write(
      "No Organizations were readable on this connection; see\n" +
        "backfill-authz-projection.mjs for the FORCE RLS explanation.\n",
    );
    process.exit(1);
  }

  return rows.map((row) => row.id);
}

const client = new pg.Client({ connectionString: databaseUrl });
await client.connect();

let drift = 0;

try {
  for (const organizationId of await listOrganizations(client)) {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('station.organization_id', ($1::uuid)::text, true)",
      [organizationId],
    );

    const links = await client.query(LINK_DRIFT, [organizationId]);
    const templates = await client.query(TEMPLATE_DRIFT, [organizationId]);

    // Read-only: a drift check that can write is a drift check nobody trusts in
    // CI.
    await client.query("ROLLBACK");

    for (const row of templates.rows) {
      drift += 1;
      process.stderr.write(
        `${organizationId}  ${row.problem}  ${row.policy_id}\n` +
          `    expected actions: ${JSON.stringify(row.expected_actions)}\n` +
          `    actual actions:   ${JSON.stringify(row.actual_actions)}\n`,
      );
    }

    for (const row of links.rows) {
      drift += 1;
      process.stderr.write(
        `${organizationId}  ${row.problem}  link ${row.link_id}\n` +
          `    template  expected ${row.expected_template_id} / actual ${row.actual_template_id}\n` +
          `    principal expected ${row.expected_principal_id} / actual ${row.actual_principal_id}\n` +
          `    resource  expected ${row.expected_resource_type}::${row.expected_resource_id}` +
          ` / actual ${row.actual_resource_type}::${row.actual_resource_id}\n`,
      );
    }
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  await client.end();
  process.exit(1);
}

await client.end();

if (drift > 0) {
  process.stderr.write(
    `\n${drift} authorization projection discrepancies.\n` +
      "`role_grants` is the source of truth; `pnpm authz:backfill` reconciles.\n" +
      "A non-zero count after a backfill means a write path is missing its\n" +
      "projection — find it before cutover, not after.\n",
  );
  process.exit(1);
}

process.stdout.write("Authorization projection is exact.\n");
