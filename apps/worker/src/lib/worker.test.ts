import { expect, test } from "bun:test";
import { createRunStore } from "@hooka/run-store";
import type { CommandRunner } from "@hooka/executor-process";
import { createWorkerShutdownSignal } from "./shutdown";
import { getEligibleTaskIds, processNextRun, startWorkerLoop } from "./worker";

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
      runtimeRole: "worker:test",
      runStore,
      workerId: "worker-a",
      leaseMs: 60_000,
      retryBaseDelayMs: 1000,
    }),
  ).toBe(true);

  const run = runStore.getRun(queued.response.runId);
  expect(run?.status).toBe("succeeded");
  expect(run?.events.some((event) => event.type === "succeeded")).toBe(true);

  runStore.close();
});

test("worker leaves runs queued when required capabilities are missing", async () => {
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

  const processed = await processNextRun({
    installedCapabilities: [],
    manifestPath: "/tmp/manifest.json",
    runtimeRole: "worker:test",
    runStore,
    workerId: "worker-a",
    leaseMs: 60_000,
    retryBaseDelayMs: 1000,
  });

  const run = runStore.getRun(queued.response.runId);
  expect(processed).toBe(false);
  expect(run?.status).toBe("queued");
  expect(run?.events.map((event) => event.type)).toEqual(["queued"]);

  runStore.close();
});

test("worker claims only runs covered by its installed capabilities", async () => {
  const runStore = await createRunStore({
    dbPath: ":memory:",
  });

  const rcloneRun = runStore.enqueueRun({
    taskId: "rclone.copy.directory",
    input: {
      sourcePath: "/shared-source/export",
      destination: "backup:site/export",
    },
    source: "test",
    capabilitySnapshot: ["rclone"],
  });
  const wranglerRun = runStore.enqueueRun({
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
      runtimeRole: "worker:test",
      runStore,
      workerId: "worker-a",
      leaseMs: 60_000,
      retryBaseDelayMs: 1000,
    }),
  ).toBe(true);

  expect(runStore.getRun(rcloneRun.response.runId)?.status).toBe("queued");
  expect(runStore.getRun(wranglerRun.response.runId)?.status).toBe("succeeded");

  runStore.close();
});

test("worker marks unknown queued tasks as failed", async () => {
  const runStore = await createRunStore({
    dbPath: ":memory:",
  });

  const queued = runStore.enqueueRun({
    taskId: "legacy.task.removed",
    input: {},
    source: "test",
    capabilitySnapshot: [],
  });

  expect(
    await processNextRun({
      installedCapabilities: [],
      manifestPath: "/tmp/manifest.json",
      runtimeRole: "worker:test",
      runStore,
      workerId: "worker-a",
      leaseMs: 60_000,
      retryBaseDelayMs: 1000,
    }),
  ).toBe(true);

  const run = runStore.getRun(queued.response.runId);
  expect(run?.status).toBe("failed");
  expect(run?.lastErrorCode).toBe("task_not_found");
  expect(run?.summary).toContain("Task not found");

  runStore.close();
});

test("eligible task discovery follows installed capability requirements", () => {
  expect(getEligibleTaskIds(["wrangler"])).toContain(
    "deploy.shared-volume.wrangler",
  );
  expect(getEligibleTaskIds(["wrangler"])).not.toContain(
    "rclone.copy.directory",
  );
  expect(getEligibleTaskIds([])).toContain("wordpress.export.verify");
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
    runtimeRole: "worker:test",
    runStore,
    workerId: "worker-a",
    leaseMs: 60_000,
    retryBaseDelayMs: 1000,
  });

  const run = runStore.getRun(queued.response.runId);
  expect(run?.status).toBe("queued");
  expect(run?.summary).toContain("Export directory not found");
  expect(run?.nextRetryAt).not.toBeNull();
  expect(run?.events.some((event) => event.type === "retry-scheduled")).toBe(
    true,
  );

  runStore.close();
});

test("worker loop finishes the in-flight run before honoring shutdown", async () => {
  const runStore = await createRunStore({
    dbPath: ":memory:",
  });
  const shutdownSignal = createWorkerShutdownSignal({
    info() {},
    warn() {},
    error() {},
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
    logger: {
      info() {},
      warn() {},
      error() {},
    },
    manifestPath: "/tmp/manifest.json",
    pollIntervalMs: 0,
    runtimeRole: "worker:test",
    runStore,
    shutdownSignal,
    workerId: "worker-a",
    leaseMs: 60_000,
    retryBaseDelayMs: 1000,
  });

  const run = runStore.getRun(queued.response.runId);
  expect(run?.status).toBe("succeeded");

  runStore.close();
});

test("worker moves retryable failures to dead-letter after max attempts", async () => {
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
    maxAttempts: 1,
  });

  await processNextRun({
    installedCapabilities: [],
    manifestPath: "/tmp/manifest.json",
    runtimeRole: "worker:test",
    runStore,
    workerId: "worker-a",
    leaseMs: 60_000,
    retryBaseDelayMs: 1000,
  });

  const run = runStore.getRun(queued.response.runId);
  expect(run?.status).toBe("dead-lettered");
  expect(run?.attemptCount).toBe(1);
  expect(run?.events.some((event) => event.type === "dead-lettered")).toBe(
    true,
  );

  runStore.close();
});

test("worker writes audit events for target policy preflight rejections", async () => {
  const runStore = await createRunStore({
    dbPath: ":memory:",
  });

  const queued = runStore.enqueueRun({
    taskId: "deploy.shared-volume.wrangler",
    input: {
      kind: "pages-deploy",
      project: "forbidden-site",
      sourcePath: "/shared-source/forbidden-site",
    },
    source: "test",
    capabilitySnapshot: ["wrangler"],
    targetId: "pages-main",
    targetPolicy: {
      allowedProjects: ["main-site"],
      allowedSourceRoots: ["/shared-source"],
      allowedDestinationPrefixes: [],
      allowedBranches: ["main"],
      allowedOverrideFields: [],
      requiredEnv: [],
      artifactReadiness: {
        mode: "none",
      },
    },
  });

  await processNextRun({
    installedCapabilities: ["wrangler"],
    manifestPath: "/tmp/manifest.json",
    runtimeRole: "worker:test",
    runStore,
    workerId: "worker-a",
    leaseMs: 60_000,
    retryBaseDelayMs: 1000,
  });

  const auditEvents = runStore.listAuditEvents({
    category: "policy",
  });
  expect(runStore.getRun(queued.response.runId)?.status).toBe("failed");
  expect(auditEvents[0]).toMatchObject({
    category: "policy",
    action: "target_policy_rejected",
    outcome: "rejected",
    subjectId: "pages-main",
  });

  runStore.close();
});

test("worker loop backs off after repeated errors", async () => {
  const runStore = await createRunStore({
    dbPath: ":memory:",
  });
  const shutdownSignal = createWorkerShutdownSignal({
    info() {},
    warn() {},
    error() {},
  });
  const sleepCalls: number[] = [];

  const original = runStore.requeueExpiredRuns.bind(runStore);
  let failures = 0;
  runStore.requeueExpiredRuns = (() => {
    failures += 1;
    if (failures >= 3) {
      shutdownSignal.requestShutdown("test");
    }
    throw new Error("db busy");
  }) as typeof runStore.requeueExpiredRuns;

  await startWorkerLoop({
    installedCapabilities: ["wrangler"],
    logger: {
      info() {},
      warn() {},
      error() {},
    },
    manifestPath: "/tmp/manifest.json",
    pollIntervalMs: 5,
    retentionSweepIntervalHours: 24,
    runtimeRole: "worker:test",
    runStore,
    shutdownSignal,
    sleep: async (ms) => {
      sleepCalls.push(ms);
    },
    workerId: "worker-a",
    leaseMs: 60_000,
    retryBaseDelayMs: 1000,
  });

  expect(sleepCalls.slice(0, 2)).toEqual([1000, 2000]);

  runStore.requeueExpiredRuns = original;
  runStore.close();
});

function readLeaseExpiresAt(
  runStore: Awaited<ReturnType<typeof createRunStore>>,
  runId: string,
): string | null {
  const row = runStore.db
    .query("select lease_expires_at from runs where id = ?")
    .get(runId) as { lease_expires_at: string | null } | null;
  return row?.lease_expires_at ?? null;
}

test("worker renews the run lease and heartbeat while a task runs", async () => {
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
  const runId = queued.response.runId;
  const seenLeases: Array<string | null> = [];
  const seenHeartbeats: Array<string | undefined> = [];
  const readHeartbeat = () =>
    runStore
      .listWorkerHeartbeats()
      .find((heartbeat) => heartbeat.workerId === "worker-a");

  const commandRunner: CommandRunner = async () => {
    seenLeases.push(readLeaseExpiresAt(runStore, runId));
    seenHeartbeats.push(readHeartbeat()?.lastSeenAt);
    await Bun.sleep(150);
    seenLeases.push(readLeaseExpiresAt(runStore, runId));
    seenHeartbeats.push(readHeartbeat()?.lastSeenAt);
    expect(readHeartbeat()?.currentRunId).toBe(runId);
    return {
      stdout: "ok",
      stderr: "",
      exitCode: 0,
    };
  };

  await processNextRun({
    commandRunner,
    heartbeatIntervalMs: 20,
    installedCapabilities: ["wrangler"],
    manifestPath: "/tmp/manifest.json",
    runtimeRole: "worker:test",
    runStore,
    workerId: "worker-a",
    leaseMs: 60_000,
    retryBaseDelayMs: 1000,
  });

  const [leaseAtStart, leaseLater] = seenLeases;
  const [heartbeatAtStart, heartbeatLater] = seenHeartbeats;
  expect(leaseAtStart).toBeTruthy();
  expect(heartbeatAtStart).toBeTruthy();
  // ISO-8601 UTC timestamps order lexicographically.
  expect((leaseLater ?? "") > (leaseAtStart ?? "")).toBe(true);
  expect((heartbeatLater ?? "") > (heartbeatAtStart ?? "")).toBe(true);
  expect(runStore.getRun(runId)?.status).toBe("succeeded");
  expect(readHeartbeat()?.currentRunId).toBeNull();

  runStore.close();
});

test("worker discards its result when another worker took over the run", async () => {
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
  const runId = queued.response.runId;
  const warnings: string[] = [];

  const commandRunner: CommandRunner = async () => {
    // This worker's lease lapsed mid-run and worker-b claimed the run.
    runStore.db
      .query("update runs set worker_id = 'worker-b' where id = ?")
      .run(runId);
    return {
      stdout: "",
      stderr: "boom",
      exitCode: 1,
    };
  };

  await processNextRun({
    commandRunner,
    installedCapabilities: ["wrangler"],
    logger: {
      info() {},
      warn(message) {
        warnings.push(message);
      },
      error() {},
    },
    manifestPath: "/tmp/manifest.json",
    runtimeRole: "worker:test",
    runStore,
    workerId: "worker-a",
    leaseMs: 60_000,
    retryBaseDelayMs: 1000,
  });

  const run = runStore.getRun(runId);
  expect(run?.status).toBe("running");
  expect(run?.workerId).toBe("worker-b");
  expect(run?.events.map((event) => event.type)).toEqual(["queued", "started"]);
  expect(warnings).toContain("Run lease lost before the result was recorded");

  runStore.close();
});

test("worker settles a claimed run when bookkeeping after the claim throws", async () => {
  const runStore = await createRunStore({
    dbPath: ":memory:",
  });
  const queued = runStore.enqueueRun({
    taskId: "deploy.shared-volume.wrangler",
    input: {
      kind: "pages-deploy",
      project: "forbidden-site",
      sourcePath: "/shared-source/forbidden-site",
    },
    source: "test",
    capabilitySnapshot: ["wrangler"],
    targetId: "pages-main",
    targetPolicy: {
      allowedProjects: ["main-site"],
      allowedSourceRoots: ["/shared-source"],
      allowedDestinationPrefixes: [],
      allowedBranches: ["main"],
      allowedOverrideFields: [],
      requiredEnv: [],
      artifactReadiness: {
        mode: "none",
      },
    },
  });
  runStore.appendEvent = () => {
    throw new Error("disk I/O error");
  };

  await processNextRun({
    installedCapabilities: ["wrangler"],
    manifestPath: "/tmp/manifest.json",
    runtimeRole: "worker:test",
    runStore,
    workerId: "worker-a",
    leaseMs: 60_000,
    retryBaseDelayMs: 1000,
  });

  const run = runStore.getRun(queued.response.runId);
  expect(run?.status).toBe("queued");
  expect(run?.lastErrorCode).toBe("worker_execution_failed");
  expect(run?.summary).toContain("disk I/O error");
  expect(run?.nextRetryAt).not.toBeNull();

  runStore.close();
});
