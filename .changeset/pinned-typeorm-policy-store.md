---
"@nestm/permissions-typeorm": minor
---

Add a request-aware `TypeOrmPolicyStoreExecutor` seam. Foreground policy reads and writes now run on
one pinned `EntityManager`, declare their exact scopes, access mode, isolation level, and commit
ownership, and keep local watch events strictly post-commit. The default executor uses a dedicated
TypeORM `QueryRunner`; tenant/RLS integrations can supply their context-derived transaction runner.
