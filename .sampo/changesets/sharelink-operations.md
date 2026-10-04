---
npm/hooka: minor
---

Add offline Sharelink config validation, matching previews, sanitized operational status, bounded refresh planning and idempotent scheduler ticks. Coalesce active queue work across ticks with an additive SQLite column, renew product detail caches before expiry, and provide a fail-closed consumer reader. Cover signed webhooks, two app queues sharing product volumes, crash recovery and quota pause with an isolated Docker Compose E2E harness.
