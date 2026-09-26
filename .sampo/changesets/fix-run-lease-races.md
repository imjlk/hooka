---
npm/hooka: patch (Fixed)
---

Stop multiple workers from running the same job after a lease expires, renew run leases and worker heartbeats while tasks execute, ignore results from workers that lost their lease, settle runs whose post-claim bookkeeping throws, and serialize schema migrations when the server and worker start together.
