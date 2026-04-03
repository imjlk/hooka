import { expect, test } from "bun:test";
import { createTempDir, ensureDir } from "@hooka/bun-utils";
import { createRunStore } from "@hooka/run-store";
import { join } from "node:path";
import { createHmac } from "node:crypto";
import { createHookaFetchHandler } from "./app";

async function createTestServerApp(
  input: {
    targets?: unknown[];
    trustProxy?: boolean;
    apiRateLimit?: number;
    webhookRateLimit?: number;
  } = {},
) {
  const tempDir = await createTempDir("hooka-server-test");
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
      generatedAt: "2026-03-26T00:00:00.000Z",
      installed: ["wrangler", "wpcli", "php-cli", "rsync", "git"],
    }),
  );
  await ensureDir(uiDistDir);
  await Bun.write(
    join(uiDistDir, "index.html"),
    "<!doctype html><html></html>",
  );
  await Bun.write(
    targetsPath,
    JSON.stringify({ targets: input.targets ?? [] }),
  );

  return {
    fetch: createHookaFetchHandler({
      adminToken: "admin-token",
      apiRateLimit: input.apiRateLimit ?? 120,
      capabilityManifestPath: manifestPath,
      defaultMaxAttempts: 3,
      rateLimitWindowMs: 60_000,
      runStore,
      targetsPath,
      trustProxy: input.trustProxy ?? false,
      uiDistDir,
      webhookRateLimit: input.webhookRateLimit ?? 60,
      webhookSecret: "secret",
    }),
    runStore,
  };
}

function createAdminHeaders(): HeadersInit {
  return {
    authorization: "Bearer admin-token",
  };
}

test("generic enqueue API returns queued run metadata", async () => {
  const app = await createTestServerApp();
  const response = await app.fetch(
    new Request("http://hooka.local/api/runs", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...createAdminHeaders(),
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

test("admin API routes reject missing bearer tokens", async () => {
  const app = await createTestServerApp();
  const response = await app.fetch(
    new Request("http://hooka.local/api/summary"),
  );
  const body = await response.json();

  expect(response.status).toBe(401);
  expect(body.error).toContain("admin token");
  expect(app.runStore.listAuditEvents({ limit: 5 })[0]).toMatchObject({
    category: "security",
    action: "admin_auth_rejected",
    outcome: "rejected",
  });

  app.runStore.close();
});

test("health and readiness endpoints report server availability", async () => {
  const app = await createTestServerApp();

  const [healthResponse, readyResponse] = await Promise.all([
    app.fetch(new Request("http://hooka.local/api/health")),
    app.fetch(new Request("http://hooka.local/api/ready")),
  ]);

  expect(healthResponse.status).toBe(200);
  expect(readyResponse.status).toBe(200);
  expect((await healthResponse.json()).ok).toBe(true);
  expect((await readyResponse.json()).ok).toBe(true);

  app.runStore.close();
});

test("readiness endpoint returns 503 when the database is unavailable", async () => {
  const app = await createTestServerApp();
  app.runStore.close();

  const response = await app.fetch(new Request("http://hooka.local/api/ready"));
  const body = await response.json();

  expect(response.status).toBe(503);
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(body).toMatchObject({
    ok: false,
    service: "hooka-server",
    error: "Database not ready.",
  });
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

  const runsResponse = await app.fetch(
    new Request("http://hooka.local/api/runs", {
      headers: createAdminHeaders(),
    }),
  );
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

test("target webhook resolves configured targets and stores target metadata", async () => {
  const app = await createTestServerApp({
    targets: [
      {
        id: "pages-main",
        title: "Pages Main",
        taskId: "deploy.shared-volume.wrangler",
        source: "target.cloudflare-pages",
        defaultInput: {
          kind: "pages-deploy",
          project: "main-site",
          sourcePath: "/shared-source/main-site",
          branch: "main",
        },
        maxAttempts: 4,
        policy: {
          allowedProjects: ["main-site"],
          allowedSourceRoots: ["/shared-source"],
          allowedBranches: ["main"],
          allowedOverrideFields: ["branch"],
          requiredEnv: [],
          artifactReadiness: {
            mode: "none",
          },
        },
      },
    ],
  });
  const payload = JSON.stringify({
    targetId: "pages-main",
    overrides: {
      branch: "main",
    },
    eventId: "evt_target_1",
    source: "target.trigger",
  });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHmac("sha256", "secret")
    .update(`${timestamp}.${payload}`)
    .digest("hex");

  const response = await app.fetch(
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

  expect(response.status).toBe(202);
  const run = app.runStore.listRuns()[0];
  expect(run?.targetId).toBe("pages-main");
  expect(run?.maxAttempts).toBe(4);

  app.runStore.close();
});

test("target CRUD APIs mutate the configured targets file and emit audit events", async () => {
  const app = await createTestServerApp();
  const target = {
    id: "pages-main",
    title: "Pages Main",
    taskId: "deploy.shared-volume.wrangler",
    source: "target.cloudflare-pages",
    maxAttempts: 3,
    defaultInput: {
      kind: "pages-deploy",
      project: "main-site",
      sourcePath: "/shared-source/main-site",
    },
    policy: {
      allowedProjects: ["main-site"],
      allowedSourceRoots: ["/shared-source"],
      allowedBranches: ["main"],
      allowedOverrideFields: [],
      requiredEnv: [],
      artifactReadiness: {
        mode: "none",
      },
    },
  };

  const createResponse = await app.fetch(
    new Request("http://hooka.local/api/targets", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...createAdminHeaders(),
      },
      body: JSON.stringify(target),
    }),
  );
  expect(createResponse.status).toBe(201);

  const updateResponse = await app.fetch(
    new Request("http://hooka.local/api/targets/pages-main", {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        ...createAdminHeaders(),
      },
      body: JSON.stringify({
        ...target,
        maxAttempts: 4,
      }),
    }),
  );
  expect(updateResponse.status).toBe(200);

  const auditResponse = await app.fetch(
    new Request("http://hooka.local/api/audit-events?category=targets", {
      headers: createAdminHeaders(),
    }),
  );
  const auditEvents = await auditResponse.json();
  expect(auditResponse.status).toBe(200);
  expect(auditEvents).toEqual([
    expect.objectContaining({
      category: "targets",
      action: "target_updated",
      outcome: "updated",
      subjectId: "pages-main",
    }),
    expect.objectContaining({
      category: "targets",
      action: "target_created",
      outcome: "created",
      subjectId: "pages-main",
    }),
  ]);

  const deleteResponse = await app.fetch(
    new Request("http://hooka.local/api/targets/pages-main", {
      method: "DELETE",
      headers: createAdminHeaders(),
    }),
  );
  expect(deleteResponse.status).toBe(200);

  const targetsResponse = await app.fetch(
    new Request("http://hooka.local/api/targets", {
      headers: createAdminHeaders(),
    }),
  );
  expect(await targetsResponse.json()).toEqual([]);

  app.runStore.close();
});

test("webhook signature failures are audited", async () => {
  const app = await createTestServerApp();
  const response = await app.fetch(
    new Request("http://hooka.local/api/webhooks/task", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hooka-timestamp": "123",
        "x-hooka-signature": "sha256=bad",
      },
      body: "{}",
    }),
  );

  expect(response.status).toBeGreaterThanOrEqual(400);
  expect(app.runStore.listAuditEvents({ limit: 5 })[0]).toMatchObject({
    category: "security",
    action: "webhook_signature_rejected",
    outcome: "rejected",
  });

  app.runStore.close();
});

test("target write errors map to conflict and not found responses", async () => {
  const app = await createTestServerApp({
    targets: [
      {
        id: "pages-main",
        title: "Pages Main",
        taskId: "deploy.shared-volume.wrangler",
        source: "target.cloudflare-pages",
        maxAttempts: 3,
        defaultInput: {},
        policy: {
          allowedProjects: [],
          allowedSourceRoots: [],
          allowedBranches: [],
          allowedOverrideFields: [],
          requiredEnv: [],
          artifactReadiness: {
            mode: "none",
          },
        },
      },
    ],
  });

  const duplicateCreate = await app.fetch(
    new Request("http://hooka.local/api/targets", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...createAdminHeaders(),
      },
      body: JSON.stringify({
        id: "pages-main",
        title: "Pages Main",
        taskId: "deploy.shared-volume.wrangler",
        source: "target.cloudflare-pages",
        maxAttempts: 3,
        defaultInput: {},
        policy: {
          allowedProjects: [],
          allowedSourceRoots: [],
          allowedBranches: [],
          allowedOverrideFields: [],
          requiredEnv: [],
          artifactReadiness: {
            mode: "none",
          },
        },
      }),
    }),
  );
  const missingDelete = await app.fetch(
    new Request("http://hooka.local/api/targets/missing", {
      method: "DELETE",
      headers: createAdminHeaders(),
    }),
  );

  expect(duplicateCreate.status).toBe(409);
  expect(missingDelete.status).toBe(404);

  app.runStore.close();
});

test("rate limit rejections are audited", async () => {
  const app = await createTestServerApp({
    apiRateLimit: 1,
    trustProxy: true,
  });

  const first = await app.fetch(
    new Request("http://hooka.local/api/summary", {
      headers: {
        ...createAdminHeaders(),
        "x-forwarded-for": "203.0.113.10, 10.0.0.5",
      },
    }),
  );
  const second = await app.fetch(
    new Request("http://hooka.local/api/summary", {
      headers: {
        ...createAdminHeaders(),
        "x-forwarded-for": "203.0.113.10, 10.0.0.5",
      },
    }),
  );

  expect(first.status).toBe(200);
  expect(second.status).toBe(429);
  expect(app.runStore.listAuditEvents({ limit: 5 })[0]).toMatchObject({
    category: "security",
    action: "rate_limit_rejected",
    outcome: "rejected",
    clientIp: "203.0.113.10",
    requestPath: "/api/summary",
  });

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
  const authorized = await app.fetch(
    new Request(`http://hooka.local/api/runs/${queued.response.runId}`, {
      headers: createAdminHeaders(),
    }),
  );
  expect(response.status).toBe(401);
  const body = await authorized.json();

  expect(authorized.status).toBe(200);
  expect(authorized.headers.get("x-content-type-options")).toBe("nosniff");
  expect(body.events).toHaveLength(2);
  expect(body.result.stdout).toBe("stdout text");
  expect(body.result.stderr).toBe("stderr text");
  expect(body.errorText).toBe("stderr text");

  app.runStore.close();
});

test("run retry API re-enqueues terminal runs", async () => {
  const app = await createTestServerApp();
  const queued = app.runStore.enqueueRun({
    taskId: "deploy.shared-volume.wrangler",
    input: {
      kind: "pages-deploy",
      project: "staging-site",
      sourcePath: "/shared-source/simply-static",
    },
    source: "webhook",
    capabilitySnapshot: ["wrangler"],
  });
  app.runStore.finishRun(
    queued.response.runId,
    {
      taskId: "deploy.shared-volume.wrangler",
      ok: false,
      status: "failed",
      retryable: false,
      errorCode: "failed",
      summary: "boom",
      durationMs: 10,
    },
    {
      attemptCount: 1,
    },
  );

  const response = await app.fetch(
    new Request(`http://hooka.local/api/runs/${queued.response.runId}/retry`, {
      method: "POST",
      headers: createAdminHeaders(),
    }),
  );
  const body = await response.json();

  expect(response.status).toBe(202);
  expect(body.taskId).toBe("deploy.shared-volume.wrangler");
  expect(app.runStore.listRuns(5)).toHaveLength(2);

  app.runStore.close();
});

test("registry APIs expose canonical task and preset ids", async () => {
  const app = await createTestServerApp();

  const [tasksResponse, presetsResponse, summaryResponse] = await Promise.all([
    app.fetch(
      new Request("http://hooka.local/api/tasks", {
        headers: createAdminHeaders(),
      }),
    ),
    app.fetch(
      new Request("http://hooka.local/api/presets", {
        headers: createAdminHeaders(),
      }),
    ),
    app.fetch(
      new Request("http://hooka.local/api/summary", {
        headers: createAdminHeaders(),
      }),
    ),
  ]);

  const tasks = (await tasksResponse.json()) as Array<{ id: string }>;
  const presets = (await presetsResponse.json()) as Array<{ id: string }>;
  const summary = (await summaryResponse.json()) as {
    tasks: Array<{ id: string }>;
    presets: Array<{ id: string }>;
  };

  expect(tasks.map((task) => task.id)).toContain(
    "deploy.shared-volume.wrangler",
  );
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
    app.fetch(
      new Request("http://hooka.local/api/runs?status=succeeded", {
        headers: createAdminHeaders(),
      }),
    ),
    app.fetch(
      new Request(
        "http://hooka.local/api/runs?taskId=cloudflare.cache.purge.urls",
        {
          headers: createAdminHeaders(),
        },
      ),
    ),
    app.fetch(
      new Request("http://hooka.local/api/runs?source=wordpress.webhook", {
        headers: createAdminHeaders(),
      }),
    ),
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
