# Local development

```bash
bun install
bun run build
```

Start the API server:

```bash
HOOKA_DB_PATH=/tmp/hooka.sqlite \
HOOKA_WEBHOOK_SECRET=local-secret \
bun run dev:server
```

Start the worker in another shell:

```bash
HOOKA_DB_PATH=/tmp/hooka.sqlite \
bun run dev:worker
```

Queue a run locally:

```bash
HOOKA_DB_PATH=/tmp/hooka.sqlite \
bun run apps/cli/src/index.ts task enqueue wordpress.deploy.simply-static --project staging-site
```

Inspect recent runs:

```bash
HOOKA_DB_PATH=/tmp/hooka.sqlite \
bun run apps/cli/src/index.ts run list
```
