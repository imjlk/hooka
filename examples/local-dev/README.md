# Local development

```bash
bun install
bun run build
```

Start the API server:

```bash
HOOKA_DB_PATH=/tmp/hooka.sqlite \
HOOKA_WEBHOOK_SECRET=local-secret \
HOOKA_INSTALLED_CAPABILITIES=wrangler \
bun run dev:server
```

Start the worker in another shell:

```bash
HOOKA_DB_PATH=/tmp/hooka.sqlite \
HOOKA_INSTALLED_CAPABILITIES=wrangler \
CLOUDFLARE_API_TOKEN=local-token \
CLOUDFLARE_ACCOUNT_ID=local-account \
bun run dev:worker
```

Queue a run locally:

```bash
mkdir -p /tmp/hooka-shared/simply-static
HOOKA_DB_PATH=/tmp/hooka.sqlite \
bun run apps/cli/src/index.ts task enqueue deploy.shared-volume.wrangler \
  --project staging-site \
  --source-path /tmp/hooka-shared/simply-static
```

Inspect recent runs:

```bash
HOOKA_DB_PATH=/tmp/hooka.sqlite \
bun run apps/cli/src/index.ts run list
```

If you want your local setup to mirror the lean worker taxonomy, treat this flow as the local equivalent of pairing `hooka:webhook-server` with `hooka:cf-pages`.
