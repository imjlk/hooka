---
npm/hooka: patch (Security)
---

Rate limits and audit rows now use the connecting socket address, or the proxy-written end of `X-Forwarded-For` when `HOOKA_TRUST_PROXY` is set, instead of the forgeable left-most entry. `HOOKA_TRUST_PROXY` also accepts the number of trusted proxies (for example `2` behind Cloudflare and Coolify). Per-client limits no longer include the caller-chosen User-Agent, a client over its own limit no longer spends the shared global budget, and repeated security rejections from one client are audited once per window, so an unauthenticated flood cannot lock out legitimate callers or fill the database.
