---
npm/hooka: minor
---

Inspect, watch, and retry runs on a remote Hooka server with `run list/show/watch/retry --url`, admin token authentication, and bounded request timeouts. Authenticated remote connections require HTTPS unless `--allow-insecure-http` is explicitly set; local loopback HTTP remains supported. Filter run lists by status, task id, and source in both local SQLite and remote API modes.
