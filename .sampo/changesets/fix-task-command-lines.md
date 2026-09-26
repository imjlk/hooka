---
npm/hooka: patch (Fixed)
---

Fix `wordpress.wpcli.eval`, which always failed because WP-CLI rejects `--path <value>`; keep wrangler option values attached so commit messages that start with `-` no longer break or rewrite deploys; reject dash-prefixed task paths and malformed Cloudflare zone ids; accept webhook `triggeredAt` timestamps with UTC offsets; and let target webhooks fall back to the target's `source`.
