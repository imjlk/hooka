# Hooka

Hooka is a Bun workspace monorepo for webhook-driven automation. It keeps
`Task`, `Capability`, and `Preset` separate so the server, worker, CLI, admin
UI, and Docker image presets can evolve together without collapsing into one
giant tools image.

Hooka follows a Bun-first style:

- prefer Bun APIs for process execution, sleep, file I/O, temp directories, and shell work
- keep `node:path` where path composition is clearer and more stable
- keep `node:crypto` for HMAC and constant-time signature checks

V1.1 keeps Hooka as a generic task runtime. The first producer example is WordPress, and the first showcase task is:

`signed webhook -> SQLite queue -> worker -> wrangler pages deploy`

## Workspace layout

```text
apps/
  cli/       Bunli-powered operations CLI
  server/    Bun API + static admin UI serving
  worker/    Task execution entrypoint
packages/
  contracts/ Shared Zod schemas
  preset-catalog/ Active + planned preset taxonomy
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
bun run apps/cli/src/index.ts image plan --preset cf-pages
bun run apps/cli/src/index.ts image plan --preset wp-wrangler
bun run apps/cli/src/index.ts task enqueue deploy.shared-volume.wrangler --project staging-site --source-path /shared-source/simply-static
bun run apps/cli/src/index.ts run list
bun run bake:generate
bun run test:e2e:docker
bun run dev:server
```

## Runtime model

- `apps/server` receives signed webhooks and enqueues runs into SQLite.
- `apps/worker` polls queued runs, reads the shared source volume, executes wrangler-backed tasks, and writes results/events back.
- `server` and `worker` share the same `HOOKA_DB_PATH`.
- Producers such as WordPress share an artifact/source volume with the `worker`, not the server.

Recommended container tags:

- `ghcr.io/imjlk/hooka:webhook-server`
- `ghcr.io/imjlk/hooka:core`
- `ghcr.io/imjlk/hooka:cf-pages`
- `ghcr.io/imjlk/hooka:wp-ops`
- `ghcr.io/imjlk/hooka:wp-wrangler`

Recommended defaults:

```bash
HOOKA_DB_PATH=/data/hooka.sqlite
HOOKA_WEBHOOK_SECRET=change-me
HOOKA_PORT=3000
HOOKA_POLL_INTERVAL_MS=2000
HOOKA_RUN_LEASE_MS=900000
```

Recommended shared source mount:

```bash
/shared-source
```

Optional runtime capability override:

```bash
HOOKA_INSTALLED_CAPABILITIES=wrangler
```

Set that on the webhook server when you want the admin UI and queued run snapshots to reflect the paired worker role instead of the server image itself.

## Preset Catalog

Active registry-backed worker presets:

- `core` — minimal worker runtime with no extra task toolchains
- `cf-pages` — shared-volume and direct-upload Cloudflare Pages deploys
- `wp-ops` — `wp-cli` evaluation and export verification
- `wp-wrangler` — `wp-ops` plus `cf-pages`

Migration aliases:

- `cf-wrangler` -> `cf-pages`
- `wrangler-worker` -> `cf-pages`
- `webhook-wrangler` -> `wp-wrangler`

Planned presets are documented but not published in registry APIs or GHCR release targets yet:

- Lean: `http`, `coolify-deploy`, `cf-cache`, `wp-content-export`, `wp-backup-db`, `rclone-sync`
- Combo: `wp-cache-safe`, `wp-backup-rclone`, `wp-migrate`, `site-bun-build-cf-pages`, `cf-r2-publisher`, `cf-images`, `smoke-http`, `site-bun-build-coolify`, `wp-multisite`, `git-mirror`, `notify`

## APIs

- `POST /api/runs` enqueues a task run.
- `POST /api/webhooks/task` verifies an HMAC-signed generic webhook and enqueues any registered task.
- `POST /api/webhooks/wordpress/simply-static` remains as a compatibility alias for the first producer example.
- `GET /api/runs` returns recent runs.
- `GET /api/runs/:id` returns run detail and event history.

Generic webhook body:

```json
{
  "taskId": "deploy.shared-volume.wrangler",
  "input": {
    "kind": "pages-deploy",
    "project": "staging-site",
    "sourcePath": "/shared-source/simply-static"
  },
  "eventId": "evt_001",
  "source": "wordpress.webhook"
}
```

## Local flow

```bash
HOOKA_DB_PATH=/tmp/hooka.sqlite \
HOOKA_WEBHOOK_SECRET=local-secret \
HOOKA_INSTALLED_CAPABILITIES=wrangler \
bun run dev:server
```

```bash
HOOKA_DB_PATH=/tmp/hooka.sqlite \
HOOKA_INSTALLED_CAPABILITIES=wrangler \
CLOUDFLARE_API_TOKEN=local-token \
CLOUDFLARE_ACCOUNT_ID=local-account \
bun run dev:worker
```

```bash
mkdir -p /tmp/hooka-shared/simply-static
HOOKA_DB_PATH=/tmp/hooka.sqlite \
bun run apps/cli/src/index.ts task enqueue deploy.shared-volume.wrangler \
  --project staging-site \
  --source-path /tmp/hooka-shared/simply-static
```

## Producer examples

Hooka's default model is `signed webhook -> queue -> worker -> wrangler CLI`. WordPress is documented as the first producer example only. In that setup, WordPress owns the export directory and the Hooka worker mounts the same volume at `/shared-source`. See [examples/wordpress-webhook/README.md](./examples/wordpress-webhook/README.md) for a signed generic webhook payload and PHP snippet that you can call after a Simply Static export zip is generated or after a local deploy completes.

## Role Tags

- `webhook-server` serves the webhook ingress, admin UI, and run APIs. It only needs `/data`, `HOOKA_WEBHOOK_SECRET`, and optionally `HOOKA_INSTALLED_CAPABILITIES` so the UI mirrors the paired worker role.
- `cf-pages` is the lean worker for `deploy.shared-volume.wrangler` and `cloudflare.pages.deploy`. It needs `/data`, `/shared-source`, `CLOUDFLARE_API_TOKEN`, and `CLOUDFLARE_ACCOUNT_ID`.
- `wp-ops` is the lean worker for `wordpress.wpcli.eval` and `wordpress.export.verify`.
- `wp-wrangler` is the combo worker that merges `wp-ops` and `cf-pages`.

`hooka doctor` now reports both missing capabilities and missing env required by the currently installed capabilities.
