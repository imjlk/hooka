# Offline recommendation engine

Implemented: strict v1 registrations, decision request/model/result contracts,
pure scoring, deterministic weighted sampling, private aggregate/assignment store,
offline CLI and whole-result consumer validation. Queued tasks, consumer measurement
adapters and live provider ordering remain planned in the
[RFC](../rfcs/shared-recommendations.md).

The pure scoring engine has no I/O. Offline operations open only their explicitly
initialized private recommendation DB. They never read provider credentials, call
a provider, activate a scheduler or change an app's placement. Inputs are
operator-owned artifacts from registered app backends; do not accept registrations
or aggregate counts directly from browser/mobile clients. Assignment verification
checks identity, decisions, timing and sampler probabilities; actual viewport and
visit deduplication remain the responsibility of each app measurement adapter.

## Use

```ts
import {
  scoreRecommendations,
  sampleRecommendations,
  validateRecommendations,
} from "@hooka/pack-recommendations";

const result = scoreRecommendations(config, request, model, now);
const accepted = validateRecommendations(result, request, now);
// If accepted is null, use the app's baseline constrained selection.
const selection = accepted ? sampleRecommendations(accepted, 4) : null;
// The app enforces its approved candidates, difficulty and placement rules.
```

`now` is integer epoch milliseconds. Request lifetime is at most 24 hours and a
model must have been generated within the previous 24 hours. The window contains
14 UTC days sealed at least 48 hours before model generation. Holdout observations
are excluded. Current subject rule/mapping lineage must match before evidence
can affect scoring; historical rows stay available for audit but are not relabeled.

Registrations list app/producers, policies, approved subjects, contexts and opaque
provider/product entity references. An equal subject string across apps grants
no sharing. Sharing defaults off. Opt-in requires an operator-mapped learning
group/cohort and the same measurement profile, plus a reviewed common subject
identity or registered product identity. Different providers/catalog scopes
cannot reuse one entity reference.

Counts must be safe integers with dispatches <= clicks <= exposures. Duplicate
model rows, unsealed rows, unknown registrations and overflowing accumulated
counts reject the input. Invalid, disabled or stale request candidates also reject
the entire request; it never silently invents or substitutes a candidate.

The initial fixed prior is Beta(1,19), with 20% uniform exploration. Other-app
evidence requires 200 exposed opportunities across three distinct sealed days.
One other app contributes at most five equivalent prior exposures; multiple
other apps contribute at most 20 and must pass the 80% dominance gate. Operator
policy parameters are versioned and bounded. Local evidence updates this prior.
These defaults are trial values, not learned optimal thresholds.

## Offline operations

Use `bun apps/cli/src/index.ts recommendations <command>` or the built `hooka`
CLI. All commands emit JSON. Set `HOOKA_RECOMMENDATIONS_CONFIG_PATH`,
`HOOKA_RECOMMENDATIONS_DB_PATH`, `HOOKA_RECOMMENDATIONS_RESULTS_PATH`, or pass
`--config`, `--domain`, `--results`. The domain path must be a dedicated local
SQLite file; the app outbox is a local directory on the same host.

```sh
hooka recommendations validate --config /private/recommendations/config.json
hooka recommendations init --domain /private/recommendations/learning.sqlite
hooka recommendations build --config /private/recommendations/config.json --domain /private/recommendations/learning.sqlite
hooka recommendations plan --config /private/recommendations/config.json --domain /private/recommendations/learning.sqlite --artifact /private/recommendations/request.json
hooka recommendations export --config /private/recommendations/config.json --domain /private/recommendations/learning.sqlite --artifact /private/recommendations/request.json --results /private/recommendation-outboxes
hooka recommendations ingest --config /private/recommendations/config.json --domain /private/recommendations/learning.sqlite --kind manifest --artifact /private/recommendations/assignments.json
hooka recommendations ingest --config /private/recommendations/config.json --domain /private/recommendations/learning.sqlite --kind aggregate --artifact /private/recommendations/day.json
hooka recommendations status --domain /private/recommendations/learning.sqlite
hooka recommendations prune --domain /private/recommendations/learning.sqlite
```

Initialize explicitly. `validate` needs no DB; `status` and `plan` open existing
stores read-only and never initialize/migrate them. A missing or foreign DB is
rejected. The store checks an application marker and schema version before
changing journaling/permissions. Writable stores use local WAL transactions and
mode 0600. Grant app backends only their inbox/outbox permissions, never the DB.

`export` records the complete immutable decision before publishing. Files live in
`<results>/<appId>/requests/<requestId>/`: `decisions/<decisionId>.json` is
immutable and `recommendations.json` is the small pointer. Use unique request IDs
for different dates/contexts. One learning-group DB owns an outbox root. CLI
publishers use its SQLite writer lock for the synchronous pointer read/check/rename;
older or conflicting pointers cannot replace a newer result. Failed publication
can be retried against the recorded decision. Consumer backends can use
`readPublishedDecision(root, expectedRequest, now)`; missing/corrupt/mismatched
files return null. POSIX local filesystems are required; SQLite/atomic files are
not a cross-host transport. Outbox directories/files are private by default;
configure matching service UID or approved local file access before deployment.

Assignment manifests are immutable and app/producer-bound. A decision must already
be recorded, match app revision/context/profile, and be valid when assignment starts.
An assignment window is at most 24 hours. The sampler mode verifies the complete
selected prefix across all stored and incoming manifests for that decision,
distinct candidates, one experiment and conditional draw probabilities; holdout
sampler decisions must be uniform. Constrained/fallback modes are observational
and do not prove randomized exposure, even if a probability is provided.

Daily aggregates are complete UTC-day snapshots (up to 10,000 rows / 8 MiB).
The CLI does not accept an in-progress current day. Completed but not yet sealed
days can be ingested; only days whose end is at least 48 hours old enter a model.
Rows must reference known assignments overlapping the day/profile. Same revision
and semantic digest is a no-op; conflicting same revisions fail; lower revisions
are stale. A higher revision replaces the whole day, including removal of rows.
No retry adds counts. Historical corrections keep their immutable assignment
lineage and do not acquire today's rule/mapping meaning.

App revisions cannot move backwards. Producer identities and entity references
cannot be rebound. Changed context semantics require a new context ID; changed
canonical subject meaning requires a larger mapping version, including after
removal/reintroduction. Policy versions are immutable. New registration requires
building a model before planning; status exposes configuration mismatch, freshness
and 14-day coverage. Missing days are unavailable evidence, not measured zero CTR.

`build` streams joined assignment evidence with a day index and registration maps,
then atomically commits a complete immutable model and current pointer. Limits:
one million source assignment rows and 100,000 derived evidence rows per build.
Overflow/validation/clock-regression failure retains the previous generation.
Scope the learning group if it exceeds these limits; no live requests join app
analytics DBs. `prune` removes aggregates older than 90 UTC days and models,
decisions/manifests/assignments/tombstones older than 120 days. Registration
identity bindings remain private to prevent rebinding. Ancient days are rejected
by their period even after a replay tombstone is pruned.

Subject requests require distinct subjects. Product requests can contain several
approved entity references for one subject. Weights are normalized within that
request/context; rank is a stable score ordering and is not a conversion rate.
No counts, credentials, URLs or other-app identities appear in consumer results.

Sampling sorts candidate keys bytewise and uses SHA-256 of the sampler version,
seed, decision ID and draw counter to produce a 52-bit uniform value. Each draw
renormalizes remaining weights. If only zero-weight candidates remain, selection
is uniform. It returns actual conditional probabilities and an explicit shortfall.
The sampler itself permits replay of historic decisions for audit; consumers
must validate expiry against the expected request before applying a result.
Reordering candidates or evidence rows preserves the decision and draws. Changes
to policy/registration/model/request evidence change its deterministic decision ID.

Consumers validate the exact normalized request digest, revisions, identities,
seed, candidate completeness, ranks, finite weights, lifetime and timestamps.
The file transport must already be app-owned/authenticated: validation does not
verify a network signature or an independently expected model generation. Consumers
persist accepted decision IDs/model generations when adding delivery replay guards.

## Contracts and checks

JSON Schemas live in `docs/contracts/recommendations/v1/`. Regenerate with
`bun run scripts/generate-recommendation-schemas.ts`. Cross-field uniqueness,
count relationships, lifetime and normalized-weight checks also run in Zod.
Do not infer those guarantees from structural JSON Schema alone.

Focused checks: `bun test packages/pack-recommendations apps/cli/src/commands/recommendations.test.ts`.
The existing Sharelink config/offer/workset v1 files are unchanged. Manual links,
pinned products, provider budgets and existing refresh scheduling are unaffected.
