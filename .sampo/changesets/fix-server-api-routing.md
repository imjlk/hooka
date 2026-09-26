---
npm/hooka: patch (Fixed)
---

Unknown `/api/*` routes now return JSON `404`/`405` instead of the admin UI shell (a mistyped webhook URL used to look like a successful delivery), `HEAD` works for every `GET` route, server-side faults such as a corrupt `targets.json` return a logged `500` instead of a `400` that stopped producers from retrying, URL target ids are percent-decoded, idle SSE streams send keepalives instead of disconnecting every 30 seconds, and the OpenAPI document lists every compatibility webhook route.
