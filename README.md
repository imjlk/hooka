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
docker/      Dockerfile, Bake file, feature installers, manifest examples
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
bun run dev:ui
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
- `.github/workflows/publish-images.yml` publishes `webhook-server` plus active worker presets to GHCR on `main` and via manual dispatch.

## Runtime model

- `apps/server` receives signed webhooks and enqueues runs into SQLite.
- `apps/worker` polls queued runs, reads the shared source volume, executes wrangler-backed tasks, and writes results/events back.
- Compatibility webhook adapters are discovered from registry metadata, so producer-specific alias routes stay outside the server core.
- The admin UI is split into small vanilla view modules and served by the server in production, or by Bun HMR in local development.
- Both server and worker register graceful shutdown handlers so Docker stop does not keep claiming new work during exit.
- `server` and `worker` share the same `HOOKA_DB_PATH`.
- Producers such as WordPress share an artifact/source volume with the `worker`, not the server.

Recommended container tags:

- `ghcr.io/imjlk/hooka:webhook-server`
- `ghcr.io/imjlk/hooka:core`
- `ghcr.io/imjlk/hooka:cf-pages`
- `ghcr.io/imjlk/hooka:cf-cache`
- `ghcr.io/imjlk/hooka:wp-ops`
- `ghcr.io/imjlk/hooka:wp-wrangler`

If the GitHub repository stays private, the GHCR package is private too. In that
case your deployment platform needs GHCR credentials before it can pull Hooka
images. If you want anonymous pulls, change the package visibility to public in
GitHub Packages after the first publish.

Recommended defaults:

```bash
HOOKA_DB_PATH=/data/hooka.sqlite
HOOKA_MANIFEST_PATH=/app/.hooka/installed-capabilities.json
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

Manifest resolution precedence:

1. `HOOKA_INSTALLED_CAPABILITIES` overrides file loading entirely.
2. Otherwise `HOOKA_MANIFEST_PATH` is used when set.
3. Otherwise Hooka reads a generated repo-local manifest at `.hooka/installed-capabilities.json`.

The tracked file under [`docker/manifests/installed-capabilities.example.json`](/Users/imjlk/repos/imjlk/hooka/docker/manifests/installed-capabilities.example.json) is now example-only and should not be used as a writable runtime target.

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
HOOKA_MANIFEST_PATH=$PWD/.hooka/installed-capabilities.json \
HOOKA_WEBHOOK_SECRET=local-secret \
HOOKA_INSTALLED_CAPABILITIES=wrangler \
bun run dev:server
```

```bash
HOOKA_DB_PATH=/tmp/hooka.sqlite \
HOOKA_MANIFEST_PATH=$PWD/.hooka/installed-capabilities.json \
HOOKA_INSTALLED_CAPABILITIES=wrangler \
CLOUDFLARE_API_TOKEN=local-token \
CLOUDFLARE_ACCOUNT_ID=local-account \
bun run dev:worker
```

```bash
HOOKA_UI_PORT=4310 \
HOOKA_UI_API_ORIGIN=http://127.0.0.1:3000 \
bun run dev:ui
```

```bash
mkdir -p /tmp/hooka-shared/simply-static "$PWD/.hooka"
bun run apps/cli/src/index.ts image install-features \
  --features wrangler \
  --manifest "$PWD/.hooka/installed-capabilities.json" \
  --image hooka:local
```

```bash
HOOKA_WEBHOOK_SECRET=local-secret \
bun run apps/cli/src/index.ts webhook test \
  --task-id deploy.shared-volume.wrangler \
  --payload-json '{"kind":"pages-deploy","project":"staging-site","sourcePath":"/tmp/hooka-shared/simply-static"}'
```

## Producer examples

Hooka's default model is `signed webhook -> queue -> worker -> wrangler CLI`. WordPress is documented as the first producer example only. In that setup, WordPress owns the export directory and the Hooka worker mounts the same volume at `/shared-source`. See [examples/wordpress-webhook/README.md](./examples/wordpress-webhook/README.md) for a signed generic webhook payload and PHP snippet that you can call after a Simply Static export zip is generated or after a local deploy completes.

## Role Tags

- `webhook-server` serves the webhook ingress, admin UI, and run APIs. It only needs `/data`, `HOOKA_WEBHOOK_SECRET`, and optionally `HOOKA_INSTALLED_CAPABILITIES` so the UI mirrors the paired worker role.
- `cf-pages` is the lean worker for `deploy.shared-volume.wrangler` and `cloudflare.pages.deploy`. It needs `/data`, `/shared-source`, `CLOUDFLARE_API_TOKEN`, and `CLOUDFLARE_ACCOUNT_ID`.
- `cf-cache` is the lean worker for `cloudflare.cache.purge.urls`. It needs `CLOUDFLARE_API_TOKEN`, and the task receives `zoneId` plus a URL list payload.
- `wp-ops` is the lean worker for `wordpress.wpcli.eval` and `wordpress.export.verify`.
- `wp-wrangler` is the combo worker that merges `wp-ops` and `cf-pages`.

`hooka doctor` now reports both missing capabilities and missing env required by the currently installed capabilities.

## Dev UI

- `bun run dev:ui` starts a Bun HMR server for the admin UI.
- Default UI port: `4310`
- Default proxied API origin: `http://127.0.0.1:3000`
- The dev server only serves the UI source entrypoint and proxies `/api/*` to the configured backend.
- `bun run test:dev-ui:smoke` verifies that `GET /` serves the shell and `/api/health` proxies correctly.

## Private GHCR Pulls

For private packages, log in before pulling:

```bash
echo "$GHCR_TOKEN" | docker login ghcr.io -u imjlk --password-stdin
docker pull ghcr.io/imjlk/hooka:webhook-server
docker pull ghcr.io/imjlk/hooka:cf-pages
```

The token needs `read:packages`. In Coolify or other deployment platforms,
configure the registry credentials first, then reference the same image tags
from the compose example.
