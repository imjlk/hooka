FROM oven/bun:1.3.10-alpine AS runtime

ARG HOOKA_FEATURES=core

WORKDIR /app

COPY . .

RUN bun install --frozen-lockfile
RUN bun run build
RUN bun run image:install-features --features="${HOOKA_FEATURES}" --manifest=docker/manifests/installed-capabilities.json

RUN mkdir -p /data

ENV HOOKA_DB_PATH=/data/hooka.sqlite
ENV HOOKA_PORT=3000
ENV HOOKA_POLL_INTERVAL_MS=2000
ENV HOOKA_RUN_LEASE_MS=900000

EXPOSE 3000

VOLUME ["/data"]

CMD ["bun", "run", "apps/server/dist/index.js"]
