---
"@nestm/permissions": patch
---

Pass the resolved route context as a second argument to the module-level
`contextBuilder`, allowing one builder to select action-specific Cedar context
attributes without per-route overrides.
