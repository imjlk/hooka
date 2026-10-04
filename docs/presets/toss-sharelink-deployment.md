# Deploy the Sharelink sidecar

This starter targets the published [Hooka 1.4.0 release](https://github.com/imjlk/hooka/releases/tag/v1.4.0).
It prepares two independent consumer stacks on **one Docker host**. It does not
install production services, register channels, or connect a consumer automatically.

## Pinned artifacts and ownership

| Artifact | Reference |
| --- | --- |
| Source and contracts | `6116fd5d1ec9603e95cc731345c5c648b214d430` (`v1.4.0`) |
| Worker | `ghcr.io/imjlk/hooka:1.4.0-toss-sharelink` |
| Worker multi-platform digest | `sha256:a5b2b249bdb2b58989a49a9d33318c61a386c5cd1fa447c08240fbd331a5e724` |
| Webhook server | `ghcr.io/imjlk/hooka:1.4.0-webhook-server` |
| Wire contract | `docs/contracts/toss-sharelink/v1/` at the pinned source |
| Portable reader | `packages/pack-toss-sharelink/src/consumer.ts` and `contracts.ts` at the pinned source |
| Deployment templates | `examples/toss-sharelink/compose.yml`, `compose.preflight.yml`, `.env.example` in this change |

The deployment starter is newer than 1.4.0, but invokes only commands already
present in that image. Both images must use the same release. Hooka owns product
matching, shared budgets, caching and snapshots. Consumers own their trusted
subject/revision catalog, authenticated delivery, display rules and disclosure.

| Stack example | App namespaces | Queue | Shared storage |
| --- | --- | --- | --- |
| `ztt-shopping` | `ztt-web`, `ztt-native` | `ztt-shopping_sharelink_queue` | `hooka-sharelink-private`, `hooka-sharelink-results` |
| `cattower-shopping` | `cattower-native` | `cattower-shopping_sharelink_queue` | Same two external volumes |

These names are suggested configuration, not a claim of existing registrations.
The starter catalogs are empty. They cannot issue product links until reviewed
subjects are added. The publisher UUID is a placeholder and **must be replaced**.
Keep account ID, publisher ID, credentials and account budgets consistent in both
stacks. App namespaces have exactly one owning queue/scheduler.

## 1. Prepare each stack without provider keys

Copy `examples/toss-sharelink/` to separate operator-owned deployment directories,
such as `/srv/ztt-shopping` and `/srv/cattower-shopping`. In the ZTT directory:

```sh
cp .env.example .env
chmod 600 .env
mkdir -p sharelink-config
cp deploy/ztt/config.json sharelink-config/config.json
docker compose -p ztt-shopping -f compose.preflight.yml run --rm preflight
docker compose -p ztt-shopping -f compose.preflight.yml run --rm preflight \
  plan --config /sharelink-config/config.json --domain /tmp/uninitialized.sqlite
```

For the other stack use `deploy/cattower/config.json` and project name
`cattower-shopping`. The preflight container has no network, provider credentials
or production volumes. Docker may need internet to pull the image before starting
it. A successful `validate` checks schema only; it does not verify the publisher,
approved IP, live inventory, channel registration or consumer implementation.
An empty catalog plans only exports; it is not a successful product match.

Use the directory bind mount: a missing host directory fails deployment instead
of being silently created. In Coolify, configure an absolute `SHARELINK_CONFIG_DIR`
on the deployment host; a path on the operator's laptop will not work. Keep .env
and the filled configuration outside public source control. `docker compose config`
without `--quiet` expands secret values; do not paste its output into logs or PRs.

## 2. Configure the approved account

Before starting the live worker:

1. Replace the placeholder publisher UUID in both configs. Confirm both stacks
   deploy to the same Docker host with local storage, not an NFS volume.
2. Store Access Key and Secret Key in Coolify's secret environment settings, using
   the names in `.env.example`. Do not put values in JSON or send them in a PR.
3. Set distinct, randomly generated webhook/admin secrets per stack. Keep this
   internal administration service off public ingress. The example exposes port
   3000 to its Compose network only; it does not publish a host port or domain.
4. Confirm the actual host egress IP is registered with the provider. Check the
   app/channel names against the approved web and native surfaces.
5. Add only one to three reviewed subjects for the first app. Use real provider
   category IDs, stable consumer subject IDs, keywords and exclusions. Do not
   use the fictitious category/product IDs in `catalog.fixture.json` for live work.
   Increment app revision on every app change and subject revision on rule changes.

Create the two external volumes **once** on that host:

```sh
docker volume create hooka-sharelink-private
docker volume create hooka-sharelink-results
```

Use identical external volume names in both Coolify stacks. The queue remains a
project-local volume; never reuse the Pages build queue or consumer database.
For conservative offline backup, stop both schedulers and workers before backing
up the private volume and queues together. Do not copy a live SQLite main file
alone while its WAL is active. Results can be regenerated from the domain store.

## 3. Start ZTT first and register its channels

From the configured ZTT deployment directory:

```sh
docker compose -p ztt-shopping -f compose.yml config --quiet
docker compose -p ztt-shopping -f compose.yml up -d
docker compose -p ztt-shopping -f compose.yml exec -T sharelink-worker \
  bun apps/cli/dist/index.js sharelink status
docker compose -p ztt-shopping -f compose.yml exec -T sharelink-worker \
  bun apps/cli/dist/index.js task enqueue toss-sharelink.subtag.ensure \
  --payload-json '{"schemaVersion":1,"appId":"ztt-web"}'
```

Repeat the explicit registration for `ztt-native` when enabling that channel.
Inspect the returned run in Hooka's authenticated admin UI/API; wait for successful
registration before requesting a refresh. Enqueue acknowledgement is not task
completion. Registration may create or restore a provider channel.

```sh
docker compose -p ztt-shopping -f compose.yml exec -T sharelink-worker \
  bun apps/cli/dist/index.js sharelink tick --app ztt-web --dry-run
docker compose -p ztt-shopping -f compose.yml exec -T sharelink-worker \
  bun apps/cli/dist/index.js sharelink tick --app ztt-web
docker compose -p ztt-shopping -f compose.yml exec -T sharelink-worker \
  bun apps/cli/dist/index.js sharelink status
```

Wait for the queued work, then inspect status again. A `ready` result needs a
reviewed live product/link and an unexpired snapshot. Confirm real issued-link
navigation manually before enabling banners. Failures stay visible in the queue;
do not repeatedly register channels or erase budgets to recover a provider error.

## 4. Connect the consumer and schedule refreshes

Mount only results into the consumer backend, read-only; prefer each app's
subdirectory once it exists. Never mount private storage or provider secrets into
the browser, Pages deployment worker, or public file server. Cloudflare Pages
cannot read a Docker volume. Its server must call the consumer backend through
the consumer's own authenticated route. Hooka 1.4.0 provides snapshots, not that
HTTP route or a TrailBase importer.

The backend validates app ID, independently known app/rule revisions, snapshot
schema, timestamps and expiry using the portable reader. It exposes only offers
the requesting context is allowed to see. An old or missing snapshot means no
offer. Revalidate at click time; do not cache a redirect beyond the offer expiry.
The current contract contains title and URL, not prices or thumbnails.

After confirming delivery, install one scheduler per owning stack. On the host,
run the following every minute (or configure the equivalent Coolify scheduled
task inside `sharelink-worker`):

```cron
* * * * * cd /srv/ztt-shopping && docker compose -p ztt-shopping -f compose.yml exec -T sharelink-worker bun apps/cli/dist/index.js sharelink tick --app ztt-web
```

Omit `--app` only when every configured channel in that stack is ready. The
default five-minute bucket deduplicates repeated ticks. Monitor scheduler failures,
ready/expired counts and remaining daily budgets. After ZTT's limited rollout,
repeat the same steps for the second stack with its own project name and app ID.
No full-catalog refresh is recommended before measuring budget use.

## Consumer handoff and rollback

The consumer team should pin the source/schema and image references above,
implement its server reader/route, and map its IDs and revisions to the config.
The existing ZTT/캣타워 application code is not changed by this starter. Reports,
callback ingestion, order reconciliation and per-user rewards are separate work;
task success never proves a purchase or consumer delivery.

To pause, disable the owning scheduler and stop its worker. Consumers must hide
offers at expiry even while offline. To withdraw immediately, disable the relevant
subjects, increment revisions, and enqueue `toss-sharelink.export` before stopping
the worker; also apply the consumer's display kill switch if delivery is failing.
Do not delete shared volumes or roll back database files while another stack is
using them. Stop the tick scheduler before reverting below 1.4.0, which has no
operations CLI. Preserve the additive queue columns during a code rollback.
