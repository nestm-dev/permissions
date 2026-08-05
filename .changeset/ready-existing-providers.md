---
"@nestm/permissions": patch
---

Wire `useExisting` and `useFactory.inject` through required Nest dependency edges supplied by static
`forRoot({ imports: [...] })` registrations. This prevents a provider with asynchronous constructor
dependencies from being captured as its prototype placeholder, while preserving Nest's native
initialization errors and cycle detection. Nested injected definitions from `forRootAsync()` now
fail with guidance to inject the ready instance into the outer options factory.
