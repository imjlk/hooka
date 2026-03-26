# Hooka

Hooka is a Bun workspace monorepo for webhook-driven automation. It keeps
`Task`, `Capability`, and `Preset` separate so the server, worker, CLI, admin
UI, and Docker image presets can evolve together without collapsing into one
giant tools image.

V1 is centered on one production path:

`WordPress webhook -> SQLite queue -> worker -> wrangler pages deploy`

## Workspace layout

```text
apps/
  cli/       Bunli-powered operations CLI
  server/    Bun API + static admin UI serving
  worker/    Task execution entrypoint
packages/
  contracts/ Shared Zod schemas
  task-sdk/  defineTask / defineCapability / definePreset
  registry/  Registry aggregation + preset planning
  runner-core/ Task validation + execution
  admin-ui/  Static dashboard bundle
  cap-*/     Capability contracts
  pack-*/    Task packs
presets/     Public image presets
docker/      Dockerfile, Bake file, feature installers, manifests
```

## Getting started

```bash
bun install
bun run build
```

Useful commands:

```bash
bun run apps/cli/src/index.ts task list
bun run apps/cli/src/index.ts capability list
bun run apps/cli/src/index.ts image plan --preset wp-wrangler
bun run apps/cli/src/index.ts task enqueue wordpress.deploy.simply-static --project staging-site
bun run apps/cli/src/index.ts run list
bun run dev:server
```

## Runtime model

- `apps/server` receives webhooks and enqueues runs into SQLite.
- `apps/worker` polls queued runs, executes tasks, and writes results/events back.
- Both services share the same `HOOKA_DB_PATH` and capability manifest.

Recommended defaults:

```bash
HOOKA_DB_PATH=/data/hooka.sqlite
HOOKA_WEBHOOK_SECRET=change-me
HOOKA_PORT=3000
HOOKA_POLL_INTERVAL_MS=2000
HOOKA_RUN_LEASE_MS=900000
```

## APIs

- `POST /api/runs` enqueues a task run.
- `POST /api/webhooks/wordpress/simply-static` verifies an HMAC-signed WordPress webhook and enqueues `wordpress.deploy.simply-static`.
- `GET /api/runs` returns recent runs.
- `GET /api/runs/:id` returns run detail and event history.

## Local flow

```bash
HOOKA_DB_PATH=/tmp/hooka.sqlite \
HOOKA_WEBHOOK_SECRET=local-secret \
bun run dev:server
```

```bash
HOOKA_DB_PATH=/tmp/hooka.sqlite \
bun run dev:worker
```

```bash
HOOKA_DB_PATH=/tmp/hooka.sqlite \
bun run apps/cli/src/index.ts task enqueue wordpress.deploy.simply-static --project staging-site
```
