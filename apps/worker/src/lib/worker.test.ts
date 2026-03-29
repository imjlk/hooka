import { expect, test } from "bun:test";
import { createRunStore } from "@hooka/run-store";
import type { CommandRunner } from "@hooka/executor-process";
import { createWorkerShutdownSignal } from "./shutdown";
import { processNextRun, startWorkerLoop } from "./worker";

test("worker executes a queued run and stores the result", async () => {
  const runStore = await createRunStore({
    dbPath: ":memory:",
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
      installedCapabilities: ["wrangler"],
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
    taskId: "deploy.shared-volume.wrangler",
    input: {
      kind: "pages-deploy",
      project: "main-site",
      sourcePath: "/shared-source/simply-static",
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

test("worker loop finishes the in-flight run before honoring shutdown", async () => {
  const runStore = await createRunStore({
    dbPath: ":memory:",
  });
  const shutdownSignal = createWorkerShutdownSignal({
    log() {},
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

  const commandRunner: CommandRunner = async () => {
    shutdownSignal.requestShutdown("test");
    return {
      stdout: "ok",
      stderr: "",
      exitCode: 0,
    };
  };

  await startWorkerLoop({
    commandRunner,
    installedCapabilities: ["wrangler"],
    manifestPath: "/tmp/manifest.json",
    pollIntervalMs: 0,
    runStore,
    shutdownSignal,
    workerId: "worker-a",
    leaseMs: 60_000,
  });

  const run = runStore.getRun(queued.response.runId);
  expect(run?.status).toBe("succeeded");

  runStore.close();
});
