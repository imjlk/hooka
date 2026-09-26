import { expect, test } from "bun:test";
import { createTempDir, removeDir } from "@hooka/bun-utils";
import { createRunStore } from "@hooka/run-store";
import { createTargetScaffold } from "@hooka/targets";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { processNextRun } from "./worker";

test("export-verify target runs pass preflight on their exportDir field", async () => {
  const tempDir = await createTempDir("hooka-worker-export-verify");
  const exportDir = join(tempDir, "simply-static");
  const runStore = await createRunStore({
    dbPath: ":memory:",
  });

  try {
    await mkdir(exportDir, { recursive: true });
    await Bun.write(join(exportDir, "index.html"), "<html></html>");

    const target = createTargetScaffold("export-verify");
    const queued = runStore.enqueueRun({
      taskId: target.taskId,
      input: {
        exportDir,
        pattern: "**/*.html",
      },
      source: "test",
      capabilitySnapshot: [],
      targetId: target.id,
      targetPolicy: {
        ...target.policy,
        allowedSourceRoots: [tempDir],
      },
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
    expect(run?.lastErrorCode).toBeNull();
    expect(run?.status).toBe("succeeded");
    expect(run?.result?.data).toEqual({
      exportDir,
      htmlFiles: 1,
    });
  } finally {
    runStore.close();
    await removeDir(tempDir);
  }
});
