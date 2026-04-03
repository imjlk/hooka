import { expect, test } from "bun:test";
import { createRunStore } from "./index";

test("enqueue run stores queued record and queued event", async () => {
  const runStore = await createRunStore({
    dbPath: ":memory:",
    now: () => new Date("2026-03-26T00:00:00.000Z"),
  });

  const queued = runStore.enqueueRun({
    taskId: "deploy.shared-volume.wrangler",
    input: {
      kind: "pages-deploy",
      project: "staging-site",
      sourcePath: "/shared-source/simply-static",
    },
    source: "test",
    capabilitySnapshot: ["wrangler"],
  });

  expect(queued.response.status).toBe("queued");
  expect(queued.run.events.map((event) => event.type)).toEqual(["queued"]);

  runStore.close();
});

test("duplicate source event id returns the existing run", async () => {
  const runStore = await createRunStore({
    dbPath: ":memory:",
  });

  const first = runStore.enqueueRun({
    taskId: "deploy.shared-volume.wrangler",
    input: {
      kind: "pages-deploy",
      project: "main-site",
      sourcePath: "/shared-source/simply-static",
    },
    source: "wordpress.webhook.simply-static",
    sourceEventId: "evt_123",
    capabilitySnapshot: [],
  });
  const second = runStore.enqueueRun({
    taskId: "deploy.shared-volume.wrangler",
    input: {
      kind: "pages-deploy",
      project: "main-site",
      sourcePath: "/shared-source/simply-static",
    },
    source: "wordpress.webhook.simply-static",
    sourceEventId: "evt_123",
    capabilitySnapshot: [],
  });

  expect(second.created).toBe(false);
  expect(second.response.runId).toBe(first.response.runId);

  runStore.close();
});

test("expired running runs are requeued and attempt count increments", async () => {
  let now = new Date("2026-03-26T00:00:00.000Z");
  const runStore = await createRunStore({
    dbPath: ":memory:",
    now: () => now,
  });

  const queued = runStore.enqueueRun({
    taskId: "deploy.shared-volume.wrangler",
    input: {
      kind: "pages-deploy",
      project: "staging-site",
      sourcePath: "/shared-source/simply-static",
    },
    source: "test",
    capabilitySnapshot: [],
  });

  const claimed = runStore.claimNextQueuedRun("worker-a", 1_000);
  expect(claimed?.id).toBe(queued.response.runId);

  now = new Date("2026-03-26T00:00:03.000Z");
  expect(runStore.requeueExpiredRuns()).toBe(1);

  const run = runStore.getRun(queued.response.runId);
  expect(run?.status).toBe("queued");
  expect(run?.attemptCount).toBe(1);
  expect(run?.events.some((event) => event.type === "requeued")).toBe(true);

  runStore.close();
});

test("queryRuns filters by status, taskId, and source", async () => {
  const runStore = await createRunStore({
    dbPath: ":memory:",
  });

  const queuedOne = runStore.enqueueRun({
    taskId: "deploy.shared-volume.wrangler",
    input: {
      kind: "pages-deploy",
      project: "staging-site",
      sourcePath: "/shared-source/simply-static",
    },
    source: "wordpress.webhook",
    capabilitySnapshot: [],
  });
  const queuedTwo = runStore.enqueueRun({
    taskId: "cloudflare.cache.purge.urls",
    input: {
      zoneId: "zone-1",
      urls: "https://example.com/",
    },
    source: "cli",
    capabilitySnapshot: [],
  });

  runStore.finishRun(queuedOne.response.runId, {
    taskId: "deploy.shared-volume.wrangler",
    ok: true,
    status: "succeeded",
    summary: "done",
    durationMs: 1,
  });

  const succeeded = runStore.queryRuns({
    status: "succeeded",
  });
  const byTask = runStore.queryRuns({
    taskId: "cloudflare.cache.purge.urls",
  });
  const bySource = runStore.queryRuns({
    source: "wordpress.webhook",
  });

  expect(succeeded).toHaveLength(1);
  expect(succeeded[0]?.id).toBe(queuedOne.response.runId);
  expect(byTask).toHaveLength(1);
  expect(byTask[0]?.id).toBe(queuedTwo.response.runId);
  expect(bySource).toHaveLength(1);
  expect(bySource[0]?.id).toBe(queuedOne.response.runId);

  runStore.close();
});

test("queryRuns rejects invalid status filters", async () => {
  const runStore = await createRunStore({
    dbPath: ":memory:",
  });

  expect(() =>
    runStore.queryRuns({
      status: "bogus" as never,
    }),
  ).toThrow();

  runStore.close();
});

test("scheduleRetry keeps the run queued with a future retry time", async () => {
  const runStore = await createRunStore({
    dbPath: ":memory:",
  });

  const queued = runStore.enqueueRun({
    taskId: "deploy.shared-volume.wrangler",
    input: {
      kind: "pages-deploy",
      project: "retry-site",
      sourcePath: "/shared-source/retry-site",
    },
    source: "test",
    capabilitySnapshot: ["wrangler"],
  });

  runStore.scheduleRetry(
    queued.response.runId,
    {
      taskId: "deploy.shared-volume.wrangler",
      ok: false,
      status: "failed",
      retryable: true,
      errorCode: "http_request_failed",
      summary: "retry later",
      durationMs: 10,
    },
    {
      attemptCount: 1,
      nextRetryAt: "2026-03-26T00:00:10.000Z",
    },
  );

  const run = runStore.getRun(queued.response.runId);
  expect(run?.status).toBe("queued");
  expect(run?.attemptCount).toBe(1);
  expect(run?.nextRetryAt).toBe("2026-03-26T00:00:10.000Z");
  expect(run?.events.some((event) => event.type === "retry-scheduled")).toBe(
    true,
  );

  runStore.close();
});

test("worker heartbeats are stored and listed", async () => {
  const runStore = await createRunStore({
    dbPath: ":memory:",
    now: () => new Date("2026-03-26T00:00:00.000Z"),
  });

  runStore.upsertWorkerHeartbeat({
    workerId: "worker-a",
    runtimeRole: "worker:cf-pages",
    installedCapabilities: ["wrangler"],
    currentRunId: "run_1",
  });

  const workers = runStore.listWorkerHeartbeats();
  expect(workers).toEqual([
    expect.objectContaining({
      workerId: "worker-a",
      runtimeRole: "worker:cf-pages",
      installedCapabilities: ["wrangler"],
      currentRunId: "run_1",
    }),
  ]);

  runStore.close();
});
