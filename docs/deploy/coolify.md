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
- `HOOKA_CORS_ORIGINS=` when the admin UI and API stay on the same origin
- `HOOKA_MAX_BODY_BYTES=1048576`

Worker:

- `HOOKA_DB_PATH=/data/hooka.sqlite`
- `HOOKA_WEBHOOK_SECRET`
- `HOOKA_TARGETS_PATH=/app/.hooka/targets.json`
- `HOOKA_POLL_INTERVAL_MS=2000`
- `HOOKA_RUN_LEASE_MS=900000`
- `HOOKA_RUN_MAX_ATTEMPTS=3`
- `HOOKA_RETRY_BASE_DELAY_MS=5000`
- `HOOKA_WORKER_HEARTBEAT_MS=10000`
- `HOOKA_RETENTION_RUN_DAYS=30`
- `HOOKA_RETENTION_AUDIT_DAYS=90`
- `HOOKA_RETENTION_SWEEP_INTERVAL_HOURS=24`
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
    healthcheck:
      test:
        - CMD
        - bun
        - -e
        - const response = await fetch('http://127.0.0.1:3000/api/health'); if (!response.ok) process.exit(1);
      interval: 30s
      timeout: 5s
      start_period: 10s
      retries: 3

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
- the admin UI now gets a short-lived SSE ticket from `POST /api/events/ticket` before connecting to `/api/events/stream`
- set `HOOKA_TRUST_PROXY=true` when Hooka is behind Coolify's public reverse proxy so rate limiting uses the forwarded client IP
- leave `HOOKA_CORS_ORIGINS` empty unless the admin UI is intentionally hosted on a different origin
- target scaffolds can be generated locally with `hooka target scaffold --template shared-volume-pages`
- audit events are available through the admin UI and `hooka audit list`

## Shared-volume deploys

For the common Pages case, targets should point to a worker-visible source path such as:

- `/shared-source/simply-static`

That source path should be constrained by the target policy in `.hooka/targets.json`.
