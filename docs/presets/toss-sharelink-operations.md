# Sharelink operations and offline readiness

These commands are available in Hooka **1.4.0** and later (not in 1.3.0).
The [deployment guide](./toss-sharelink-deployment.md) includes two-stack starter
configs, offline preflight and a staged rollout. For local development use
`bun apps/cli/src/index.ts` in place of
`bun apps/cli/dist/index.js` after `bun install`. Build/deploy this revision before
configuring a scheduled task. All operation command output is JSON.

## Prepare without provider keys

```sh
bun apps/cli/src/index.ts sharelink validate --config examples/toss-sharelink/config.json
bun apps/cli/src/index.ts sharelink preview --config examples/toss-sharelink/config.json --app word-app --fixture examples/toss-sharelink/catalog.fixture.json
bun apps/cli/src/index.ts sharelink plan --config examples/toss-sharelink/config.json --domain /tmp/not-initialized-sharelink.sqlite
```

`validate` validates the v1 schema, uniqueness and account references. It never
reads secret values. Budget warnings are rough upper estimates assuming distinct
products and ten-minute renewal; cache sharing, category fetches, deal expiry and
rejections change actual usage. `preview` accepts normalized fixture products and
shows lexical candidates only: it does not prove live inventory, manual-link
validity, API approval or issuance. Example IDs and URLs are fictitious.

## Schedule a tick

Use the existing Compose template, with one app-scoped worker configuration per
consumer stack. Keep the queue local to the stack and share the private product
store/results volumes across stacks on the same Docker host.

Configure a Coolify/host scheduler to execute this **every minute**, or use cron:

```cron
* * * * * cd /srv/my-consumer && docker compose exec -T sharelink-worker bun apps/cli/dist/index.js sharelink tick --app word-app
```

The command runs once and exits. It does not install cron or run a daemon.
`--dry-run` prints planned jobs without creating or changing the queue. Path
settings default to the worker's `HOOKA_SHARELINK_*` variables; `--db` defaults to
`HOOKA_DB_PATH`. Never point the queue and domain store at the same file.

- Default bucket: five minutes (`--period-minutes 1..5`). Repeated ticks in a
  bucket reuse deterministic source event IDs. A changed config changes the ID.
- Default batch: 25 enabled subjects (`--batch-size 1..100`). IDs are sorted for
  deterministic batching. Configs can contain up to 1,000 subjects per app.
- An active run with the same task/batch is reused atomically even across bucket
  boundaries. Queue migration adds nullable `runs.coalesce_key` and an index;
  old history is retained and old workers can still read the database.
- Coalescing is per queue, not across separate queues. Own each app namespace in
  one stack; use different app IDs for separate web/native channels as needed.
- Provider cooldowns and exhausted product/link budgets pause automatic refresh
  planning. A reservation that exceeds the remaining local budget also persists
  a pause until the next KST day, even when a small remainder is left. Export jobs continue so disabled/revised offers are withdrawn.
  Reviewed, still-valid manual rules can refresh without provider calls.
- The provider also checks budgets at execution time. Work queued before a block
  can still fail; queue history makes that visible. A new bucket can retry after
  cooldown/day reset. Do not reset budget tables to force another attempt.
- Product detail cache entries with five minutes or less remaining are renewed.
  Existing issued links are reused. A failed renewal never extends old validity.

Queue delays, quotas, outages or campaigns ending can still leave no offer.
Consumers must hide expired offers even when the worker or scheduler is stopped.
For large catalogs, limit enabled subjects to current content. Refreshing 1,000
distinct products all day is likely to exceed a 9,000-product daily budget;
100-subject batching is a safety bound, not a capacity promise.

## Inspect and recover

```sh
docker compose exec -T sharelink-worker bun apps/cli/dist/index.js sharelink status
```

Status opens existing databases read-only. It returns remaining local budgets,
reset/cooldown/lease times, app revisions, ready/expired/pending/no-match counts,
and up to 100 recent failed/dead-lettered Sharelink runs filtered to configured
apps. It returns error codes, never raw errors, OAuth caches or financial reports.
A missing domain DB is reported as uninitialized, not created by this command.

After a killed worker, restart the worker and allow the 60-second domain lease to
expire plus queue backoff. Do not manually delete leases. Keep
`HOOKA_RUN_MAX_ATTEMPTS=5` and `HOOKA_RETRY_BASE_DELAY_MS=30000` from the example.
Fix authentication/configuration errors before retrying; daily quota failures
resume after the next KST budget reset. Use existing `hooka run show/retry` for
individual failed runs. On rollback, stop the tick schedule before using images
that do not contain the operations commands. Do not drop additive queue columns.

## Consumer integration

`validateSharelinkSnapshot` checks a whole snapshot and returns either the parsed
snapshot or a bounded failure code. Supply `subjects: [{subjectId, ruleRevision}]`
to require the exact expected subject/revision set. It checks duplicates, app
identity, future timestamps and the 15-minute publication horizon. Expired entries
remain valid wire data: importers withdraw them, and `selectSharelinkOffer` returns
null for an expired offer. Both functions are stateless.

An importer must persist its last applied app revision, generation timestamp/ID
and content identity in the same transaction as automatic offer replacement.
Reject old results and ambiguous equal-time generations; identical retransmissions
are idempotent. Preserve provider expiry, manual mappings and consumer kill switches.
This helper does not perform DB writes or make stale snapshots safe to replay.

`examples/toss-sharelink/read-offer.ts` shows a backend reader. The portable
`selectSharelinkOffer` implementation depends only on the v1 Zod contract; its
package subpath is `@hooka/pack-toss-sharelink/consumer` within this workspace.
Hooka workspace packages are not published to npm. External consumers can vendor
`consumer.ts` plus `contracts.ts` from a pinned Hooka revision, or implement the
same checks using the committed JSON Schemas. Do not bundle Hooka's root task pack
into a browser: it includes Bun/SQLite worker operations.

Check expected app ID, app revision, subject ID, rule revision, schema version,
duplicate entries, generated/checked timestamps and expiry. Expected revisions
must come from your own catalog, not from the file being checked. Missing, invalid
or expired data yields no banner. Read/check again on clicks; do not copy an issued
URL to indefinite local storage. Keep disclosure and voluntary navigation in the
consumer UI. The helper does not approve or implement any reward policy.

## Refresh a consumer-selected workset

`plan` and `tick` accept `--workset /private/workset.json`:

```json
{
  "schemaVersion": 1,
  "appId": "word-app",
  "appRevision": 3,
  "expiresAt": 1791200000000,
  "subjectIds": ["pillow", "mug"]
}
```

Replace the example expiry with a future epoch-millisecond timestamp. The workset
is operator-owned, not a task payload or a consumer request body. It contains at
most 1000 unique enabled configured subjects in priority order, for exactly one
app. Unknown/disabled subjects, expired files and app revision mismatches fail
before enqueueing. `--app` must match the file when supplied. Empty worksets plan
an export; they do not refresh other subjects. The committed workset JSON Schema
describes the wire format, with expiry/revision checks enforced at runtime.

Worksets control refresh priority, not display authorization or immediate withdrawal.
Existing non-selected valid offers can remain until expiry. To revoke an offer,
disable/remove its configured subject, bump revisions and export, or use the
consumer kill switch. Changing a workset does not cancel already queued work.
Without a workset the existing enabled-catalog planner behavior is preserved.

## Isolated Compose E2E

```sh
bun run test:e2e:sharelink
```

The harness builds this checkout, starts two app stacks (separate Hooka queues), a
shared private/results volume, a read-only consumer and a mock provider. Workers
have only an internal network. A mounted test-only Bun preload maps the fixed
production API hosts to the mock service; production endpoints remain unchanged.
Only servers/mock control have host ingress on random loopback ports. Fake keys
are used throughout; no real Toss requests or credentials are needed.

It checks webhook deduplication, full task execution, shared OAuth/product caches,
serialized account access, separate app URLs, SIGKILL/restart recovery using real
lease expiry (no DB/clock edits), quota pause and read-only consumer access.
The crash scenario takes roughly one to two minutes. CI runs it as its own job.

If the Docker host's automatic address pools are exhausted, provide two unused
subnets with `HOOKA_SHARELINK_E2E_SUBNET` and
`HOOKA_SHARELINK_E2E_INGRESS_SUBNET`. The harness removes only its uniquely named
Compose resources and local test image. It never prunes other projects.

Remaining live checks: approved credentials and registered outbound IP, real
provider response compatibility, actual matching quality, channel registration,
issued-link opening and business metrics. Mock success cannot establish these.
