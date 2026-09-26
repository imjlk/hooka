---
npm/hooka: patch (Security)
---

Locally built images no longer bake in `.env` files (Bun auto-loaded them at runtime). The `wp-ops` and `wp-wrangler` images now ship a working WP-CLI: it is pinned to 2.12.0, checked against its published SHA-512, and installed with the Phar, mysqli, mbstring, and OpenSSL extensions it needs (the `wp` binary previously failed with `Class "Phar" not found`). Wrangler is pinned to 4.141.0, and the local compose worker no longer receives the webhook secret and gets a stop grace period.
