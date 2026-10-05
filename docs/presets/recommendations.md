# Offline recommendation engine

Implemented: strict v1 registrations, decision request/model/result contracts,
pure scoring, deterministic weighted sampling and whole-result consumer validation.
Persistence, tasks, CLI, consumer measurement adapters and live provider ordering
remain planned in the [RFC](../rfcs/shared-recommendations.md).

The engine never opens a DB, reads credentials, calls a provider, activates a
scheduler or changes an app's placement. Models supplied to this first slice are
operator-owned offline artifacts. Do not accept models or registration config
from browser/mobile clients. A model is trusted measurement input, not proof that
its counts were observed; the ingestion/assignment-verification slice will own
that verification.

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

Focused checks: `bun test packages/pack-recommendations/src/engine.test.ts`.
The existing Sharelink config/offer/workset v1 files are unchanged. Manual links,
pinned products, provider budgets and existing refresh scheduling are unaffected.
