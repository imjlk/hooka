import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DAY, configSchema, requestSchema } from "./contracts";
import { sampleRecommendations } from "./engine";
import { RecommendationStore } from "./store";
import { publishDecision, readArtifact, readPublishedDecision } from "./files";

const start = 20 * DAY;
const required = <T>(value: T | undefined): T => {
  if (value === undefined) throw Error("Missing fixture");
  return value;
};
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "hooka-recommendation-store-"));
  const path = join(root, "private.sqlite");
  const config = configSchema.parse({
    schemaVersion: 1,
    entities: [],
    policies: [{ policyId: "ctr", version: 1 }],
    apps: [
      {
        appId: "cats",
        appRevision: 1,
        producerId: "cats-backend",
        contexts: [{ contextId: "low", measurementProfileId: "visible" }],
        subjects: [
          { subjectId: "mug", ruleRevision: 1 },
          { subjectId: "bag", ruleRevision: 1 },
        ],
      },
    ],
  });
  const request = requestSchema.parse({
    schemaVersion: 1,
    requestId: "day-20",
    appId: "cats",
    appRevision: 1,
    policyId: "ctr",
    policyVersion: 1,
    contextId: "low",
    measurementProfileId: "visible",
    kind: "subject",
    generatedAt: start,
    expiresAt: start + DAY,
    seed: "known",
    candidates: [
      { subjectId: "mug", ruleRevision: 1 },
      { subjectId: "bag", ruleRevision: 1 },
    ],
  });
  const store = await RecommendationStore.open(path);
  store.build(config, start);
  const result = store.recordDecision(config, request, start);
  const draw = required(sampleRecommendations(result, 1).draws[0]);
  const assignment = {
    assignmentId: "assignment-20",
    decisionId: result.decisionId,
    ...draw.candidate,
    mappingVersion: 1,
    contextId: "low",
    measurementProfileId: "visible",
    startsAt: start,
    endsAt: start + DAY,
    experiment: "training",
    application: "sampler",
    appliedProbability: draw.probability,
  };
  const manifest = {
    schemaVersion: 1,
    manifestId: "manifest-20",
    producerId: "cats-backend",
    appId: "cats",
    appRevision: 1,
    generatedAt: start,
    assignments: [assignment],
  };
  const aggregate = {
    schemaVersion: 1,
    producerId: "cats-backend",
    appId: "cats",
    measurementProfileId: "visible",
    periodStart: start,
    periodEnd: start + DAY,
    revision: 1,
    generatedAt: start + DAY,
    rows: [
      {
        assignmentId: assignment.assignmentId,
        exposures: 100,
        clicks: 20,
        dispatches: 5,
      },
    ],
  };
  return {
    root,
    path,
    config,
    request,
    store,
    result,
    manifest,
    aggregate,
    assignment,
    cleanup: () => {
      store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("complete aggregate replacement, retry and correction never increment counts twice", async () => {
  const f = await fixture();
  try {
    expect(f.store.ingestManifest(f.config, f.manifest, start).status).toBe(
      "applied",
    );
    expect(f.store.ingestManifest(f.config, f.manifest, start).status).toBe(
      "duplicate",
    );
    expect(
      f.store.ingestAggregate(f.config, f.aggregate, start + DAY).status,
    ).toBe("applied");
    expect(
      f.store.ingestAggregate(f.config, f.aggregate, start + DAY).status,
    ).toBe("duplicate");
    expect(f.store.build(f.config, start + 2 * DAY).rows).toEqual([]);
    expect(
      required(f.store.build(f.config, start + 3 * DAY).rows[0]).exposures,
    ).toBe(100);
    const correction = {
      ...f.aggregate,
      revision: 2,
      rows: [{ ...required(f.aggregate.rows[0]), exposures: 50, clicks: 10 }],
    };
    expect(
      f.store.ingestAggregate(f.config, correction, start + 3 * DAY).status,
    ).toBe("applied");
    expect(
      required(f.store.build(f.config, start + 3 * DAY).rows[0]).exposures,
    ).toBe(50);
    expect(
      f.store.ingestAggregate(f.config, f.aggregate, start + 3 * DAY).status,
    ).toBe("stale");
    expect(() =>
      f.store.ingestAggregate(
        f.config,
        { ...correction, rows: [] },
        start + 3 * DAY,
      ),
    ).toThrow("Conflicting");
  } finally {
    f.cleanup();
  }
});
test("whole-day empty correction removes old contributions and does not turn missing days into exposure", async () => {
  const f = await fixture();
  try {
    f.store.ingestManifest(f.config, f.manifest, start);
    f.store.ingestAggregate(f.config, f.aggregate, start + DAY);
    f.store.ingestAggregate(
      f.config,
      { ...f.aggregate, revision: 2, rows: [] },
      start + 3 * DAY,
    );
    expect(f.store.build(f.config, start + 3 * DAY).rows).toEqual([]);
    expect(
      required(f.store.status(start + 3 * DAY).coverage[0]).missingDays,
    ).toBe(13);
  } finally {
    f.cleanup();
  }
});
test("unknown producer/assignment, wrong window/profile and invalid counts reject the entire batch", async () => {
  const f = await fixture();
  try {
    expect(() =>
      f.store.ingestManifest(
        f.config,
        { ...f.manifest, producerId: "intruder" },
        start,
      ),
    ).toThrow("producer");
    expect(() =>
      f.store.ingestAggregate(f.config, f.aggregate, start + DAY),
    ).toThrow("Unknown assignment");
    f.store.ingestManifest(f.config, f.manifest, start);
    expect(() =>
      f.store.ingestAggregate(
        f.config,
        {
          ...f.aggregate,
          rows: [{ ...required(f.aggregate.rows[0]), clicks: 101 }],
        },
        start + DAY,
      ),
    ).toThrow();
    expect(() =>
      f.store.ingestAggregate(
        f.config,
        {
          ...f.aggregate,
          periodStart: start + DAY,
          periodEnd: start + 2 * DAY,
          generatedAt: start + 2 * DAY,
        },
        start + 2 * DAY,
      ),
    ).toThrow("overlap");
    expect(() =>
      f.store.ingestAggregate(
        f.config,
        { ...f.aggregate, measurementProfileId: "unknown" },
        start + DAY,
      ),
    ).toThrow("profile");
    expect(f.store.status(start + DAY).counts["rec_snapshots"]).toBe(0);
  } finally {
    f.cleanup();
  }
});
test("manifest conflicts and partially valid assignments roll back atomically", async () => {
  const f = await fixture();
  try {
    const bad = {
      ...f.assignment,
      assignmentId: "bad",
      decisionId: "missing",
      application: "constrained",
      appliedProbability: null,
    };
    expect(() =>
      f.store.ingestManifest(
        f.config,
        { ...f.manifest, assignments: [f.assignment, bad] },
        start,
      ),
    ).toThrow("Unknown decision");
    expect(f.store.status(start).counts["rec_assignments"]).toBe(0);
    f.store.ingestManifest(f.config, f.manifest, start);
    expect(() =>
      f.store.ingestManifest(
        f.config,
        { ...f.manifest, generatedAt: start + 1 },
        start + 1,
      ),
    ).toThrow("immutable");
  } finally {
    f.cleanup();
  }
});
test("sampler assignment tail selection and probabilities must replay the selected prefix", async () => {
  const f = await fixture();
  try {
    const tail = required(sampleRecommendations(f.result, 2).draws[1]);
    expect(() =>
      f.store.ingestManifest(
        f.config,
        {
          ...f.manifest,
          assignments: [
            {
              ...f.assignment,
              ...tail.candidate,
              appliedProbability: tail.probability,
            },
          ],
        },
        start,
      ),
    ).toThrow("prefix");
    expect(() =>
      f.store.ingestManifest(
        f.config,
        {
          ...f.manifest,
          assignments: [{ ...f.assignment, appliedProbability: 0.9 }],
        },
        start,
      ),
    ).toThrow("prefix");
  } finally {
    f.cleanup();
  }
});
test("read-only plan/status preserve state and missing/foreign databases are never initialized", async () => {
  const f = await fixture();
  try {
    const read = await RecommendationStore.open(f.path, true);
    try {
      const before = read.status(start);
      expect(read.plan(f.config, f.request, start)).toEqual(f.result);
      expect(read.status(start)).toEqual(before);
      expect(() => read.build(f.config, start)).toThrow("read-only");
    } finally {
      read.close();
    }
    await expect(
      RecommendationStore.open(join(f.root, "missing", "db"), true),
    ).rejects.toThrow();
    expect(await Bun.file(join(f.root, "missing", "db")).exists()).toBe(false);
    const otherPath = join(f.root, "consumer.sqlite"),
      other = new Database(otherPath);
    other.exec("CREATE TABLE users(id INTEGER)");
    other.close();
    await expect(RecommendationStore.open(otherPath)).rejects.toThrow(
      "Not a recommendation",
    );
    const check = new Database(otherPath, { readonly: true });
    expect(check.query("PRAGMA user_version").get()).toEqual({
      user_version: 0,
    });
    check.close();
  } finally {
    f.cleanup();
  }
});
test("registration versions, producer identity, context semantics and removed subject reuse are pinned", async () => {
  const f = await fixture();
  try {
    const changed = structuredClone(f.config);
    required(changed.policies[0]).epsilon = 0.5;
    expect(() => f.store.build(changed, start)).toThrow("revision");
    const producer = structuredClone(f.config);
    required(producer.apps[0]).appRevision = 2;
    required(producer.apps[0]).producerId = "new-backend";
    expect(() => f.store.build(producer, start)).toThrow("rebinding");
    const context = structuredClone(f.config);
    required(context.apps[0]).appRevision = 2;
    required(required(context.apps[0]).contexts[0]).cohortId = "low";
    required(required(context.apps[0]).contexts[0]).learningGroupId = "new";
    expect(() => f.store.build(context, start)).toThrow("context ID");
    const removed = structuredClone(f.config);
    required(removed.apps[0]).appRevision = 2;
    required(removed.apps[0]).subjects = [];
    f.store.build(removed, start + 1);
    const reused = structuredClone(f.config);
    required(reused.apps[0]).appRevision = 3;
    required(required(reused.apps[0]).subjects[0]).canonicalSubjectId =
      "new-intent";
    expect(() => f.store.build(reused, start + 2)).toThrow("mapping version");
    expect(() => f.store.build(f.config, start + 2)).toThrow("Stale");
  } finally {
    f.cleanup();
  }
});
test("historical corrections retain old lineage after a rule change and do not contaminate current scores", async () => {
  const f = await fixture();
  try {
    f.store.ingestManifest(f.config, f.manifest, start);
    f.store.ingestAggregate(f.config, f.aggregate, start + DAY);
    const next = structuredClone(f.config);
    required(next.apps[0]).appRevision = 2;
    for (const s of required(next.apps[0]).subjects) s.ruleRevision = 2;
    f.store.build(next, start + 3 * DAY);
    expect(
      f.store.ingestAggregate(
        next,
        { ...f.aggregate, revision: 2 },
        start + 3 * DAY,
      ).status,
    ).toBe("applied");
    expect(f.store.build(next, start + 3 * DAY).rows).toEqual([]);
  } finally {
    f.cleanup();
  }
});
test("pruning rejects ancient replay and makes a pruned current generation unavailable", async () => {
  const f = await fixture();
  try {
    f.store.ingestManifest(f.config, f.manifest, start);
    f.store.ingestAggregate(f.config, f.aggregate, start + DAY);
    expect(f.store.prune(start + 200 * DAY).prunedDays).toBe(1);
    expect(() =>
      f.store.ingestAggregate(f.config, f.aggregate, start + 200 * DAY),
    ).toThrow("pruned");
    expect(f.store.status(start + 200 * DAY).currentModel).toBeNull();
  } finally {
    f.cleanup();
  }
});

test("clock regression and failed registration keep the last complete model", async () => {
  const f = await fixture();
  try {
    const before = f.store.status(start);
    expect(() => f.store.build(f.config, start - 1)).toThrow("clock regressed");
    const invalid = structuredClone(f.config);
    required(invalid.policies[0]).epsilon = 0.7;
    expect(() => f.store.build(invalid, start + 1)).toThrow("revision");
    expect(f.store.status(start)).toEqual(before);
  } finally {
    f.cleanup();
  }
});

test("concurrent preparations publish complete files and preserve the newest pointer", async () => {
  const f = await fixture();
  try {
    const nextRequest = { ...f.request, generatedAt: start + 1, seed: "next" };
    const next = f.store.recordDecision(f.config, nextRequest, start + 1);
    const out = join(f.root, "parallel"),
      commit = (action: () => void) => f.store.commitPublication(action);
    const results = await Promise.allSettled([
      publishDecision(out, f.result, f.request, start + 1, commit),
      publishDecision(out, next, nextRequest, start + 1, commit),
    ]);
    expect(
      results.filter((r) => r.status === "fulfilled").length,
    ).toBeGreaterThanOrEqual(1);
    expect(await readPublishedDecision(out, nextRequest, start + 1)).toEqual(
      next,
    );
  } finally {
    f.cleanup();
  }
});
test("publication is request-scoped, immutable, retryable and cannot regress a pointer", async () => {
  const f = await fixture();
  try {
    const out = join(f.root, "out"),
      commit = (action: () => void) => f.store.commitPublication(action);
    const pointer = await publishDecision(
      out,
      f.result,
      f.request,
      start,
      commit,
    );
    expect(
      await publishDecision(out, f.result, f.request, start, commit),
    ).toEqual(pointer);
    expect(await readPublishedDecision(out, f.request, start)).toEqual(
      f.result,
    );
    const newerRequest = {
      ...f.request,
      generatedAt: start + 1,
      expiresAt: start + DAY,
      seed: "new",
    };
    const newer = f.store.recordDecision(f.config, newerRequest, start + 1);
    await publishDecision(out, newer, newerRequest, start + 1, commit);
    await expect(
      publishDecision(out, f.result, f.request, start + 1, commit),
    ).rejects.toThrow("newer");
    const latest = await readArtifact(
      join(
        out,
        "cats",
        "requests",
        f.request.requestId,
        "recommendations.json",
      ),
      4096,
    );
    expect(latest).toMatchObject({ decisionId: newer.decisionId });
    expect(await readPublishedDecision(out, f.request, start + 1)).toBeNull();
    await expect(
      publishDecision(
        out,
        { ...newer, inputDigest: "0".repeat(64) },
        newerRequest,
        start + 1,
        commit,
      ),
    ).rejects.toThrow("invalid");
  } finally {
    f.cleanup();
  }
});
