import { expect, test } from "bun:test";
import { createTempDir, ensureDir } from "@hooka/bun-utils";
import { createRunStore } from "@hooka/run-store";
import { join } from "node:path";
import { createHookaFetchHandler, type RequestAddressSource } from "./app";

async function createFloodTestApp(input: {
  apiRateLimit: number;
  globalApiRateLimit: number;
}) {
  const tempDir = await createTempDir("hooka-server-flood");
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
  await Bun.write(join(uiDistDir, "index.html"), "<!doctype html>");
  await Bun.write(targetsPath, JSON.stringify({ targets: [] }));

  return {
    fetch: createHookaFetchHandler({
      adminToken: "admin-token",
      apiRateLimit: input.apiRateLimit,
      capabilityManifestPath: manifestPath,
      corsOrigins: [],
      defaultMaxAttempts: 3,
      globalApiRateLimit: input.globalApiRateLimit,
      globalWebhookRateLimit: 600,
      maxBodyBytes: 1_048_576,
      rateLimitWindowMs: 60_000,
      runStore,
      targetsPath,
      trustProxy: false,
      uiDistDir,
      webhookRateLimit: 60,
      webhookSecret: "secret",
    }),
    runStore,
  };
}

function peer(address: string): RequestAddressSource {
  return {
    requestIP: () => ({ address }),
  };
}

test("one client rotating user agents cannot spend the global budget", async () => {
  const app = await createFloodTestApp({
    apiRateLimit: 3,
    globalApiRateLimit: 10,
  });

  for (let index = 0; index < 50; index += 1) {
    await app.fetch(
      new Request("http://hooka.local/api/summary", {
        headers: { "user-agent": `flood-${index}` },
      }),
      peer("203.0.113.66"),
    );
  }

  const legitimate = await app.fetch(
    new Request("http://hooka.local/api/summary", {
      headers: { authorization: "Bearer admin-token" },
    }),
    peer("198.51.100.20"),
  );

  expect(legitimate.status).toBe(200);
  app.runStore.close();
});

test("a flood of rejected requests writes one audit row per client and window", async () => {
  const app = await createFloodTestApp({
    apiRateLimit: 1_000,
    globalApiRateLimit: 10_000,
  });

  for (let index = 0; index < 40; index += 1) {
    const response = await app.fetch(
      new Request("http://hooka.local/api/summary"),
      peer("203.0.113.66"),
    );
    expect(response.status).toBe(401);
  }
  await app.fetch(
    new Request("http://hooka.local/api/summary"),
    peer("203.0.113.67"),
  );

  const rejections = app.runStore.listAuditEvents({
    category: "security",
    limit: 100,
  });
  expect(
    rejections.map((event) => [event.action, event.clientIp]).sort(),
  ).toEqual([
    ["admin_auth_rejected", "203.0.113.66"],
    ["admin_auth_rejected", "203.0.113.67"],
  ]);

  app.runStore.close();
});
