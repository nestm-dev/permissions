---
"@nestm/permissions-typeorm": minor
---

Standardize `TypeOrmPolicyStoreIsolationLevel` on native uppercase TypeORM isolation values. Keep
the existing member names through a same-name constant and derived union type, allowing custom
executors to pass `execution.isolationLevel` directly to TypeORM without a translation map.
