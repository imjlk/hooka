import { expect, test } from "bun:test";
import { createTempDir, ensureDir } from "@hooka/bun-utils";
import { createRunStore } from "@hooka/run-store";
import { createHmac } from "node:crypto";
import { join } from "node:path";
import { processNextRun } from "../../worker/src/lib/worker";
import { createHookaFetchHandler } from "./app";

test("signed webhook enqueue flows through worker execution and persists the result", async () => {
  const tempDir = await createTempDir("hooka-integration-test");
  const manifestPath = join(tempDir, "installed-capabilities.json");
  const targetsPath = join(tempDir, "targets.json");
  const uiDistDir = join(tempDir, "ui");
  const runStore = await createRunStore({
    dbPath: ":memory:",
  });

  await Bun.write(
    manifestPath,
    JSON.stringify({
      image: "hooka:test",
      generatedAt: "2026-04-12T00:00:00.000Z",
      installed: ["wrangler"],
    }),
  );
  await Bun.write(targetsPath, JSON.stringify({ targets: [] }));
  await ensureDir(uiDistDir);
  await Bun.write(
    join(uiDistDir, "index.html"),
    "<!doctype html><html></html>",
  );

  const fetch = createHookaFetchHandler({
    adminToken: "admin-token",
    apiRateLimit: 120,
    capabilityManifestPath: manifestPath,
    corsOrigins: [],
    defaultMaxAttempts: 3,
    globalApiRateLimit: 1200,
    globalWebhookRateLimit: 600,
    maxBodyBytes: 1_048_576,
    rateLimitWindowMs: 60_000,
    runStore,
    targetsPath,
    trustProxy: false,
    uiDistDir,
    webhookRateLimit: 60,
    webhookSecret: "secret",
  });

  const payload = JSON.stringify({
    taskId: "deploy.shared-volume.wrangler",
    input: {
      kind: "pages-deploy",
      project: "staging-site",
      sourcePath: "/shared-source/simply-static",
    },
    eventId: "evt_integration_1",
    source: "integration.test",
  });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHmac("sha256", "secret")
    .update(`${timestamp}.${payload}`)
    .digest("hex");

  const enqueueResponse = await fetch(
    new Request("http://hooka.local/api/webhooks/task", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hooka-timestamp": timestamp,
        "x-hooka-signature": `sha256=${signature}`,
      },
      body: payload,
    }),
  );

  expect(enqueueResponse.status).toBe(202);
  const queued = (await enqueueResponse.json()) as { runId: string };

  const processed = await processNextRun({
    commandRunner: async () => {
      return {
        stdout: "wrangler deploy ok",
        stderr: "",
        exitCode: 0,
      };
    },
    installedCapabilities: ["wrangler"],
    manifestPath,
    runtimeRole: "worker:test",
    runStore,
    workerId: "worker-a",
    leaseMs: 60_000,
    retryBaseDelayMs: 1_000,
  });

  expect(processed).toBe(true);

  const detailResponse = await fetch(
    new Request(`http://hooka.local/api/runs/${queued.runId}`, {
      headers: {
        authorization: "Bearer admin-token",
      },
    }),
  );
  const detail = await detailResponse.json();

  expect(detailResponse.status).toBe(200);
  expect(detail.status).toBe("succeeded");
  expect(detail.result.stdout).toBe("wrangler deploy ok");

  runStore.close();
});
