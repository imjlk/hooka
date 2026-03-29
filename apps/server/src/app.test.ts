import { expect, test } from "bun:test";
import { createTempDir, ensureDir } from "@hooka/bun-utils";
import { createRunStore } from "@hooka/run-store";
import { join } from "node:path";
import { createHmac } from "node:crypto";
import { createHookaFetchHandler } from "./app";

async function createTestServerApp() {
  const tempDir = await createTempDir("hooka-server-test");
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
  await ensureDir(uiDistDir);
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
        taskId: "deploy.shared-volume.wrangler",
        input: {
          kind: "pages-deploy",
          project: "staging-site",
          sourcePath: "/shared-source/simply-static",
        },
      }),
    }),
  );

  expect(response.status).toBe(202);
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(response.headers.get("x-frame-options")).toBe("DENY");
  expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  const body = await response.json();
  expect(body.status).toBe("queued");

  app.runStore.close();
});

test("signed simply static webhook is idempotent by event id", async () => {
  const app = await createTestServerApp();
  const payload = JSON.stringify({
    taskId: "deploy.shared-volume.wrangler",
    input: {
      kind: "pages-deploy",
      project: "staging-site",
      sourcePath: "/shared-source/simply-static",
    },
    eventId: "evt_1",
    source: "webhook",
  });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHmac("sha256", "secret")
    .update(`${timestamp}.${payload}`)
    .digest("hex");

  const first = await app.fetch(
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
  const second = await app.fetch(
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

  expect(first.status).toBe(202);
  expect(second.status).toBe(200);
  expect(first.headers.get("x-content-type-options")).toBe("nosniff");
  expect(second.headers.get("x-frame-options")).toBe("DENY");

  const runsResponse = await app.fetch(new Request("http://hooka.local/api/runs"));
  const runs = await runsResponse.json();
  expect(runs).toHaveLength(1);

  app.runStore.close();
});

test("wordpress alias normalizes to the generic runtime path", async () => {
  const app = await createTestServerApp();
  const payload = JSON.stringify({
    eventId: "evt_wp_1",
    project: "main-site",
    exportDir: "/shared-source/simply-static",
  });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHmac("sha256", "secret")
    .update(`${timestamp}.${payload}`)
    .digest("hex");

  const response = await app.fetch(
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

  expect(response.status).toBe(202);
  expect(response.headers.get("referrer-policy")).toBe("no-referrer");

  const runs = app.runStore.listRuns();
  expect(runs[0]?.taskId).toBe("deploy.shared-volume.wrangler");
  expect(runs[0]?.source).toBe("wordpress.webhook");

  app.runStore.close();
});

test("run detail API returns events", async () => {
  const app = await createTestServerApp();
  const queued = app.runStore.enqueueRun({
    taskId: "deploy.shared-volume.wrangler",
    input: {
      kind: "pages-deploy",
      project: "staging-site",
      sourcePath: "/shared-source/simply-static",
    },
    source: "test",
    capabilitySnapshot: [],
  });
  app.runStore.finishRun(queued.response.runId, {
    taskId: "deploy.shared-volume.wrangler",
    ok: false,
    status: "failed",
    stdout: "stdout text",
    stderr: "stderr text",
    summary: "failed summary",
    durationMs: 12,
  });

  const response = await app.fetch(
    new Request(`http://hooka.local/api/runs/${queued.response.runId}`),
  );
  const body = await response.json();

  expect(response.status).toBe(200);
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(body.events).toHaveLength(2);
  expect(body.result.stdout).toBe("stdout text");
  expect(body.result.stderr).toBe("stderr text");
  expect(body.errorText).toBe("stderr text");

  app.runStore.close();
});

test("registry APIs expose canonical task and preset ids", async () => {
  const app = await createTestServerApp();

  const [tasksResponse, presetsResponse, summaryResponse] = await Promise.all([
    app.fetch(new Request("http://hooka.local/api/tasks")),
    app.fetch(new Request("http://hooka.local/api/presets")),
    app.fetch(new Request("http://hooka.local/api/summary")),
  ]);

  const tasks = (await tasksResponse.json()) as Array<{ id: string }>;
  const presets = (await presetsResponse.json()) as Array<{ id: string }>;
  const summary = (await summaryResponse.json()) as {
    tasks: Array<{ id: string }>;
    presets: Array<{ id: string }>;
  };

  expect(tasks.map((task) => task.id)).toContain("deploy.shared-volume.wrangler");
  expect(tasks.map((task) => task.id)).not.toContain(
    "wordpress.deploy.simply-static",
  );
  expect(presets.map((preset) => preset.id)).toEqual([
    "core",
    "cf-pages",
    "cf-cache",
    "wp-ops",
    "wp-wrangler",
  ]);
  expect(presets.map((preset) => preset.id)).not.toContain("webhook-wrangler");
  expect(presets.map((preset) => preset.id)).not.toContain("cf-wrangler");
  expect(summary.tasks.map((task) => task.id)).toContain(
    "deploy.shared-volume.wrangler",
  );
  expect(summary.presets.map((preset) => preset.id)).toContain("cf-pages");
  expect(summary.presets.map((preset) => preset.id)).toContain("cf-cache");
  expect(summary.presets.map((preset) => preset.id)).toContain("wp-ops");
  expect(summary.presets.map((preset) => preset.id)).toContain("wp-wrangler");

  app.runStore.close();
});

test("run list API supports status, taskId, and source filters", async () => {
  const app = await createTestServerApp();
  const queuedRun = app.runStore.enqueueRun({
    taskId: "deploy.shared-volume.wrangler",
    input: {
      kind: "pages-deploy",
      project: "staging-site",
      sourcePath: "/shared-source/simply-static",
    },
    source: "wordpress.webhook",
    capabilitySnapshot: [],
  });
  app.runStore.finishRun(queuedRun.response.runId, {
    taskId: "deploy.shared-volume.wrangler",
    ok: true,
    status: "succeeded",
    summary: "deployed",
    durationMs: 5,
  });
  app.runStore.enqueueRun({
    taskId: "cloudflare.cache.purge.urls",
    input: {
      zoneId: "zone-1",
      urls: "https://example.com/",
    },
    source: "cli",
    capabilitySnapshot: [],
  });

  const [statusResponse, taskResponse, sourceResponse] = await Promise.all([
    app.fetch(new Request("http://hooka.local/api/runs?status=succeeded")),
    app.fetch(
      new Request(
        "http://hooka.local/api/runs?taskId=cloudflare.cache.purge.urls",
      ),
    ),
    app.fetch(new Request("http://hooka.local/api/runs?source=wordpress.webhook")),
  ]);

  const [statusRuns, taskRuns, sourceRuns] = await Promise.all([
    statusResponse.json() as Promise<Array<{ id: string }>>,
    taskResponse.json() as Promise<Array<{ taskId: string }>>,
    sourceResponse.json() as Promise<Array<{ source: string }>>,
  ]);

  expect(statusResponse.status).toBe(200);
  expect(statusResponse.headers.get("x-frame-options")).toBe("DENY");
  expect(statusRuns).toHaveLength(1);
  expect(statusRuns[0]?.id).toBe(queuedRun.response.runId);
  expect(taskRuns).toHaveLength(1);
  expect(taskRuns[0]?.taskId).toBe("cloudflare.cache.purge.urls");
  expect(sourceRuns).toHaveLength(1);
  expect(sourceRuns[0]?.source).toBe("wordpress.webhook");

  app.runStore.close();
});

test("ui fallback responses include security headers", async () => {
  const app = await createTestServerApp();
  const response = await app.fetch(new Request("http://hooka.local/"));

  expect(response.status).toBe(200);
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(response.headers.get("x-frame-options")).toBe("DENY");
  expect(response.headers.get("referrer-policy")).toBe("no-referrer");

  app.runStore.close();
});
