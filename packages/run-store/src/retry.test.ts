import { expect, test } from "bun:test";
import {
  createRunStore,
  RunNotFoundError,
  RunNotRetryableError,
} from "./index";

test("retrying a run keeps its target id, limits, and policy snapshot", async () => {
  const runStore = await createRunStore({
    dbPath: ":memory:",
  });
  const targetPolicy = {
    allowedProjects: ["retry-site"],
    allowedSourceRoots: ["/shared-source"],
    allowedDestinationPrefixes: [],
    allowedBranches: ["main"],
    allowedOverrideFields: [],
    requiredEnv: [],
    artifactReadiness: {
      mode: "quiet-period" as const,
      quietPeriodMs: 3_000,
      recursive: true,
    },
  };
  const queued = runStore.enqueueRun({
    taskId: "deploy.shared-volume.wrangler",
    input: {
      kind: "pages-deploy",
      project: "retry-site",
      sourcePath: "/shared-source/retry",
    },
    source: "webhook",
    capabilitySnapshot: ["wrangler"],
    targetId: "pages-main",
    targetMaxConcurrentRuns: 1,
    targetPolicy,
    maxAttempts: 5,
  });

  expect(() =>
    runStore.retryRun(queued.response.runId, { source: "api.retry" }),
  ).toThrow(RunNotRetryableError);
  expect(() => runStore.retryRun("missing", { source: "api.retry" })).toThrow(
    RunNotFoundError,
  );

  runStore.finishRun(queued.response.runId, {
    taskId: "deploy.shared-volume.wrangler",
    ok: false,
    status: "failed",
    summary: "boom",
    durationMs: 1,
  });
  const retried = runStore.retryRun(queued.response.runId, {
    source: "api.retry",
  });

  expect(retried.created).toBe(true);
  expect(retried.run).toMatchObject({
    taskId: "deploy.shared-volume.wrangler",
    source: "api.retry",
    targetId: "pages-main",
    targetMaxConcurrentRuns: 1,
    maxAttempts: 5,
    capabilitySnapshot: ["wrangler"],
  });

  const claimed = runStore.claimNextQueuedRun("worker-a", 60_000);
  expect(claimed?.id).toBe(retried.response.runId);
  expect(claimed?.targetPolicy).toEqual(targetPolicy);

  runStore.close();
});
