# Local development

```bash
bun install
bun run build
```

Start the API server:

```bash
HOOKA_DB_PATH=/tmp/hooka.sqlite \
HOOKA_MANIFEST_PATH=$PWD/.hooka/installed-capabilities.json \
HOOKA_WEBHOOK_SECRET=local-secret \
HOOKA_INSTALLED_CAPABILITIES=wrangler \
bun run dev:server
```

You can verify the server after boot with:

```bash
curl http://127.0.0.1:3000/api/health
curl http://127.0.0.1:3000/api/ready
```

Start the worker in another shell:

```bash
HOOKA_DB_PATH=/tmp/hooka.sqlite \
HOOKA_MANIFEST_PATH=$PWD/.hooka/installed-capabilities.json \
HOOKA_INSTALLED_CAPABILITIES=wrangler \
CLOUDFLARE_API_TOKEN=local-token \
CLOUDFLARE_ACCOUNT_ID=local-account \
bun run dev:worker
```

Start the Bun HMR admin UI:

```bash
bun run dev:ui
```

Generate a local manifest and send a signed generic webhook:

```bash
mkdir -p /tmp/hooka-shared/simply-static "$PWD/.hooka"
bun run apps/cli/src/index.ts image install-features \
  --features wrangler \
  --manifest "$PWD/.hooka/installed-capabilities.json" \
  --image hooka:local

HOOKA_WEBHOOK_SECRET=local-secret \
bun run apps/cli/src/index.ts webhook test \
  --task-id deploy.shared-volume.wrangler \
  --payload-json '{"kind":"pages-deploy","project":"staging-site","sourcePath":"/tmp/hooka-shared/simply-static"}'
```

Inspect recent runs:

```bash
HOOKA_DB_PATH=/tmp/hooka.sqlite \
bun run apps/cli/src/index.ts run list
```

If you want your local setup to mirror the lean worker taxonomy, treat this flow as the local equivalent of pairing `hooka:webhook-server` with `hooka:cf-pages`.
