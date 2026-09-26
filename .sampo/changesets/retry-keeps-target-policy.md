---
npm/hooka: patch (Fixed)
---

Retrying a run from the admin UI, API, or `hooka run retry` now keeps the original target's policy snapshot, concurrency limit, and attempt budget, so a retried deploy can no longer skip target preflight checks or run alongside another deploy of the same target.
