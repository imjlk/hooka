# Hooka

Hooka is a Bun workspace monorepo for webhook-driven automation. It keeps
`Task`, `Capability`, and `Preset` separate so the server, worker, CLI, admin
UI, and Docker image presets can evolve together without collapsing into one
giant tools image.

Hooka follows a Bun-first style:

- prefer Bun APIs for process execution, sleep, file I/O, temp directories, and shell work
- keep `node:path` where path composition is clearer and more stable
- keep `node:crypto` for HMAC and constant-time signature checks

`1.0.0` keeps Hooka as a generic task runtime. The first producer example is WordPress, and the first showcase task is:

`signed webhook -> SQLite queue -> worker -> wrangler pages deploy`

Release docs:

- [Release notes](./docs/releases/1.0.0.md)
- [Upgrade guide](./docs/upgrade/v1.md)
- [Coolify deployment guide](./docs/deploy/coolify.md)

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
docker/      Dockerfile, Bake file, feature installers, manifest examples
```

## Getting started

```bash
bun install
cp .env.example .env
bun run build
```

Useful commands:

```bash
bun run apps/cli/src/index.ts init --yes --preset cf-pages
bun run apps/cli/src/index.ts dev
bun run apps/cli/src/index.ts status
bun run apps/cli/src/index.ts config
bun run apps/cli/src/index.ts target list
bun run apps/cli/src/index.ts target scaffold --template shared-volume-pages
bun run apps/cli/src/index.ts target create --file ./target.json
bun run apps/cli/src/index.ts target update cf-pages-default --file ./target.json
bun run apps/cli/src/index.ts target delete cf-pages-default --yes
bun run apps/cli/src/index.ts audit list
bun run apps/cli/src/index.ts task list
bun run apps/cli/src/index.ts capability list
bun run apps/cli/src/index.ts image plan --preset cf-pages
bun run apps/cli/src/index.ts image plan --preset wp-wrangler
bun run apps/cli/src/index.ts task enqueue deploy.shared-volume.wrangler --project staging-site --source-path /shared-source/simply-static
bun run apps/cli/src/index.ts run list
bun run apps/cli/src/index.ts run watch <run-id>
bun run apps/cli/src/index.ts run retry <run-id>
bun run bake:generate
bun run test:e2e:docker
bun run dev:server
bun run dev:ui
bun run test:watch
```

## Delivery Status

Hooka's Docker delivery base is already in place:

- `docker/Dockerfile` separates the shared `webhook-server` image from worker-only preset images.
- `packages/preset-catalog/src/index.ts` is the source of truth for active worker tags, legacy aliases, and build arguments.
- `scripts/generate-docker-bake.ts` regenerates `docker/docker-bake.hcl` from that catalog, so release targets are not hand-maintained.
- `bun run test:e2e:docker` proves the Docker path end to end with `webhook-server + cf-pages`.

GitHub Actions now cover both verification and GHCR publishing:

- `.github/workflows/ci.yml` runs bake regeneration, typecheck, tests, build, and Docker E2E on pull requests and `main`.
- The CI workflow also smoke-tests the Bun HMR admin UI and fails if the validation suite mutates tracked files.
- `.github/workflows/publish-images.yml` publishes mutable `webhook-server` plus active worker preset tags from `main`, and publishes immutable semver aliases from release tags such as `v1.0.0`.

## Runtime model

- `apps/server` receives signed webhooks and enqueues runs into SQLite.
- `apps/worker` polls queued runs, reads the shared source volume, executes wrangler-backed tasks, and writes results/events back.
- Compatibility webhook adapters are discovered from registry metadata, so producer-specific alias routes stay outside the server core.
- The admin UI is split into small vanilla view modules and served by the server in production, or by Bun HMR in local development.
- Both server and worker register graceful shutdown handlers so Docker stop does not keep claiming new work during exit.
- Runtime entrypoints now load typed env-backed defaults through `@hooka/config` instead of parsing env inline in each app.
- Long-running services emit structured JSON logs through `@hooka/logger` for startup, shutdown, readiness, and loop/runtime failures.
- Admin and read APIs are protected by `HOOKA_ADMIN_TOKEN`, while webhook ingress continues to use HMAC signatures.
- Target CRUD stays file-backed through `HOOKA_TARGETS_PATH`, but can now be managed through the admin API, CLI, and admin UI without hand-editing the JSON file.
- Built-in target scaffolds cover shared-volume Pages deploys, cache purge targets, export verification, and a generic skeleton.
- The worker applies retry backoff, dead-lettering, preflight validation, and heartbeat updates before and after task execution.
- Optional targets in `.hooka/targets.json` provide policy-backed execution paths for shared-volume deploys and other reusable flows.
- Audit events for auth failures, rate-limit rejections, policy rejections, and target mutations are stored in SQLite and surfaced in the admin UI and CLI.
- `server` and `worker` share the same `HOOKA_DB_PATH`.
- Producers such as WordPress share an artifact/source volume with the `worker`, not the server.

Recommended container tags:

- `ghcr.io/imjlk/hooka:webhook-server`
- `ghcr.io/imjlk/hooka:core`
- `ghcr.io/imjlk/hooka:cf-pages`
- `ghcr.io/imjlk/hooka:cf-cache`
- `ghcr.io/imjlk/hooka:wp-ops`
- `ghcr.io/imjlk/hooka:wp-wrangler`

Immutable release tags follow the same catalog, for example:

- `ghcr.io/imjlk/hooka:1.0.0-webhook-server`
- `ghcr.io/imjlk/hooka:1.0.0-cf-pages`
- `ghcr.io/imjlk/hooka:1.0.0-cf-cache`
- `ghcr.io/imjlk/hooka:1.0.0-wp-ops`
- `ghcr.io/imjlk/hooka:1.0.0-wp-wrangler`

`ghcr.io/imjlk/hooka` is currently published for public pull.

Recommended defaults:

```bash
HOOKA_DB_PATH=/data/hooka.sqlite
HOOKA_MANIFEST_PATH=/app/.hooka/installed-capabilities.json
HOOKA_TARGETS_PATH=/app/.hooka/targets.json
HOOKA_WEBHOOK_SECRET=change-me
HOOKA_ADMIN_TOKEN=change-me
HOOKA_PORT=3000
HOOKA_POLL_INTERVAL_MS=2000
HOOKA_RUN_LEASE_MS=900000
HOOKA_RUN_MAX_ATTEMPTS=3
HOOKA_RETRY_BASE_DELAY_MS=5000
HOOKA_WORKER_HEARTBEAT_MS=10000
HOOKA_TRUST_PROXY=false
HOOKA_RATE_LIMIT_WINDOW_MS=60000
HOOKA_RATE_LIMIT_API_LIMIT=120
HOOKA_RATE_LIMIT_WEBHOOK_LIMIT=60
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

Manifest resolution precedence:

1. `HOOKA_INSTALLED_CAPABILITIES` overrides file loading entirely.
2. Otherwise `HOOKA_MANIFEST_PATH` is used when set.
3. Otherwise Hooka reads a generated repo-local manifest at `.hooka/installed-capabilities.json`.

The tracked file under [`docker/manifests/installed-capabilities.example.json`](/Users/imjlk/repos/imjlk/hooka/docker/manifests/installed-capabilities.example.json) is now example-only and should not be used as a writable runtime target.

Targets resolve from `.hooka/targets.json` by default, or from `HOOKA_TARGETS_PATH` when set.

Built-in target scaffold templates:

- `shared-volume-pages`
- `cache-purge-urls`
- `export-verify`
- `generic`

## Preset Catalog

Active registry-backed worker presets:

- `core` — minimal worker runtime with no extra task toolchains
- `cf-pages` — shared-volume and direct-upload Cloudflare Pages deploys
- `cf-cache` — safe URL-based Cloudflare cache purge worker
- `wp-ops` — `wp-cli` evaluation and export verification
- `wp-wrangler` — `wp-ops` plus `cf-pages`

Migration aliases:

- `cf-wrangler` -> `cf-pages`
- `wrangler-worker` -> `cf-pages`
- `webhook-wrangler` -> `wp-wrangler`

Planned presets are documented but not published in registry APIs or GHCR release targets yet:

- Lean: `http`, `coolify-deploy`, `wp-content-export`, `wp-backup-db`, `rclone-sync`
- Combo: `wp-cache-safe`, `wp-backup-rclone`, `wp-migrate`, `site-bun-build-cf-pages`, `cf-r2-publisher`, `cf-images`, `smoke-http`, `site-bun-build-coolify`, `wp-multisite`, `git-mirror`, `notify`

## APIs

- `GET /api/health` returns a lightweight liveness response for the server role.
- `GET /api/ready` returns readiness for deployment platforms and fails when the SQLite store is not ready.
- `POST /api/runs` enqueues a task run. This route requires the admin bearer token.
- `POST /api/runs/:id/retry` retries a terminal run by enqueueing a new run.
- `POST /api/webhooks/task` verifies an HMAC-signed generic or target-based webhook and enqueues any registered task.
- `POST /api/webhooks/wordpress/simply-static` remains as a compatibility alias for the first producer example.
- `GET /api/runs` returns recent runs.
- `GET /api/runs/:id` returns run detail and event history.
- `GET /api/targets` and `GET /api/targets/:id` expose configured targets.
- `POST /api/targets`, `PUT /api/targets/:id`, and `DELETE /api/targets/:id` manage file-backed targets.
- `GET /api/audit-events` exposes recent security, policy, and target mutation events.
- `GET /api/events/stream` emits SSE updates for run events and worker heartbeats.
- All admin/read APIs except `/api/health` and `/api/ready` require `Authorization: Bearer <HOOKA_ADMIN_TOKEN>`.
- API routes are protected by in-memory rate limiting by default.
- `HOOKA_TRUST_PROXY=true` should only be enabled when Hooka is behind a trusted reverse proxy that sets `X-Forwarded-For`.

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

Target-based webhook body:

```json
{
  "targetId": "cf-pages-default",
  "overrides": {
    "branch": "main"
  },
  "eventId": "evt_002",
  "source": "deployment.system"
}
```

## Local flow

```bash
cp .env.example .env
bun run apps/cli/src/index.ts init --yes --preset cf-pages
```

```bash
bun run apps/cli/src/index.ts dev
```

```bash
bun run apps/cli/src/index.ts status
```

```bash
bun run apps/cli/src/index.ts target list
```

```bash
HOOKA_WEBHOOK_SECRET=local-secret \
bun run apps/cli/src/index.ts webhook test \
  --task-id deploy.shared-volume.wrangler \
  --payload-json '{"kind":"pages-deploy","project":"staging-site","sourcePath":".hooka/shared-source/simply-static"}'
```

Hooka uses Bun's built-in `.env` loading, so the default local flow is to copy
`.env.example` once and then use the CLI commands above without repeating long
inline env prefixes.

## Producer examples

Hooka's default model is `signed webhook -> queue -> worker -> wrangler CLI`. WordPress is documented as the first producer example only. In that setup, WordPress owns the export directory and the Hooka worker mounts the same volume at `/shared-source`. See [examples/wordpress-webhook/README.md](./examples/wordpress-webhook/README.md) for a signed generic webhook payload and PHP snippet that you can call after a Simply Static export zip is generated or after a local deploy completes.

## Role Tags

- `webhook-server` serves the webhook ingress, admin UI, and run APIs. It only needs `/data`, `HOOKA_WEBHOOK_SECRET`, and optionally `HOOKA_INSTALLED_CAPABILITIES` so the UI mirrors the paired worker role.
- `cf-pages` is the lean worker for `deploy.shared-volume.wrangler` and `cloudflare.pages.deploy`. It needs `/data`, `/shared-source`, `CLOUDFLARE_API_TOKEN`, and `CLOUDFLARE_ACCOUNT_ID`.
- `cf-cache` is the lean worker for `cloudflare.cache.purge.urls`. It needs `CLOUDFLARE_API_TOKEN`, and the task receives `zoneId` plus a URL list payload.
- `wp-ops` is the lean worker for `wordpress.wpcli.eval` and `wordpress.export.verify`.
- `wp-wrangler` is the combo worker that merges `wp-ops` and `cf-pages`.

`hooka doctor` now reports both missing capabilities and missing env required by the currently installed capabilities.

## Retry and DLQ

- Hooka retries retryable failures with exponential backoff.
- Non-retryable validation, policy, and auth failures stay terminal.
- Retryable failures that exceed `maxAttempts` become `dead-lettered`.
- Lease-expired runs also consume retry budget and can end up dead-lettered.

## Dev UI

- `bun run dev:ui` starts a Bun HMR server for the admin UI.
- `bun run apps/cli/src/index.ts dev` starts `server + worker + ui` together by default.
- Default UI port: `4310`
- Default proxied API origin: `http://127.0.0.1:3000`
- The dev server only serves the UI source entrypoint and proxies `/api/*` to the configured backend.
- `bun run test:dev-ui:smoke` verifies that `GET /` serves the shell and `/api/health` proxies correctly.

## Local Docker Compose

- `docker-compose.yml` is the local container smoke path.
- It builds repo-local images from `docker/Dockerfile` instead of pulling GHCR tags.
- It reads values from `.env`, keeps the SQLite path under `/data`, mounts `./.hooka` at `/app/.hooka` for manifests and targets, and bind-mounts `./.hooka/shared-source` to `/shared-source`.

```bash
docker compose up --build
```

## Private GHCR Pulls

If you ever move the package back to private, log in before pulling:

```bash
echo "$GHCR_TOKEN" | docker login ghcr.io -u imjlk --password-stdin
docker pull ghcr.io/imjlk/hooka:webhook-server
docker pull ghcr.io/imjlk/hooka:cf-pages
```

The token needs `read:packages`. In Coolify or other deployment platforms,
configure the registry credentials first, then reference the same image tags
from the compose example.
