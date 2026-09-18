---
name: API client typecheck compatibility
description: Generated browser client relies on iterable DOM collection types during workspace declaration builds.
---

The shared generated API client uses `Headers.entries()`, so its TypeScript library configuration must include both `dom` and `dom.iterable`.

**Why:** The generated client can be valid at runtime but fail the workspace composite typecheck when `dom.iterable` is omitted.

**How to apply:** Preserve `dom.iterable` in the API client library compiler options when regenerating OpenAPI output.