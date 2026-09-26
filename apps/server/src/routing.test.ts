import { expect, test } from "bun:test";
import { createTempDir, ensureDir } from "@hooka/bun-utils";
import type { Logger } from "@hooka/logger";
import { listWebhookAdapters } from "@hooka/registry";
import { createRunStore } from "@hooka/run-store";
import { join } from "node:path";
import { createHookaFetchHandler } from "./app";

const adminHeaders = {
  authorization: "Bearer admin-token",
};

async function createRoutingTestApp(
  input: { eventStreamKeepaliveMs?: number; logger?: Logger } = {},
) {
  const tempDir = await createTempDir("hooka-server-routing");
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
      generatedAt: "2026-09-26T00:00:00.000Z",
      installed: ["wrangler"],
    }),
  );
  await ensureDir(uiDistDir);
  await Bun.write(
    join(uiDistDir, "index.html"),
    "<!doctype html><html></html>",
  );
  await Bun.write(targetsPath, JSON.stringify({ targets: [] }));

  return {
    fetch: createHookaFetchHandler({
      adminToken: "admin-token",
      apiRateLimit: 1_000,
      capabilityManifestPath: manifestPath,
      corsOrigins: [],
      defaultMaxAttempts: 3,
      eventStreamKeepaliveMs: input.eventStreamKeepaliveMs,
      globalApiRateLimit: 10_000,
      globalWebhookRateLimit: 10_000,
      logger: input.logger,
      maxBodyBytes: 1_048_576,
      rateLimitWindowMs: 60_000,
      runStore,
      targetsPath,
      trustProxy: false,
      uiDistDir,
      webhookRateLimit: 1_000,
      webhookSecret: "secret",
    }),
    runStore,
    targetsPath,
  };
}

test("unknown API paths return JSON 404 instead of the admin UI", async () => {
  const app = await createRoutingTestApp();

  const unknown = await app.fetch(
    new Request("http://hooka.local/api/nope", {
      headers: adminHeaders,
    }),
  );
  // A trailing slash on a webhook URL is public (POST /api/webhooks/*) and
  // used to answer 200 with the UI shell while enqueueing nothing.
  const typoWebhook = await app.fetch(
    new Request("http://hooka.local/api/webhooks/wordpress/simply-static/", {
      method: "POST",
      body: "{}",
    }),
  );

  expect(unknown.status).toBe(404);
  expect(unknown.headers.get("content-type")).toContain("application/json");
  expect(typoWebhook.status).toBe(404);
  expect(await typoWebhook.json()).toMatchObject({ ok: false });
  expect(app.runStore.listRuns(5)).toHaveLength(0);

  app.runStore.close();
});

test("known API paths with the wrong method return 405 with Allow", async () => {
  const app = await createRoutingTestApp();

  const retry = await app.fetch(
    new Request("http://hooka.local/api/runs/run-1/retry", {
      headers: adminHeaders,
    }),
  );
  const targets = await app.fetch(
    new Request("http://hooka.local/api/targets", {
      method: "PATCH",
      headers: adminHeaders,
    }),
  );

  expect(retry.status).toBe(405);
  expect(retry.headers.get("allow")).toBe("POST");
  expect(targets.status).toBe(405);
  expect(targets.headers.get("allow")).toBe("GET, HEAD, POST");

  app.runStore.close();
});

test("HEAD requests follow the GET route without a body", async () => {
  const app = await createRoutingTestApp();

  const health = await app.fetch(
    new Request("http://hooka.local/api/health", {
      method: "HEAD",
    }),
  );
  expect(health.status).toBe(200);
  expect(await health.text()).toBe("");

  app.runStore.close();
  const ready = await app.fetch(
    new Request("http://hooka.local/api/ready", {
      method: "HEAD",
    }),
  );
  expect(ready.status).toBe(503);
});

test("invalid request data is a 400, corrupt server state is a logged 500", async () => {
  const errors: string[] = [];
  const app = await createRoutingTestApp({
    logger: {
      info() {},
      warn() {},
      error(message) {
        errors.push(message);
      },
    },
  });

  const badJson = await app.fetch(
    new Request("http://hooka.local/api/runs", {
      method: "POST",
      headers: adminHeaders,
      body: "{",
    }),
  );
  const badQuery = await app.fetch(
    new Request("http://hooka.local/api/runs?status=bogus", {
      headers: adminHeaders,
    }),
  );
  expect(badJson.status).toBe(400);
  expect(badQuery.status).toBe(400);
  expect(errors).toHaveLength(0);

  await Bun.write(app.targetsPath, "{ not json");
  const corruptTargets = await app.fetch(
    new Request("http://hooka.local/api/targets", {
      headers: adminHeaders,
    }),
  );
  expect(corruptTargets.status).toBe(500);
  expect(await corruptTargets.json()).toEqual({
    ok: false,
    error: "Internal server error",
  });
  expect(errors).toEqual(["Request failed unexpectedly"]);

  app.runStore.close();
});

test("target ids in the URL are percent-decoded", async () => {
  const app = await createRoutingTestApp();
  const target = {
    id: "site:prod",
    title: "Site prod",
    taskId: "deploy.shared-volume.wrangler",
    defaultInput: {
      kind: "pages-deploy",
      project: "site",
      sourcePath: "/shared-source/site",
    },
  };

  const created = await app.fetch(
    new Request("http://hooka.local/api/targets", {
      method: "POST",
      headers: {
        ...adminHeaders,
        "content-type": "application/json",
      },
      body: JSON.stringify(target),
    }),
  );
  const detail = await app.fetch(
    new Request(
      `http://hooka.local/api/targets/${encodeURIComponent(target.id)}`,
      {
        headers: adminHeaders,
      },
    ),
  );
  const malformed = await app.fetch(
    new Request("http://hooka.local/api/targets/%E0%A4%A", {
      headers: adminHeaders,
    }),
  );
  const deleted = await app.fetch(
    new Request(
      `http://hooka.local/api/targets/${encodeURIComponent(target.id)}`,
      {
        method: "DELETE",
        headers: adminHeaders,
      },
    ),
  );

  expect(created.status).toBe(201);
  expect(detail.status).toBe(200);
  expect((await detail.json()).id).toBe("site:prod");
  expect(malformed.status).toBe(400);
  expect(deleted.status).toBe(200);

  app.runStore.close();
});

test("admin 401 responses carry a bearer challenge", async () => {
  const app = await createRoutingTestApp();

  const response = await app.fetch(new Request("http://hooka.local/api/runs"));

  expect(response.status).toBe(401);
  expect(response.headers.get("www-authenticate")).toBe('Bearer realm="hooka"');

  app.runStore.close();
});

test("the OpenAPI document lists every compatibility webhook route", async () => {
  const app = await createRoutingTestApp();

  const response = await app.fetch(
    new Request("http://hooka.local/api/openapi.json"),
  );
  const document = await response.json();
  const adapterRoutes = listWebhookAdapters().map(
    (adapter) => adapter.routePath,
  );

  expect(adapterRoutes).toContain("/api/webhooks/trailbase/assets-drained");
  for (const routePath of adapterRoutes) {
    expect(document.paths[routePath]?.post).toBeDefined();
  }
  expect(document.paths["/api/targets"].post.responses[201]).toBeDefined();

  app.runStore.close();
});

test("quiet event streams send keepalive comments", async () => {
  const app = await createRoutingTestApp({
    eventStreamKeepaliveMs: 0,
  });
  const ticketResponse = await app.fetch(
    new Request("http://hooka.local/api/events/ticket", {
      method: "POST",
      headers: adminHeaders,
    }),
  );
  const { ticket } = await ticketResponse.json();
  const controller = new AbortController();
  const stream = await app.fetch(
    new Request(`http://hooka.local/api/events/stream?ticket=${ticket}`, {
      signal: controller.signal,
    }),
  );
  const reader = stream.body?.getReader();
  const decoder = new TextDecoder();
  let received = "";

  const deadline = Date.now() + 5_000;
  while (reader && !received.includes(": keepalive") && Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }
    received += decoder.decode(value);
  }

  controller.abort();
  await reader?.cancel();
  expect(received).toContain("event: ready");
  expect(received).toContain(": keepalive");

  app.runStore.close();
});
