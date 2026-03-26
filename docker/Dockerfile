FROM oven/bun:1.3.10-alpine AS build

WORKDIR /app

COPY . .

RUN bun install --frozen-lockfile
RUN bun run build

FROM build AS runtime-base

ENV HOOKA_DB_PATH=/data/hooka.sqlite
ENV HOOKA_PORT=3000
ENV HOOKA_POLL_INTERVAL_MS=2000
ENV HOOKA_RUN_LEASE_MS=900000

EXPOSE 3000

FROM runtime-base AS webhook-server

RUN bun run image:install-features --features="core" --manifest=docker/manifests/installed-capabilities.json --image=hooka:webhook-server
RUN mkdir -p /data

ENV HOOKA_RUNTIME_ROLE=webhook-server

VOLUME ["/data"]

CMD ["bun", "run", "apps/server/dist/index.js"]

FROM runtime-base AS worker-preset

ARG HOOKA_FEATURES=core
ARG HOOKA_IMAGE_LABEL=hooka:worker
ARG HOOKA_RUNTIME_ROLE=hooka-worker
ARG HOOKA_INSTALLED_CAPABILITIES=

RUN bun run image:install-features --features="${HOOKA_FEATURES}" --manifest=docker/manifests/installed-capabilities.json --image="${HOOKA_IMAGE_LABEL}"
RUN mkdir -p /data /shared-source

ENV HOOKA_RUNTIME_ROLE=${HOOKA_RUNTIME_ROLE}
ENV HOOKA_INSTALLED_CAPABILITIES=${HOOKA_INSTALLED_CAPABILITIES}

VOLUME ["/data", "/shared-source"]

CMD ["bun", "run", "apps/worker/dist/index.js"]
