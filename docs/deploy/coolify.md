# Deploying Hooka on Coolify

Hooka `1.0.0` supports a minimal Coolify deployment with two services:

- `hookaserver`
- `hookaworker`

This is the recommended setup for shared-volume Cloudflare Pages deploys.

## Operating model

- `hookaserver` receives signed webhooks and serves the admin/API surface
- `hookaworker` polls SQLite, reads `/shared-source`, and runs `wrangler`
- both services share `/data`
- the worker mounts `/shared-source`

## Required env

Server:

- `HOOKA_DB_PATH=/data/hooka.sqlite`
- `HOOKA_WEBHOOK_SECRET`
- `HOOKA_ADMIN_TOKEN`
- `HOOKA_TARGETS_PATH=/app/.hooka/targets.json`
- `HOOKA_PORT=3000`
- `HOOKA_TRUST_PROXY=true`

Worker:

- `HOOKA_DB_PATH=/data/hooka.sqlite`
- `HOOKA_WEBHOOK_SECRET`
- `HOOKA_TARGETS_PATH=/app/.hooka/targets.json`
- `HOOKA_POLL_INTERVAL_MS=2000`
- `HOOKA_RUN_LEASE_MS=900000`
- `HOOKA_RUN_MAX_ATTEMPTS=3`
- `HOOKA_RETRY_BASE_DELAY_MS=5000`
- `HOOKA_WORKER_HEARTBEAT_MS=10000`
- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

## Minimal stack

```yaml
services:
  hookaserver:
    image: ghcr.io/imjlk/hooka:1.0.0-webhook-server
    restart: unless-stopped
    environment:
      - SERVICE_URL_HOOKASERVER_3000
      - HOOKA_DB_PATH=/data/hooka.sqlite
      - HOOKA_WEBHOOK_SECRET=${HOOKA_WEBHOOK_SECRET:?}
      - HOOKA_ADMIN_TOKEN=${HOOKA_ADMIN_TOKEN:?}
      - HOOKA_TARGETS_PATH=/app/.hooka/targets.json
      - HOOKA_INSTALLED_CAPABILITIES=wrangler
      - HOOKA_PORT=3000
    volumes:
      - hooka-data:/data
      - ./.hooka:/app/.hooka

  hookaworker:
    image: ghcr.io/imjlk/hooka:1.0.0-cf-pages
    restart: unless-stopped
    environment:
      - HOOKA_DB_PATH=/data/hooka.sqlite
      - HOOKA_WEBHOOK_SECRET=${HOOKA_WEBHOOK_SECRET:?}
      - HOOKA_TARGETS_PATH=/app/.hooka/targets.json
      - HOOKA_POLL_INTERVAL_MS=2000
      - HOOKA_RUN_LEASE_MS=900000
      - HOOKA_RUN_MAX_ATTEMPTS=3
      - HOOKA_RETRY_BASE_DELAY_MS=5000
      - HOOKA_WORKER_HEARTBEAT_MS=10000
      - CLOUDFLARE_API_TOKEN=${CLOUDFLARE_API_TOKEN:?}
      - CLOUDFLARE_ACCOUNT_ID=${CLOUDFLARE_ACCOUNT_ID:?}
    volumes:
      - hooka-data:/data
      - ./.hooka:/app/.hooka
      - ./.hooka/shared-source:/shared-source

volumes:
  hooka-data:
```

## Webhook ingress

- webhook routes use HMAC signatures
- read/admin APIs use `Authorization: Bearer <HOOKA_ADMIN_TOKEN>`
- the admin UI shell is static, but it cannot read protected data without the admin token
- set `HOOKA_TRUST_PROXY=true` when Hooka is behind Coolify's public reverse proxy so rate limiting uses the forwarded client IP
- target scaffolds can be generated locally with `hooka target scaffold --template shared-volume-pages`
- audit events are available through the admin UI and `hooka audit list`

## Shared-volume deploys

For the common Pages case, targets should point to a worker-visible source path such as:

- `/shared-source/simply-static`

That source path should be constrained by the target policy in `.hooka/targets.json`.
