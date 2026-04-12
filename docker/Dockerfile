FROM oven/bun:1.3.10-alpine AS install

WORKDIR /app

COPY package.json bun.lock bunfig.toml tsconfig.json ./

# BEGIN WORKSPACE MANIFESTS
COPY apps/cli/package.json apps/cli/package.json
COPY apps/server/package.json apps/server/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY packages/admin-ui/package.json packages/admin-ui/package.json
COPY packages/bun-utils/package.json packages/bun-utils/package.json
COPY packages/cap-cloudflare-api/package.json packages/cap-cloudflare-api/package.json
COPY packages/cap-git/package.json packages/cap-git/package.json
COPY packages/cap-php-cli/package.json packages/cap-php-cli/package.json
COPY packages/cap-rclone/package.json packages/cap-rclone/package.json
COPY packages/cap-rsync/package.json packages/cap-rsync/package.json
COPY packages/cap-wpcli/package.json packages/cap-wpcli/package.json
COPY packages/cap-wrangler/package.json packages/cap-wrangler/package.json
COPY packages/config/package.json packages/config/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/executor-http/package.json packages/executor-http/package.json
COPY packages/executor-process/package.json packages/executor-process/package.json
COPY packages/logger/package.json packages/logger/package.json
COPY packages/pack-cloudflare-cache/package.json packages/pack-cloudflare-cache/package.json
COPY packages/pack-cloudflare/package.json packages/pack-cloudflare/package.json
COPY packages/pack-rclone/package.json packages/pack-rclone/package.json
COPY packages/pack-wordpress-cloudflare/package.json packages/pack-wordpress-cloudflare/package.json
COPY packages/pack-wordpress/package.json packages/pack-wordpress/package.json
COPY packages/preset-catalog/package.json packages/preset-catalog/package.json
COPY packages/registry/package.json packages/registry/package.json
COPY packages/run-store/package.json packages/run-store/package.json
COPY packages/runner-core/package.json packages/runner-core/package.json
COPY packages/runtime-contracts/package.json packages/runtime-contracts/package.json
COPY packages/targets/package.json packages/targets/package.json
COPY packages/task-sdk/package.json packages/task-sdk/package.json
# END WORKSPACE MANIFESTS

RUN bun install --frozen-lockfile

FROM install AS build

COPY . .
RUN bun run build

FROM build AS runtime-base

ARG HOOKA_SOURCE_REPO=https://github.com/imjlk/hooka
ARG HOOKA_IMAGE_DESCRIPTION=Hooka webhook-driven automation runtime
ARG HOOKA_IMAGE_LICENSES=MIT

LABEL org.opencontainers.image.source=$HOOKA_SOURCE_REPO
LABEL org.opencontainers.image.description=$HOOKA_IMAGE_DESCRIPTION
LABEL org.opencontainers.image.licenses=$HOOKA_IMAGE_LICENSES

ENV HOOKA_DB_PATH=/data/hooka.sqlite
ENV HOOKA_MANIFEST_PATH=/app/.hooka/installed-capabilities.json
ENV HOOKA_PORT=3000
ENV HOOKA_POLL_INTERVAL_MS=2000
ENV HOOKA_RUN_LEASE_MS=900000

EXPOSE 3000

FROM runtime-base AS webhook-server

RUN bun run image:install-features --features="core" --manifest=/app/.hooka/installed-capabilities.json --image=hooka:webhook-server
RUN mkdir -p /data

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD bun -e "const response = await fetch('http://127.0.0.1:3000/api/health'); if (!response.ok) process.exit(1);"

ENV HOOKA_RUNTIME_ROLE=webhook-server

VOLUME ["/data"]

CMD ["bun", "run", "apps/server/dist/index.js"]

FROM runtime-base AS worker-preset

ARG HOOKA_FEATURES=core
ARG HOOKA_IMAGE_LABEL=hooka:worker
ARG HOOKA_RUNTIME_ROLE=hooka-worker
ARG HOOKA_INSTALLED_CAPABILITIES=

RUN bun run image:install-features --features="${HOOKA_FEATURES}" --manifest=/app/.hooka/installed-capabilities.json --image="${HOOKA_IMAGE_LABEL}"
RUN mkdir -p /data /shared-source

ENV HOOKA_RUNTIME_ROLE=${HOOKA_RUNTIME_ROLE}
ENV HOOKA_INSTALLED_CAPABILITIES=${HOOKA_INSTALLED_CAPABILITIES}

VOLUME ["/data", "/shared-source"]

CMD ["bun", "run", "apps/worker/dist/index.js"]
