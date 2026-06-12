import { expect, test } from "bun:test";
import { createTempDir, ensureDir } from "@hooka/bun-utils";
import { createRunStore } from "@hooka/run-store";
import { createHmac } from "node:crypto";
import { join } from "node:path";
import { createHookaFetchHandler } from "./app";

async function createTestServerApp(
  input: {
    targets?: unknown[];
    adminToken?: string | null;
    trustProxy?: boolean;
    apiRateLimit?: number;
    globalApiRateLimit?: number;
    webhookRateLimit?: number;
    globalWebhookRateLimit?: number;
    maxBodyBytes?: number;
    corsOrigins?: string[];
    webhookSecret?: string | null;
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

  const adminToken =
    input.adminToken === null ? undefined : (input.adminToken ?? "admin-token");
  const webhookSecret =
    input.webhookSecret === null
      ? undefined
      : (input.webhookSecret ?? "secret");

  return {
    fetch: createHookaFetchHandler({
      adminToken,
      apiRateLimit: input.apiRateLimit ?? 120,
      capabilityManifestPath: manifestPath,
      corsOrigins: input.corsOrigins ?? [],
      defaultMaxAttempts: 3,
      globalApiRateLimit: input.globalApiRateLimit ?? 1_200,
      globalWebhookRateLimit: input.globalWebhookRateLimit ?? 600,
      maxBodyBytes: input.maxBodyBytes ?? 1_048_576,
      rateLimitWindowMs: 60_000,
      runStore,
      targetsPath,
      trustProxy: input.trustProxy ?? false,
      uiDistDir,
      webhookRateLimit: input.webhookRateLimit ?? 60,
      webhookSecret,
    }),
    runStore,
  };
}

function createAdminHeaders(): HeadersInit {
  return {
    authorization: "Bearer admin-token",
  };
}

function createSignedWebhookRequest(
  url: string,
  body: string,
  secret = "secret",
): Request {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHmac("sha256", secret)
    .update(`${timestamp}.${body}`)
    .digest("hex");

  return new Request(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-hooka-timestamp": timestamp,
      "x-hooka-signature": `sha256=${signature}`,
    },
    body,
  });
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

test("admin routes surface server misconfiguration when the admin token is missing", async () => {
  const app = await createTestServerApp({
    adminToken: null,
  });
  const response = await app.fetch(
    new Request("http://hooka.local/api/summary", {
      headers: createAdminHeaders(),
    }),
  );
  const body = await response.json();

  expect(response.status).toBe(503);
  expect(body.error).toContain("HOOKA_ADMIN_TOKEN");
  expect(app.runStore.listAuditEvents({ limit: 5 })).toHaveLength(0);

  app.runStore.close();
});

test("API routes reject payloads larger than the configured limit", async () => {
  const app = await createTestServerApp({
    maxBodyBytes: 32,
  });
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
  const body = await response.json();

  expect(response.status).toBe(413);
  expect(body).toMatchObject({
    ok: false,
    error: "Payload too large.",
  });

  app.runStore.close();
});

test("API routes reject streamed payloads larger than the configured limit", async () => {
  const app = await createTestServerApp({
    maxBodyBytes: 32,
  });
  const oversizedBody = JSON.stringify({
    taskId: "deploy.shared-volume.wrangler",
    input: {
      kind: "pages-deploy",
      project: "streamed-site",
      sourcePath: "/shared-source/streamed-site",
    },
  });
  const response = await app.fetch(
    new Request("http://hooka.local/api/runs", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...createAdminHeaders(),
      },
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(oversizedBody));
          controller.close();
        },
      }),
    }),
  );
  const body = await response.json();

  expect(response.status).toBe(413);
  expect(body).toMatchObject({
    ok: false,
    error: "Payload too large.",
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

test("openapi endpoint is public and exposes the machine-readable API spec", async () => {
  const app = await createTestServerApp();
  const response = await app.fetch(
    new Request("http://hooka.local/api/openapi.json"),
  );
  const body = await response.json();

  expect(response.status).toBe(200);
  expect(body.openapi).toBe("3.1.0");
  expect(body.paths["/api/events/ticket"]).toBeDefined();
  expect(body.paths["/api/openapi.json"]).toBeDefined();

  app.runStore.close();
});

test("event streams require a one-time ticket instead of the admin token query param", async () => {
  const app = await createTestServerApp();

  const ticketResponse = await app.fetch(
    new Request("http://hooka.local/api/events/ticket", {
      method: "POST",
      headers: createAdminHeaders(),
    }),
  );
  const { ticket } = (await ticketResponse.json()) as { ticket: string };
  expect(ticketResponse.status).toBe(200);

  const streamResponse = await app.fetch(
    new Request(`http://hooka.local/api/events/stream?ticket=${ticket}`),
  );
  expect(streamResponse.status).toBe(200);
  expect(streamResponse.headers.get("content-type")).toContain(
    "text/event-stream",
  );

  const reader = streamResponse.body?.getReader();
  const chunk = await reader?.read();
  const text = chunk?.value ? new TextDecoder().decode(chunk.value) : "";
  expect(text).toContain("event: ready");
  await reader?.cancel();

  const reusedResponse = await app.fetch(
    new Request(`http://hooka.local/api/events/stream?ticket=${ticket}`),
  );
  expect(reusedResponse.status).toBe(401);

  const queryTokenResponse = await app.fetch(
    new Request("http://hooka.local/api/events/stream?token=admin-token"),
  );
  expect(queryTokenResponse.status).toBe(401);

  app.runStore.close();
});

test("event stream ticket rejections record whether a ticket was reused", async () => {
  const app = await createTestServerApp();
  const ticketResponse = await app.fetch(
    new Request("http://hooka.local/api/events/ticket", {
      method: "POST",
      headers: createAdminHeaders(),
    }),
  );
  const { ticket } = (await ticketResponse.json()) as { ticket: string };

  const streamResponse = await app.fetch(
    new Request(`http://hooka.local/api/events/stream?ticket=${ticket}`),
  );
  await streamResponse.body?.cancel();

  const reusedResponse = await app.fetch(
    new Request(`http://hooka.local/api/events/stream?ticket=${ticket}`),
  );
  expect(reusedResponse.status).toBe(401);

  const auditEvents = app.runStore.listAuditEvents({ limit: 5 });
  expect(auditEvents[0]).toMatchObject({
    action: "event_stream_ticket_rejected",
    outcome: "rejected",
  });
  expect(auditEvents[0]?.context).toMatchObject({
    reason: "reused",
  });

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

test("unexpected server errors are masked from clients", async () => {
  const app = await createTestServerApp();
  const original = app.runStore.queryRuns.bind(app.runStore);
  app.runStore.queryRuns = (() => {
    throw new Error("top secret stack detail");
  }) as typeof app.runStore.queryRuns;

  const response = await app.fetch(
    new Request("http://hooka.local/api/runs", {
      headers: createAdminHeaders(),
    }),
  );
  const body = await response.json();

  expect(response.status).toBe(500);
  expect(body).toMatchObject({
    ok: false,
    error: "Internal server error",
  });

  app.runStore.queryRuns = original;
  app.runStore.close();
});

test("allowed CORS origins receive preflight and response headers", async () => {
  const app = await createTestServerApp({
    corsOrigins: ["https://admin.example.com"],
  });

  const preflight = await app.fetch(
    new Request("http://hooka.local/api/runs", {
      method: "OPTIONS",
      headers: {
        origin: "https://admin.example.com",
        "access-control-request-method": "POST",
      },
    }),
  );
  expect(preflight.status).toBe(204);
  expect(preflight.headers.get("access-control-allow-origin")).toBe(
    "https://admin.example.com",
  );

  const response = await app.fetch(
    new Request("http://hooka.local/api/summary", {
      headers: {
        ...createAdminHeaders(),
        origin: "https://admin.example.com",
      },
    }),
  );
  expect(response.status).toBe(200);
  expect(response.headers.get("access-control-allow-origin")).toBe(
    "https://admin.example.com",
  );
  expect(response.headers.get("content-security-policy")).toContain(
    "default-src 'self'",
  );

  app.runStore.close();
});

test("global API rate limits reject distributed request bursts", async () => {
  const app = await createTestServerApp({
    apiRateLimit: 10,
    globalApiRateLimit: 2,
  });

  const first = await app.fetch(
    new Request("http://hooka.local/api/summary", {
      headers: {
        ...createAdminHeaders(),
        "x-real-ip": "198.51.100.1",
        "user-agent": "agent-a",
      },
    }),
  );
  const second = await app.fetch(
    new Request("http://hooka.local/api/summary", {
      headers: {
        ...createAdminHeaders(),
        "x-real-ip": "198.51.100.2",
        "user-agent": "agent-b",
      },
    }),
  );
  const third = await app.fetch(
    new Request("http://hooka.local/api/summary", {
      headers: {
        ...createAdminHeaders(),
        "x-real-ip": "198.51.100.3",
        "user-agent": "agent-c",
      },
    }),
  );

  expect(first.status).toBe(200);
  expect(second.status).toBe(200);
  expect(third.status).toBe(429);

  const auditEvents = app.runStore.listAuditEvents({ limit: 5 });
  expect(auditEvents[0]).toMatchObject({
    action: "rate_limit_rejected",
    outcome: "rejected",
  });
  expect(auditEvents[0]?.context).toMatchObject({
    scope: "global",
  });

  app.runStore.close();
});

test("proxy headers only affect rate limiting when trust proxy is enabled", async () => {
  const untrusted = await createTestServerApp({
    apiRateLimit: 1,
    trustProxy: false,
  });

  const firstUntrusted = await untrusted.fetch(
    new Request("http://hooka.local/api/summary", {
      headers: {
        ...createAdminHeaders(),
        "x-forwarded-for": "198.51.100.10",
        "user-agent": "shared-agent",
      },
    }),
  );
  const secondUntrusted = await untrusted.fetch(
    new Request("http://hooka.local/api/summary", {
      headers: {
        ...createAdminHeaders(),
        "x-forwarded-for": "198.51.100.11",
        "user-agent": "shared-agent",
      },
    }),
  );

  expect(firstUntrusted.status).toBe(200);
  expect(secondUntrusted.status).toBe(429);
  expect(untrusted.runStore.listAuditEvents({ limit: 5 })[0]).toMatchObject({
    clientIp: "unknown",
  });

  untrusted.runStore.close();

  const trusted = await createTestServerApp({
    apiRateLimit: 1,
    trustProxy: true,
  });
  const firstTrusted = await trusted.fetch(
    new Request("http://hooka.local/api/summary", {
      headers: {
        ...createAdminHeaders(),
        "x-forwarded-for": "198.51.100.20",
        "user-agent": "shared-agent",
      },
    }),
  );
  const secondTrusted = await trusted.fetch(
    new Request("http://hooka.local/api/summary", {
      headers: {
        ...createAdminHeaders(),
        "x-forwarded-for": "198.51.100.21",
        "user-agent": "shared-agent",
      },
    }),
  );

  expect(firstTrusted.status).toBe(200);
  expect(secondTrusted.status).toBe(200);

  trusted.runStore.close();
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

test("wordpress alias can enqueue through a configured target", async () => {
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
          allowedDestinationPrefixes: [],
          allowedBranches: ["main"],
          allowedOverrideFields: ["project", "sourcePath", "branch"],
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
    eventId: "evt_wp_target_1",
    project: "main-site",
    exportDir: "/shared-source/main-site",
    branch: "main",
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
  const run = app.runStore.listRuns()[0];
  expect(run?.targetId).toBe("pages-main");
  expect(run?.taskId).toBe("deploy.shared-volume.wrangler");
  expect(run?.source).toBe("wordpress.webhook");
  expect(run?.maxAttempts).toBe(4);

  app.runStore.close();
});

test("trailbase assets webhook accepts internal bearer secret", async () => {
  const app = await createTestServerApp();
  const response = await app.fetch(
    new Request("http://hooka.local/api/webhooks/trailbase/assets-drained", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer secret",
      },
      body: JSON.stringify({
        idempotencyKey:
          "asset-drain:v2:latest:123:ready:10:failed:2:static:456:7",
        project: "zero-three-three-assets",
        branch: "production",
        sourcePath: "/shared-source/trailbase/uploads",
        readyCount: 10,
        failedCount: 2,
        latestAssetUpdatedAt: 123,
        staticRevision: "456:7",
      }),
    }),
  );

  expect(response.status).toBe(202);
  const runs = app.runStore.listRuns();
  expect(runs[0]?.taskId).toBe("deploy.trailbase-pages.full");
  expect(runs[0]?.source).toBe("zero-three-three.asset_generation_drained");
  expect(runs[0]?.sourceEventId).toBe(
    "asset-drain:v2:latest:123:ready:10:failed:2:static:456:7",
  );

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
          allowedDestinationPrefixes: [],
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
      allowedDestinationPrefixes: [],
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

test("webhook routes surface server misconfiguration when the secret is missing", async () => {
  const app = await createTestServerApp({
    webhookSecret: null,
  });
  const payload = JSON.stringify({
    taskId: "deploy.shared-volume.wrangler",
    input: {
      kind: "pages-deploy",
      project: "staging-site",
      sourcePath: "/shared-source/simply-static",
    },
    eventId: "evt_missing_secret",
    source: "webhook",
  });
  const response = await app.fetch(
    createSignedWebhookRequest("http://hooka.local/api/webhooks/task", payload),
  );
  const body = await response.json();

  expect(response.status).toBe(503);
  expect(body.error).toContain("HOOKA_WEBHOOK_SECRET");

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
          allowedDestinationPrefixes: [],
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
          allowedDestinationPrefixes: [],
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

test("summary excludes stale worker heartbeats after retention cleanup", async () => {
  const app = await createTestServerApp();

  app.runStore.db
    .query(
      `insert into worker_heartbeats (
        worker_id,
        runtime_role,
        installed_capabilities_json,
        last_seen_at,
        current_run_id
      ) values (?, ?, ?, ?, ?)`,
    )
    .run(
      "worker-old",
      "worker:legacy",
      JSON.stringify(["wrangler"]),
      "2026-03-01T00:00:00.000Z",
      null,
    );
  app.runStore.db
    .query(
      `insert into worker_heartbeats (
        worker_id,
        runtime_role,
        installed_capabilities_json,
        last_seen_at,
        current_run_id
      ) values (?, ?, ?, ?, ?)`,
    )
    .run(
      "worker-new",
      "worker:cf-pages",
      JSON.stringify(["wrangler"]),
      "2026-04-30T00:00:00.000Z",
      null,
    );

  const cleanup = app.runStore.cleanupRetention({
    workerHeartbeatSeenBefore: "2026-04-01T00:00:00.000Z",
  });
  const summaryResponse = await app.fetch(
    new Request("http://hooka.local/api/summary", {
      headers: createAdminHeaders(),
    }),
  );
  const summary = await summaryResponse.json();

  expect(cleanup.deletedWorkerHeartbeats).toBe(1);
  expect(summary.workers).toEqual([
    expect.objectContaining({
      workerId: "worker-new",
    }),
  ]);

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
    "rclone-sync",
    "wp-wrangler",
  ]);
  expect(presets.map((preset) => preset.id)).not.toContain("webhook-wrangler");
  expect(presets.map((preset) => preset.id)).not.toContain("cf-wrangler");
  expect(summary.tasks.map((task) => task.id)).toContain(
    "deploy.shared-volume.wrangler",
  );
  expect(summary.presets.map((preset) => preset.id)).toContain("cf-pages");
  expect(summary.presets.map((preset) => preset.id)).toContain("cf-cache");
  expect(summary.presets.map((preset) => preset.id)).toContain("rclone-sync");
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
