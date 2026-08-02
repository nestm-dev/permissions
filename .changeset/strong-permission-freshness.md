---
"@nestm/permissions-core": patch
"@nestm/permissions": patch
"@nestm/permissions-drizzle": minor
---

Prevent invalidations that race an in-flight policy load from being lost, and include the planned
resource type in entity-resolution requests. Wrap Nest entity-provider failures as structural
permissions errors so guard-time outages consistently map to the engine-unavailable response.

Replace Drizzle's timestamp-watermark invalidation poll with monotonic per-scope version comparison,
including out-of-order commit safety. Declare isolation level and commit-ownership requirements on
every executor call, and reject the default executor when it receives an ambient Drizzle transaction
whose savepoint cannot satisfy those guarantees. Newly generated schemas omit the now-unused
`scope_versions.updated_at` index; existing deployments may drop that index separately.
