# Security Policy

## Supported versions

Until the first stable release, security fixes are made against the latest published prerelease.
All four packages (`@nestm/permissions-core`, `@nestm/permissions`, `@nestm/permissions-typeorm`,
`@nestm/permissions-drizzle`) are versioned in lockstep, so a fix ships as one coordinated release.
Users should upgrade to the newest available version and pin the exact versions they have tested
with their NestJS 12 prerelease.

After stable releases begin, this policy will be updated with an explicit support table.

## Reporting a vulnerability

Please do not disclose a suspected vulnerability in a public issue, discussion, or pull request.

Use the repository's private **Report a vulnerability** flow when it is available:

<https://github.com/nestm-dev/permissions/security/advisories/new>

If private vulnerability reporting is not available, contact a repository maintainer through a
private channel listed on their GitHub profile before sending sensitive details.

Include:

- the affected package versions, NestJS version, and Cedar (`@cedar-policy/cedar-wasm`) version;
- a minimal reproduction or proof of concept — for an authorization bug, the policy set, schema,
  entities and the request that decided the wrong way;
- the expected and observed decision or generated SQL;
- the likely impact; and
- any mitigation you have already tested.

Please allow time for investigation and a coordinated release before public disclosure. Response
times may vary while the project is in prerelease.

## Scope

This project decides whether a request is allowed and which rows a query may return. Reports about
any of the following are especially useful:

- a decision that allows what the policy set forbids, or a guard that can be bypassed
  (undeclared route, unready policy store, resolver error) instead of failing closed;
- a dropped or silently errored `forbid` policy;
- a query plan compiled into SQL that returns rows the equivalent `check()` would deny —
  including through `NULL` three-valued logic, a case-insensitive collation, or `LIKE`
  pattern handling;
- SQL injection through a plan value, a `LIKE` pattern, or an identifier in a mapping;
- unintended cross-tenant access through policy-set scoping or a stale entity/policy cache;
- information disclosure through a denial response that distinguishes "does not exist" from
  "exists but is forbidden" where the design promises they are indistinguishable; and
- dependency compromise.

For vulnerabilities in NestJS, Cedar, TypeORM, Drizzle, or another dependency that do not
originate in these packages, follow that project's security policy. You may still notify this
project privately when an upstream issue requires a compatibility fix or mitigation here.
