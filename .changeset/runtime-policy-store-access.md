---
"@nestm/permissions-typeorm": patch
---

Export `TypeOrmPolicyStoreAccess` as a runtime constant so request-aware executors can compare
access requirements without duplicating the policy store's string literals.
