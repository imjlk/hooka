# Sharelink recommendation extension

Requires Hooka **1.5.1+**. This compatible preset extension uses a patch changeset.
Existing Sharelink config/offer/workset v1 contracts, queue behavior and default
matching remain unchanged. No provider approval, scheduler or live ranking is
enabled by installing the image or running an offline preview.

## One worker is sufficient

A preset selects capabilities/task packs; it is not a running container.
`toss-sharelink` already includes the `recommendations` CLI in the same worker
image. The same worker can perform product operations and local recommendation
operations. Keep the queue, Sharelink state and recommendation learning DB in
three distinct private files. Never point them at a consumer database.

The optional [Compose overlay](../../examples/toss-sharelink/compose.recommendations.yml)
adds mounts/environment to `sharelink-worker`. It creates **no additional service**.
An existing webhook server or consumer importer keeps its existing role. A
separate recommendation worker is optional when workload or host ownership calls
for it; it is not required just because the code is a separate task pack.

Set `HOOKA_VERSION=1.5.1` (or a reviewed newer released patch) in the owning stack's
protected `.env`, and set `RECOMMENDATIONS_CONFIG_DIR` to its operator config
directory. After the existing model volume and bindings are prepared, validate
the combined configuration without printing expanded secrets:

```sh
docker compose -f compose.yml -f compose.recommendations.yml config --quiet
```

This validates configuration only; it starts no container or scheduled operation.

Hooka 1.5.2+ includes [queued recommendation tasks](./recommendation-tasks.md)
in a reusable pack in this worker's preset using the existing queue/registry.
They require separate explicit enablement and are not automatically scheduled.
Operators can also run the existing recommendation CLI in that worker. Use one owning
model updater per learning group; readers can share its local SQLite database.
Across Docker hosts, use the future scoped artifact transport rather than network
mounting SQLite. Same-host access does not itself activate cross-app learning.

The model volume is writable for SQLite WAL side files. Ordering opens it
read-only, never initializes it and never inserts decisions, evidence or budgets.
Restrict the private volume to trusted workers. Consumer apps receive only their
outbox, not this volume. Config bindings are mounted read-only. A model updater
can use the same owning worker's CLI without another container.

## Bind two independent revision namespaces

The app backend may maintain recommendation revisions separately from its
Sharelink rule/app revisions. Do not infer equality from matching numbers.
An operator-owned `sharelink-bindings.json` binds both namespaces explicitly:

```json
{
  "schemaVersion": 1,
  "apps": [{
    "appId": "word-app",
    "sharelinkRevision": 1,
    "recommendationRevision": 7,
    "policyId": "ctr",
    "policyVersion": 1,
    "contextId": "low-ready",
    "measurementProfileId": "word-full-1s-v1",
    "catalogScope": "kr",
    "subjects": [{
      "subjectId": "pillow",
      "sharelinkRuleRevision": 1,
      "recommendationRuleRevision": 9
    }]
  }]
}
```

IDs and revisions are illustrative; use independently approved current values.
The recommendation registration must contain the same enabled app/subject,
context/profile, policy version and reviewed entity references. Product identity
is `(toss-sharelink, catalogScope, productId)`. Equal numeric IDs in another scope
or provider do not match. Bindings do not grant learning-group membership or
enable sharing; that remains the existing recommendation policy's explicit opt-in.

Set trusted absolute paths to existing local files:

```sh
export HOOKA_SHARELINK_RECOMMENDATIONS_BINDINGS_PATH=/private/recommendation-config/sharelink-bindings.json
export HOOKA_RECOMMENDATIONS_CONFIG_PATH=/private/recommendation-config/config.json
export HOOKA_RECOMMENDATIONS_DB_PATH=/private/recommendation-private/learning.sqlite
# Run the fixture preview without provider keys or network calls.
hooka sharelink preview --config /private/sharelink-config/config.json --app word-app --fixture /private/catalog.fixture.json --ranked
```

`--ranked` explicitly applies the extension to this offline preview only.
Without that flag, the preview stays lexical even if runtime ordering is enabled.
The runtime flag `HOOKA_SHARELINK_RECOMMENDATIONS_ENABLED` defaults off; only exact
`true` activates it. Do not enable live refresh until provider approval, actual
consumer identities, model freshness and the preview have been verified.

## What can be reordered

Existing category/keyword/exclusion, stock and expiry rules filter each already
fetched page. Reviewed manual links and pinned products bypass ranking. The
recommendation engine scores only registered products on that page. It reorders
those products within their original slots; unknown products retain their slots
and equal weights retain provider order. New/unknown products are not pushed to
the end merely because they lack measurements.

Ranking happens before the three-detail-attempt limit. It can therefore select a
better registered product that was fourth on the observed page, while the maximum
three detail/issuance attempts, configured page limit, provider reservations and
cache/link TTLs are unchanged. It never fetches extra candidates to train a model,
searches unseen pages for a global best product or relaxes a rejected rule.
Fresh product details are still rechecked after ordering.

Missing/corrupt configuration, stale binding, foreign/missing DB or stale model
falls back to baseline page order. Failure to rank does not withdraw valid offers.
Opt-in refresh inspections and ranked preview emit bounded ordering diagnostics:
`binding-mismatch`, `unavailable-model-or-config`, `no-registered-products`,
`uniform-prior`, or `scored-known-subset`. They contain model/decision IDs and
candidate counts, not credentials or evidence from other apps.

This adapter uses deterministic score ordering, not the weighted sampler. Its
diagnostic decision ID is an ephemeral preview identity, not a recorded consumer
assignment or proof that a link was clicked. Consumer manifests must continue to
describe actual applied assignments with their own reviewed measurement context.

## Refresh demand and priority preview

The app backend produces an expiring demand file from intended exposure, not raw
mobile input. Only registered enabled subjects with matching Sharelink app/rule
revisions are accepted. Context/profile IDs are audit labels supplied by that
trusted backend; this planner does not learn or compare CTR across contexts.

```json
{
  "schemaVersion": 1,
  "generatedAt": 1800000000000,
  "expiresAt": 1800000600000,
  "seed": "reviewed-day-seed",
  "policy": {
    "policyId": "refresh-priority",
    "version": 1,
    "maxSubjectsPerApp": 25,
    "explorationFraction": 0.2,
    "urgentWithinMs": 300000,
    "maxWaitMs": 86400000
  },
  "apps": [{
    "appId": "word-app",
    "appRevision": 1,
    "contextId": "low-ready",
    "measurementProfileId": "word-full-1s-v1",
    "subjects": [{"subjectId": "pillow", "ruleRevision": 1, "estimatedReach": 15}]
  }]
}
```

Replace sample timestamps with a current generated time and future expiry
(lifetime at most 24 hours). Version the operator policy when changing its meaning.

```sh
hooka sharelink priority --config /private/sharelink-config/config.json --domain /private/sharelink.sqlite --results /private/sharelink-results --demand /private/refresh-demand.json
```

The command reads existing snapshots/account budgets and outputs a complete JSON
preview. It opens no queue, initializes no database, writes no workset and calls
no provider. Each `apps[].workset` is the existing v1 format for manual handoff
after review. Its expiry is bounded by demand expiry, the next KST budget reset
and 15 minutes, and by any selected manual review deadline to keep its zero-cost
estimate current at handoff. Existing `plan`/`tick --workset` behavior is unchanged.

Demand with missing/near-expiry offers is urgent; ties favor overdue observations,
greater estimated reach and earlier expiry. A seeded five-minute bucket resolves
remaining ties and rotates exploration among zero-demand eligible subjects.
Exploration reserves 20% of capacity/cost by default before demand consumes it.
Fractional slots rotate deterministically, so a one-slot limit does not reserve
every run for exploration. Unused capacity may be filled by exploration. Setting
`explorationFraction=0` disables that selection. Manual mappings remain eligible
during account cooldown with zero estimated provider cost.

All configured apps participate in preview account allocation, including apps
without a demand entry (exploration only). Equal shares are the default. To change
them, set `policy.accountShares` to an array of
`{"accountId":"example-partner","apps":[{"appId":"word-app","weight":3},{"appId":"second-app","weight":1}]}`.
List every configured member of each overridden account exactly once; weights
are integers 1–100. Unused shares and integer-rounding remainders are not redistributed.

Cold-cache estimates are conservative **product-return budget units**, not HTTP
request counts: automatic subject `30 × maxCatalogPages + 3` products / 3 links;
pinned subject 1 product / 1 link; current reviewed manual mapping 0 / 0. Cache
reuse can reduce actual costs. With no domain DB, `budgetEvidence` is
`configured-upper-bound`; an existing store supplies `observed` remaining budgets.
Unknown or stale account budget statuses are rejected.

Output reports `dispatchEnabled=false`, `budgetReservations=false`,
`waitBoundEnforced=false`, selected reasons, estimates and deferred subjects
(`capacity`, `account-share-budget`, `account-cooldown`). `maxWaitMs` reports
overdue observations only: it cannot guarantee a refresh by that deadline.
Fairness is limited to this configuration's preview; separate queues/stacks may
consume the same account afterward. Actual budget-fair dispatch remains a later
opt-in stage. Do not wire this preview into a live scheduler implicitly.
Already queued jobs can outlive a workset; the preview does not fence their start
time or prevent a later automatic fallback after a manual review expires.

To roll back ordering, set its flag to false and restart the owning worker.
Existing valid snapshots expire or are replaced by the normal refresh path;
learning history, consumer towers and manual mappings are retained.

Schemas are in `docs/contracts/toss-sharelink/extensions/v1/`. Regenerate with
`bun run sharelink:schemas`; existing `v1/` files remain unchanged.
