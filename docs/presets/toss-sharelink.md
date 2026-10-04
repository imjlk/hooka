# Toss Sharelink preset

The `toss-sharelink` worker prepares affiliate offers for multiple consumer apps.
It does not serve a storefront or decide when a consumer should display an offer.
The preset is independent of TrailBase, Cloudflare Pages, quiz rounds, and UI frameworks.

## Delivery and scope

The preset is released in Hooka 1.3.0; its operational CLI requires 1.4.0.
The rolling image is `ghcr.io/imjlk/hooka:toss-sharelink`. Prefer the released
`ghcr.io/imjlk/hooka:1.4.0-toss-sharelink` image (or a digest) in production.
See the [deployment guide](./toss-sharelink-deployment.md) for a pinned starter.

The preset includes `@hooka/cap-toss-sharelink` and `@hooka/pack-toss-sharelink`.
It uses Bun fetch and SQLite and installs no additional command-line tools.

Implemented tasks:

| Task | Input | Effect |
| --- | --- | --- |
| `toss-sharelink.refresh` | v1 `appId`, optional `subjectIds` (maximum 100) | Collect category candidates, match reviewed keywords, check individual product availability, issue/reuse links, publish a snapshot |
| `toss-sharelink.export` | v1 `appId` | Republish stored valid offers; withdraw disabled, deleted, revised, or expired entries; no Toss calls |
| `toss-sharelink.subtag.ensure` | v1 `appId` | Explicitly register/restore the configured app subTag; does not delete or rename channels |
| `toss-sharelink.performance.sync` | v1 `appId`, `fromDate`, `toDate`, optional `attribution` | Collect up to 31 days of provisional performance, scoped to the app subTag |
| `toss-sharelink.settlement.sync` | v1 `appId`, `settlementMonth`, optional `attribution` | Collect confirmed commission performance for a month, scoped to the app subTag |

The [operations guide](./toss-sharelink-operations.md) provides offline tools,
a one-shot `sharelink tick` command, consumer readers and Compose E2E.
No internal recurring scheduler is added. An external scheduler or application
producer enqueues refreshes after content/rule changes and at an appropriate
refresh interval. Keep each refresh under 100 subjects; explicitly select subsets
for larger configurations. Provider work is bounded to about two minutes per run.

Not included in v1: free-text provider search, semantic/AI matching, thumbnail or
price display, order callbacks/reconciliation, consumer HTTP
APIs, user-level rewards, and consumer application changes. These need separately
reviewed contracts. A successful task is not an impression, purchase, or settlement.

## Public v1 contract

Runtime schemas are exported from `packages/pack-toss-sharelink/src/contracts.ts`.
Portable JSON Schemas are committed under `docs/contracts/toss-sharelink/v1/`:

- `config.schema.json`: operator configuration (secret **environment names**, never values).
- `refresh.schema.json`, `export.schema.json`: task payloads.
- `snapshot.schema.json`: consumer-facing offer results.
- `performance.schema.json`, `settlement.schema.json`: report task input.
- `report.schema.json`: private app-scoped performance/settlement results.
- SubTag registration uses the same input schema as export.

Run `bun run sharelink:schemas` after changing the runtime contract. JSON Schema
expresses structural constraints; runtime validation additionally enforces exact
issued-link hosts, uniqueness, known account references, manual review intervals,
and ready/offer consistency. Document these invariants when implementing a client.

Task input deliberately cannot specify credentials, URLs, output paths, SQL, or
arbitrary rules. `schemaVersion: 1` is required. Breaking shape/meaning changes
require a new contract version and a migration plan, not a silent schema rewrite.

### Namespaces and revisions

- `accountId` names one partner credential set, consistently across all sidecars.
  The store binds it to the Access Key fingerprint and rejects a second account
  alias for the same key. Secret rotation does not change account identity.
- `appId` scopes consumer rules and output. Register separate app IDs for web/native
  if their issued links must use different subTags, e.g. `ztt-web`, `ztt-native`.
- `subjectId` is the consumer's stable content key, not necessarily a product or word.
- Increment `app.revision` on **every** app configuration change; increment the
  affected subject's `revision` on a rule change. Stale app revisions and changed
  configurations with an unchanged app revision fail closed. An app cannot silently
  move between partner accounts.
- All replicas responsible for an app must receive the same configuration.
  Atomically replace the file in a mounted **directory** when updating it.
  File-only bind mounts can keep seeing an old inode after host-side replacement.

Configure reviewed provider category IDs and normalized title keywords, not an
arbitrary customer answer. Matching requires category membership (including
children) AND at least one keyword. Excluded words/categories/products win.
Set `catalogSource` to `category-best` (default), `today-deals`, or `overall-best`.
All sources still require the configured category and keyword; a source change is
explicit and is never an automatic fallback. Each source reads only its first 30
products in v1.

NFKC, lowercase, and whitespace normalization are lexical matching, not semantic
synonym inference. No unrelated bestseller fallback is performed. At most three
candidates are attempted; only item-specific issuance refusal advances to the
next candidate. Auth/quota/global provider failures stop the batch.

### Consumer snapshot

The worker atomically writes `<HOOKA_SHARELINK_RESULTS_PATH>/<appId>/offers.json`.
The snapshot contains `schemaVersion`, `appId`, `appRevision`, `generationId`,
`generatedAt` (epoch milliseconds), and entries:

```json
{
  "subjectId": "pillow",
  "ruleRevision": 1,
  "status": "pending",
  "offer": null
}
```

Status is `ready`, `no-match`, `disabled`, or `pending`. Only `ready` includes an
offer: `provider`, `productId`, `title`, `url`, `source`, `checkedAt`, `expiresAt`.
Offer source is `automatic` or `manual`. Missing matches explicitly have no offer.
Expired/mismatched entries become pending until refreshed. Consumers must check
schema/app identity, their expected rule version, status and **expiresAt on every
use**; an existing snapshot can outlive its worker. Do not extend the TTL on read.
Snapshots do not expose credentials, budgets, raw provider errors, or rule keywords.

Have the consumer backend import/read its snapshot and expose its own app API.
A Pages frontend does not mount a Docker volume; its backend reads the result.
Use a read-only mount for consumers, ideally exposing only their app subdirectory.
Never serve the private SQLite volume or config directory over HTTP. Do not write
directly into another app's TrailBase SQLite files. A future HTTP delivery adapter
must define authenticated delivery and idempotent version-aware acceptance.

## Accounts, secrets, and shared volumes

Start with `examples/toss-sharelink/config.json` and `compose.yml`. IDs in the
example are placeholders, not approved categories or working credentials.

Required worker environment:

- `HOOKA_SHARELINK_CONFIG_PATH`: absolute JSON configuration path.
- `HOOKA_SHARELINK_DB_PATH`: absolute **private domain** SQLite path, separate from
  `HOOKA_DB_PATH` (Hooka run history) and all consumer databases.
- `HOOKA_SHARELINK_RESULTS_PATH`: absolute directory for consumer snapshots.
- Access Key / Secret Key values under the environment names configured per account.

The `toss-sharelink` capability checks the three path settings; task execution
checks dynamic account credential references. `dryRun` validates configuration
and input but makes no provider requests and creates no stores/snapshots.

The example intentionally has:

1. A project-local Hooka queue volume per consumer stack.
2. An external shared private product volume for partner caches, budget counters,
   account leases, app revision guards, and result records.
3. A separate external shared snapshot volume, safe to mount read-only in consumers.

Create the external volumes once before deploying the stacks. Identical Compose
volume keys alone do not share data: use the same external volume `name`. Sharing
is supported on **one Docker host with a local filesystem**, not SQLite over NFS.
Both stacks must mount the same product database and snapshot roots. Snapshot
publication uses a SQLite write transaction to prevent a stale lease holder from
replacing a newer owner's file. Keep released image/store versions compatible
across sidecars; the domain store rejects schema versions it does not understand.
The output directories must be operator-owned and must not contain untrusted symlinks.

Each stack's Hooka server is a trusted administration boundary, not a tenant API.
Anybody holding its admin/webhook secret can request tasks for apps present in
that worker's configuration. For app-specific ingress, mount a configuration
containing only that app; keep shared account IDs/budgets consistent. Do not put
multiple differently scoped workers on one queue without explicit routing.

Keep Pages workers on their existing queues. If multiple app stacks refresh at
once, the product account lease serializes calls regardless of which queue they
use. Suggested busy-work retry settings: `HOOKA_RUN_MAX_ATTEMPTS=5` and
`HOOKA_RETRY_BASE_DELAY_MS=30000`. Repeated busy failures are visible in Hooka and
can be retried; queues do not promise exactly-once side effects.

## Caching, budgets, and failure behavior

The worker has a renewable 60-second account lease and fences writes. Provider
calls are paced at least 300 ms apart across sidecars using the shared store.
This coordinates only workers sharing this store; other tools using the same
partner keys still consume the provider's limits. Register the actual fixed
outbound IP in Toss; a Docker network address is not that IP.

- Category trees: cached for 24 hours.
- Category-best lists: at most 30 products, cached until the next 09:00 KST boundary.
- Today deals: at most 15 minutes, bounded by deal end times.
- Overall best: at most one hour.
- Product detail: cached at most 15 minutes; sold-out/expired products are rejected.
- Issued links: reused for 30 days by publisher/subTag/product; this is a cache
  policy, **not a provider guarantee that a link stays valid for 30 days**.
- An automatic offer expires no later than its detail snapshot (maximum 15 minutes).

Daily local budgets reset at midnight KST. The worker conservatively reserves the
maximum returned product count **before** a request (30 for a category page, one
for a detail) and one link unit before an uncached issuance. Reservations are not
refunded on failure or fewer returned products; this is a safety budget, not an
exact provider billing report. Same-product reissuance may not consume provider
link quota, but still reserves locally. Defaults leave headroom at 9,000/9,000.
The lowest limit encountered by replicas applies for the remainder of that day.
A local quota failure stops before making the product/link request.

Only HTTPS official provider endpoints are called, with redirect rejection,
5-second timeouts and a 1 MiB response bound. Both HTTP status and `resultType`
are checked. Provider quota exhaustion persists a block until the next KST day.
Auth and invalid configuration errors are terminal; transient transport/HTTP
failures request Hooka backoff, but a subsequent shared cooldown stops early.
Schedule a later refresh or explicitly retry once the cause is resolved. Raw
provider response bodies and credentials are never put into run results.

Partial successful matches persist. A failure publishes a snapshot withdrawing
the subject currently being refreshed; untouched still-valid offers can remain.
Configuration changes abort an old run. A config change alone does not trigger a
job: enqueue export/refresh promptly, including disabled/manual removal changes.

### Manual links

Operators can set `manual` with a real issued link, product ID/title,
`reviewedAt`, and `reviewUntil` (at most seven days apart). An unexpired reviewed
manual mapping wins over automatic matching. Its public offer is still bounded
to 15 minutes and must be republished to remain visible. Manual review dates do
not prove live stock; the operator owns manual title/link correctness, availability,
and prompt removal. Expired manual mappings fall back to automatic matching.

## Enqueue example

Send an authenticated generic Hooka webhook (or use the admin enqueue API):

```json
{
  "taskId": "toss-sharelink.refresh",
  "input": { "schemaVersion": 1, "appId": "word-app", "subjectIds": ["pillow"] },
  "eventId": "word-app-r1-pillow-r1-2026-10-04T10",
  "source": "consumer.catalog"
}
```

Use a stable event ID for retries of one intent, and a new time-bucket ID for each
scheduled refresh. Existing Hooka webhook deduplication does not replace the
shared partner lease, provider link idempotency, or consumer revision checks.

## Policy and provenance

This preset is an independent integration with public Toss Sharelink APIs. It
contains no copied kit code or consumer business rules. The related
trailbase-apps-in-toss-kit repository is public; its runtime package is marked
private for workspace use, which is distinct from repository visibility.
API access requires Toss approval and registered outbound IPs. Register the
consumer channels/subTags before use and describe the actual web/native surfaces
in the approval request. The worker does not approve a display or reward policy.
Consumers own voluntary navigation, disclosure, allowed product presentation,
and their own hint/answer exposure decisions. Do not infer that click-gated rewards
are approved because an issued link exists.

Official references, consulted 2026-10-04:

- [Approval and credentials](https://sharelink-docs.toss.im/developers/open-api/auth)
- [Limits and response conventions](https://sharelink-docs.toss.im/developers/open-api/convention)
- [Categories](https://sharelink-docs.toss.im/developers/open-api/api/categories)
- [Category products](https://sharelink-docs.toss.im/developers/open-api/api/products)
- [Product details](https://sharelink-docs.toss.im/developers/open-api/api/product-detail)
- [Issued links](https://sharelink-docs.toss.im/developers/open-api/api/link)
- [Operating policy](https://sharelink-docs.toss.im/help/operations/policy)
- [Disclosure](https://sharelink-docs.toss.im/disclosure)


## Reports and channel administration

Run `toss-sharelink.subtag.ensure` explicitly before the first automatic link
issuance for a new app channel. It uses only the operator-configured subTag and
can restore a deleted channel; ordinary refreshes never register channels as a
side effect. No subTag deletion or label mutation task is exposed.

Report tasks collect all pages, up to 50 pages/5,000 rows, and fail rather than
publishing partial totals if that bound is reached. Narrow the performance date
range when needed; oversized settlement reports need a future resumable export.
Reports are stored for 90 days in the private domain store and returned through
Hooka's authenticated run result API. They are never written to `offers.json` or
the consumer snapshot volume. The run DB has its own configured retention.

`summary` describes the entire range and is not summed across pages. Preserve
`productId` plus `attribution` as the row key. Click count exists only in the
performance summary; it cannot be interpreted as a product-level click count.
Reports can change while pages are collected; this is not a transactionally
consistent provider export. Duplicate rows across pages fail and may be retried.

Performance is provisional and uses payment dates for sales/commission, while
clicks use visit dates. Settlement reports use confirmation months and contain
confirmed, pre-tax commission, not payout status or actual bank deposits. Keep
provider amounts; do not recompute commission from a flat rate. Re-fetch recent
periods to account for refunds and later confirmations. `lastUpdatedAt` and
`latestConfirmedAt` are provider-local Korean-time strings preserved as supplied.

Future order ingestion must combine signed Push verification with a singleton
Pull reconciliation job, deduplicate by event ID, tolerate out-of-order events,
and start every new scan without a saved backwards cursor. It is intentionally
not approximated by treating link dispatch or task success as a purchase.

Additional official references, consulted through the documentation MCP:

- [Today deals](https://sharelink-docs.toss.im/developers/open-api/api/today-deals)
- [Overall best](https://sharelink-docs.toss.im/developers/open-api/api/best-selling)
- [SubTags](https://sharelink-docs.toss.im/developers/open-api/api/sub-tags)
- [Performance](https://sharelink-docs.toss.im/developers/open-api/api/performance)
- [Settlements](https://sharelink-docs.toss.im/developers/open-api/api/settlement)
- [Order reconciliation](https://sharelink-docs.toss.im/developers/open-api/api/order-events)

For documentation lookup during development (not a runtime dependency):

```sh
codex mcp add docs --url https://sharelink-docs.toss.im/~gitbook/mcp
```

Use its read-only search/page tools to confirm provider changes before updating
contracts. Do not send feedback or production operations merely to read docs.
