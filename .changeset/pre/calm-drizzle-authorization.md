---
"@nestm/permissions-core": patch
"@nestm/permissions": patch
"@nestm/permissions-drizzle": patch
---

Make Drizzle policy reads and writes composable with request-aware RLS executors, including
repeatable-read bundle snapshots and post-commit invalidation. Preserve custom scope-column builder
types on the generated Drizzle tables so tenant/RLS helpers can consume them without casts.
Re-resolve handler-side authorization entities when providers are available, expose options on
`can`, recognize permissions errors across package copies, and report guard-time operational
failures as engine-unavailable responses. Await delayed sibling providers used by `useExisting` or
`useFactory.inject` before constructing the authorization engine.
