import { expect, test } from "bun:test";
import { createRunStore } from "@hooka/run-store";
import type { CommandRunner } from "@hooka/executor-process";
import { processNextRun } from "./worker";

test("worker executes a queued run and stores the result", async () => {
  const runStore = await createRunStore({
    dbPath: ":memory:",
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
  const commandRunner: CommandRunner = async () => {
    return {
      stdout: "ok",
      stderr: "",
      exitCode: 0,
    };
  };

  expect(
    await processNextRun({
      commandRunner,
      installedCapabilities: ["wrangler", "wpcli"],
      manifestPath: "/tmp/manifest.json",
      runStore,
      workerId: "worker-a",
      leaseMs: 60_000,
    }),
  ).toBe(true);

  const run = runStore.getRun(queued.response.runId);
  expect(run?.status).toBe("succeeded");
  expect(run?.events.some((event) => event.type === "succeeded")).toBe(true);

  runStore.close();
});

test("worker records failed runs when capabilities are missing", async () => {
  const runStore = await createRunStore({
    dbPath: ":memory:",
  });

  const queued = runStore.enqueueRun({
    taskId: "wordpress.deploy.simply-static",
    input: {
      project: "main-site",
      exportDir: "/tmp/export",
    },
    source: "test",
    capabilitySnapshot: [],
  });

  await processNextRun({
    installedCapabilities: [],
    manifestPath: "/tmp/manifest.json",
    runStore,
    workerId: "worker-a",
    leaseMs: 60_000,
  });

  const run = runStore.getRun(queued.response.runId);
  expect(run?.status).toBe("failed");
  expect(run?.summary).toContain("Missing required capabilities");

  runStore.close();
});

test("worker records failed runs when task execution throws", async () => {
  const runStore = await createRunStore({
    dbPath: ":memory:",
  });

  const queued = runStore.enqueueRun({
    taskId: "wordpress.export.verify",
    input: {
      exportDir: "/definitely/missing",
    },
    source: "test",
    capabilitySnapshot: [],
  });

  await processNextRun({
    installedCapabilities: [],
    manifestPath: "/tmp/manifest.json",
    runStore,
    workerId: "worker-a",
    leaseMs: 60_000,
  });

  const run = runStore.getRun(queued.response.runId);
  expect(run?.status).toBe("failed");
  expect(run?.summary).toContain("Export directory not found");

  runStore.close();
});
