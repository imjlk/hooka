# Local development

```bash
bun install
cp .env.example .env
bun run build
```

Scaffold the local DX files:

```bash
bun run apps/cli/src/index.ts init --yes --preset cf-pages
```

Start the full local stack:

```bash
bun run apps/cli/src/index.ts dev
```

Check server status:

```bash
bun run apps/cli/src/index.ts status
```

You can still verify the server endpoints directly:

```bash
curl http://127.0.0.1:3000/api/health
curl http://127.0.0.1:3000/api/ready
```

Send a signed generic webhook against the initialized local scaffold:

```bash
HOOKA_WEBHOOK_SECRET=local-secret \
bun run apps/cli/src/index.ts webhook test \
  --task-id deploy.shared-volume.wrangler \
  --payload-json '{"kind":"pages-deploy","project":"staging-site","sourcePath":".hooka/shared-source/simply-static"}'
```

Inspect recent runs:

```bash
bun run apps/cli/src/index.ts run list
```

If you want your local setup to mirror the lean worker taxonomy, treat this flow as the local equivalent of pairing `hooka:webhook-server` with `hooka:cf-pages`.
