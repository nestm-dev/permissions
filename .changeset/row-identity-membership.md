---
"@nestm/permissions-core": patch
"@nestm/permissions-drizzle": patch
"@nestm/permissions-typeorm": patch
---

Compile Cedar entity-set membership over the planned resource identity. Policies such as
`principal.allowedResources.contains(resource)` now produce an exact primary-key `IN` plan,
including a constant-deny plan for empty sets, with matching TypeORM, Drizzle, and reference
interpreter behavior.
