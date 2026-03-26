import { expect, test } from "bun:test";
import { createRunStore } from "./index";

test("enqueue run stores queued record and queued event", async () => {
  const runStore = await createRunStore({
    dbPath: ":memory:",
    now: () => new Date("2026-03-26T00:00:00.000Z"),
  });

  const queued = runStore.enqueueRun({
    taskId: "wordpress.deploy.simply-static",
    input: {
      project: "staging-site",
      exportDir: "/tmp/export",
    },
    source: "test",
    capabilitySnapshot: ["wrangler", "wpcli"],
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
    taskId: "wordpress.deploy.simply-static",
    input: {
      project: "main-site",
      exportDir: "/tmp/export",
    },
    source: "wordpress.webhook.simply-static",
    sourceEventId: "evt_123",
    capabilitySnapshot: [],
  });
  const second = runStore.enqueueRun({
    taskId: "wordpress.deploy.simply-static",
    input: {
      project: "main-site",
      exportDir: "/tmp/export",
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
    taskId: "wordpress.deploy.simply-static",
    input: {
      project: "staging-site",
      exportDir: "/tmp/export",
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
