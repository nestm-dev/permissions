---
"@nestm/permissions": patch
---

Resolve public metadata by declaration level across every configured key so an explicit handler
marker cannot be masked by an earlier inherited marker, while handler authorization continues to
override inherited public declarations.
