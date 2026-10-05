import { expect, test } from "bun:test";
import {
  DAY,
  configSchema,
  requestSchema,
  resultSchema,
  type Model,
} from "./contracts";
import {
  scoreRecommendations,
  sampleRecommendations,
  validateRecommendations,
} from "./engine";

const now = 30 * DAY;
function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Missing fixture value.");
  return value;
}
function fixture(sharing = false) {
  const config = configSchema.parse({
    schemaVersion: 1,
    policies: [{ policyId: "ctr", version: 1, sharing }],
    entities: [],
    apps: ["cats", "lotto"].map((appId) => ({
      appId,
      appRevision: 1,
      producerId: `${appId}-backend`,
      contexts: [
        {
          contextId: "low",
          measurementProfileId: "visible-one-second",
          learningGroupId: "shops",
          cohortId: "low",
        },
      ],
      subjects: [
        { subjectId: "mug", ruleRevision: 1, canonicalSubjectId: "mug" },
        { subjectId: "bag", ruleRevision: 1 },
      ],
    })),
  });
  const request = requestSchema.parse({
    schemaVersion: 1,
    requestId: "today",
    appId: "cats",
    appRevision: 1,
    policyId: "ctr",
    policyVersion: 1,
    kind: "subject",
    contextId: "low",
    measurementProfileId: "visible-one-second",
    generatedAt: now,
    expiresAt: now + DAY,
    seed: "repeatable",
    candidates: [
      { subjectId: "mug", ruleRevision: 1 },
      { subjectId: "bag", ruleRevision: 1 },
    ],
  });
  const model: Model = {
    schemaVersion: 1,
    modelGenerationId: "m-1",
    generatedAt: now,
    rows: [],
  };
  return { config, request, model };
}
function row(appId = "lotto", day = 25 * DAY, exposures = 100, clicks = 50) {
  return {
    appId,
    subjectId: "mug",
    ruleRevision: 1,
    mappingVersion: 1,
    contextId: "low",
    measurementProfileId: "visible-one-second",
    day,
    experiment: "training" as const,
    exposures,
    clicks,
    dispatches: 0,
  };
}

test("cold start is uniform, private, and empty sets have explicit results", () => {
  const { config, request, model } = fixture();
  const result = scoreRecommendations(config, request, model, now);
  expect(result.entries.map((e) => e.weight)).toEqual([0.5, 0.5]);
  expect(result.entries.every((e) => e.confidence === "prior")).toBe(true);
  expect(JSON.stringify(result)).not.toContain("lotto");
  expect(
    scoreRecommendations(config, { ...request, candidates: [] }, model, now)
      .reason,
  ).toBe("no-eligible-candidates");
});
test("other app evidence is isolated by default", () => {
  const { config, request, model } = fixture();
  model.rows = [
    row("lotto", 24 * DAY),
    row("lotto", 25 * DAY),
    row("lotto", 26 * DAY),
  ];
  expect(
    scoreRecommendations(config, request, model, now).entries.map(
      (e) => e.weight,
    ),
  ).toEqual([0.5, 0.5]);
});
test("approved sharing requires sample size, days, canonical mapping and matching cohort", () => {
  const { config, request, model } = fixture(true);
  model.rows = [row("lotto", 24 * DAY), row("lotto", 25 * DAY)];
  expect(
    scoreRecommendations(config, request, model, now).entries.every(
      (e) => e.confidence === "prior",
    ),
  ).toBe(true);
  model.rows.push(row("lotto", 26 * DAY));
  expect(
    scoreRecommendations(config, request, model, now).entries.find(
      (e) => e.subjectId === "mug",
    )?.confidence,
  ).toBe("shared");
  required(required(config.apps[1]).contexts[0]).cohortId = "unrelated";
  expect(
    scoreRecommendations(config, request, model, now).entries.every(
      (e) => e.confidence === "prior",
    ),
  ).toBe(true);
});
test("same subject string is not shared identity and mapping changes exclude history", () => {
  const { config, request, model } = fixture(true);
  model.rows = [
    row("lotto", 24 * DAY),
    row("lotto", 25 * DAY),
    row("lotto", 26 * DAY),
  ];
  required(required(config.apps[1]).subjects[0]).canonicalSubjectId = undefined;
  expect(
    scoreRecommendations(config, request, model, now).entries.every(
      (e) => e.confidence === "prior",
    ),
  ).toBe(true);
  required(required(config.apps[1]).subjects[0]).canonicalSubjectId = "mug";
  required(required(config.apps[1]).subjects[0]).mappingVersion = 2;
  expect(
    scoreRecommendations(config, request, model, now).entries.every(
      (e) => e.confidence === "prior",
    ),
  ).toBe(true);
});
test("holdout and unsealed evidence never train", () => {
  const { config, request, model } = fixture(true);
  model.rows = [row("cats")];
  required(model.rows[0]).experiment = "holdout";
  expect(
    scoreRecommendations(config, request, model, now).entries.map(
      (e) => e.weight,
    ),
  ).toEqual([0.5, 0.5]);
  model.rows = [row("cats", 28 * DAY)];
  expect(() => scoreRecommendations(config, request, model, now)).toThrow(
    "unsealed",
  );
});
test("local evidence dominates a bounded shared prior and exploration keeps all candidates eligible", () => {
  const { config, request, model } = fixture(true);
  model.rows = [
    row("lotto", 24 * DAY),
    row("lotto", 25 * DAY),
    row("lotto", 26 * DAY),
    row("cats", 25 * DAY, 1000, 0),
  ];
  const mug = required(
    scoreRecommendations(config, request, model, now).entries.find(
      (e) => e.subjectId === "mug",
    ),
  );
  expect(mug.confidence).toBe("local");
  expect(mug.weight).toBeGreaterThanOrEqual(0.1);
  expect(mug.weight).toBeLessThan(0.2);
});
test("model/candidate order and reruns preserve deterministic decisions and draws", () => {
  const { config, request, model } = fixture(true);
  model.rows = [
    row("lotto", 24 * DAY),
    row("lotto", 25 * DAY),
    row("lotto", 26 * DAY),
  ];
  const result = scoreRecommendations(config, request, model, now);
  const reordered = scoreRecommendations(
    config,
    { ...request, candidates: [...request.candidates].reverse() },
    { ...model, rows: [...model.rows].reverse() },
    now + 1,
  );
  expect(result).toEqual(reordered);
  const sample = sampleRecommendations(result, 3);
  expect(sample).toEqual(sampleRecommendations(reordered, 3));
  expect(sample.shortfall).toBe(1);
  expect(new Set(sample.draws.map((d) => d.candidate.subjectId)).size).toBe(2);
  expect(required(sample.draws[1]).probability).toBe(1);
});
test("consumer validation rejects stale, tampered and incomplete results", () => {
  const { config, request, model } = fixture();
  const result = scoreRecommendations(config, request, model, now);
  expect(validateRecommendations(result, request, now)).toEqual(result);
  expect(validateRecommendations(result, request, now + DAY)).toBeNull();
  expect(
    validateRecommendations({ ...result, seed: "other" }, request, now),
  ).toBeNull();
  expect(
    validateRecommendations({ ...result, entries: [] }, request, now),
  ).toBeNull();
  expect(
    validateRecommendations({ ...result, appId: "lotto" }, request, now),
  ).toBeNull();
  expect(
    resultSchema.safeParse({
      ...result,
      entries: result.entries.map((e) => ({ ...e, weight: 0.9 })),
    }).success,
  ).toBe(false);
});
test("unknown/disabled/stale candidates, invalid counts and stale models are refused", () => {
  const { config, request, model } = fixture();
  expect(() =>
    scoreRecommendations(config, { ...request, appRevision: 2 }, model, now),
  ).toThrow();
  required(required(config.apps[0]).subjects[0]).enabled = false;
  expect(() => scoreRecommendations(config, request, model, now)).toThrow();
  required(required(config.apps[0]).subjects[0]).enabled = true;
  expect(() =>
    scoreRecommendations(
      config,
      request,
      { ...model, generatedAt: now - 2 * DAY },
      now,
    ),
  ).toThrow("stale");
  expect(() =>
    scoreRecommendations(
      config,
      request,
      { ...model, rows: [row("cats", 25 * DAY, 1, 2)] },
      now,
    ),
  ).toThrow();
  expect(() =>
    sampleRecommendations(
      scoreRecommendations(config, request, model, now),
      -1,
    ),
  ).toThrow();
});
test("counter overflow and duplicate evidence cannot silently distort weights", () => {
  const { config, request, model } = fixture();
  const large = row("cats", 25 * DAY, Number.MAX_SAFE_INTEGER, 1);
  expect(() =>
    scoreRecommendations(
      config,
      request,
      { ...model, rows: [large, { ...large, day: 24 * DAY }] },
      now,
    ),
  ).toThrow("safe integer");
  expect(() =>
    scoreRecommendations(
      config,
      request,
      { ...model, rows: [row("cats"), row("cats")] },
      now,
    ),
  ).toThrow("Duplicate");
});

test("dominant contributors, incompatible profiles and old-window data cannot create a shared score", () => {
  const { config, request, model } = fixture(true);
  const third = structuredClone(required(config.apps[1]));
  third.appId = "third";
  third.producerId = "third-backend";
  config.apps.push(third);
  model.rows = [
    row("lotto", 24 * DAY, 1000, 900),
    row("lotto", 25 * DAY, 1000, 900),
    row("lotto", 26 * DAY, 1000, 900),
    row("third", 25 * DAY, 1, 0),
  ];
  expect(
    scoreRecommendations(config, request, model, now).entries.every(
      (e) => e.confidence === "prior",
    ),
  ).toBe(true);
  model.rows = [
    row("lotto", DAY),
    row("lotto", 2 * DAY),
    row("lotto", 3 * DAY),
  ];
  expect(
    scoreRecommendations(config, request, model, now).entries.every(
      (e) => e.confidence === "prior",
    ),
  ).toBe(true);
  model.rows = [
    row("lotto", 24 * DAY),
    row("lotto", 25 * DAY),
    row("lotto", 26 * DAY),
  ];
  required(required(config.apps[1]).contexts[0]).measurementProfileId =
    "different";
  for (const r of model.rows) r.measurementProfileId = "different";
  expect(
    scoreRecommendations(config, request, model, now).entries.every(
      (e) => e.confidence === "prior",
    ),
  ).toBe(true);
});

test("sampling handles zero remaining weights and refuses duplicate ranks", () => {
  const { config, request, model } = fixture();
  const result = scoreRecommendations(config, request, model, now);
  required(result.entries[0]).weight = 1;
  required(result.entries[1]).weight = 0;
  const sample = sampleRecommendations(result, 2);
  expect(sample.draws.map((d) => d.probability)).toEqual([1, 1]);
  expect(() =>
    sampleRecommendations(
      { ...result, entries: result.entries.map((e) => ({ ...e, rank: 1 })) },
      1,
    ),
  ).toThrow();
});
test("product ranking accepts multiple registered products for one subject and retains catalog identity", () => {
  const { config, request, model } = fixture();
  config.entities = [
    {
      entityRef: "mug-a",
      provider: "toss",
      catalogScope: "kr",
      productId: "1",
    },
    {
      entityRef: "mug-b",
      provider: "other",
      catalogScope: "kr",
      productId: "1",
    },
  ];
  required(required(config.apps[0]).subjects[0]).entityRefs = [
    "mug-a",
    "mug-b",
  ];
  const productRequest = {
    ...request,
    kind: "product",
    candidates: ["mug-a", "mug-b"].map((entityRef) => ({
      subjectId: "mug",
      ruleRevision: 1,
      entityRef,
    })),
  };
  model.rows = [{ ...row("cats"), entityRef: "mug-a" }];
  const result = scoreRecommendations(config, productRequest, model, now);
  expect(
    required(result.entries.find((e) => e.entityRef === "mug-a")).weight,
  ).toBeGreaterThan(
    required(result.entries.find((e) => e.entityRef === "mug-b")).weight,
  );
  expect(validateRecommendations(result, productRequest, now)).not.toBeNull();
});
