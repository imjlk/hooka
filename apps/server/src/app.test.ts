import { expect, test } from "bun:test";
import { createRunStore } from "@hooka/run-store";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHmac } from "node:crypto";
import { createHookaFetchHandler } from "./app";

async function createTestServerApp() {
  const tempDir = await mkdtemp(join(tmpdir(), "hooka-server-test-"));
  const manifestPath = join(tempDir, "installed-capabilities.json");
  const uiDistDir = join(tempDir, "ui");
  const runStore = await createRunStore({
    dbPath: ":memory:",
  });

  await Bun.write(
    manifestPath,
    JSON.stringify({
      image: "hooka:test",
      generatedAt: "2026-03-26T00:00:00.000Z",
      installed: ["wrangler", "wpcli", "php-cli", "rsync", "git"],
    }),
  );
  await mkdir(uiDistDir, {
    recursive: true,
  });
  await Bun.write(join(uiDistDir, "index.html"), "<!doctype html><html></html>");

  return {
    fetch: createHookaFetchHandler({
      capabilityManifestPath: manifestPath,
      runStore,
      uiDistDir,
      webhookSecret: "secret",
    }),
    runStore,
  };
}

test("generic enqueue API returns queued run metadata", async () => {
  const app = await createTestServerApp();
  const response = await app.fetch(
    new Request("http://hooka.local/api/runs", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        taskId: "wordpress.deploy.simply-static",
        input: {
          project: "staging-site",
          exportDir: "/tmp/export",
        },
      }),
    }),
  );

  expect(response.status).toBe(202);
  const body = await response.json();
  expect(body.status).toBe("queued");

  app.runStore.close();
});

test("signed simply static webhook is idempotent by event id", async () => {
  const app = await createTestServerApp();
  const payload = JSON.stringify({
    eventId: "evt_1",
    project: "staging-site",
    exportDir: "/tmp/export",
  });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHmac("sha256", "secret")
    .update(`${timestamp}.${payload}`)
    .digest("hex");

  const first = await app.fetch(
    new Request("http://hooka.local/api/webhooks/wordpress/simply-static", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hooka-timestamp": timestamp,
        "x-hooka-signature": `sha256=${signature}`,
      },
      body: payload,
    }),
  );
  const second = await app.fetch(
    new Request("http://hooka.local/api/webhooks/wordpress/simply-static", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hooka-timestamp": timestamp,
        "x-hooka-signature": `sha256=${signature}`,
      },
      body: payload,
    }),
  );

  expect(first.status).toBe(202);
  expect(second.status).toBe(200);

  const runsResponse = await app.fetch(new Request("http://hooka.local/api/runs"));
  const runs = await runsResponse.json();
  expect(runs).toHaveLength(1);

  app.runStore.close();
});

test("run detail API returns events", async () => {
  const app = await createTestServerApp();
  const queued = app.runStore.enqueueRun({
    taskId: "wordpress.deploy.simply-static",
    input: {
      project: "staging-site",
      exportDir: "/tmp/export",
    },
    source: "test",
    capabilitySnapshot: [],
  });

  const response = await app.fetch(
    new Request(`http://hooka.local/api/runs/${queued.response.runId}`),
  );
  const body = await response.json();

  expect(response.status).toBe(200);
  expect(body.events).toHaveLength(1);

  app.runStore.close();
});
