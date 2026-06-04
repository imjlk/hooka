import { expect, test } from "bun:test";
import {
  assertServerStartupConfig,
  createAdminUiDevConfig,
  createCliConfig,
  createServerConfig,
  createWorkerConfig,
  defaultApiRateLimit,
  defaultGlobalApiRateLimit,
  defaultGlobalWebhookRateLimit,
  defaultLocalDbRelativePath,
  defaultMaxBodyBytes,
  defaultManifestRelativePath,
  defaultRateLimitWindowMs,
  defaultRetentionAuditDays,
  defaultRetentionRunDays,
  defaultRetentionSweepIntervalHours,
  defaultRetryBaseDelayMs,
  defaultTargetsRelativePath,
  defaultWebhookRateLimit,
  defaultWorkerHeartbeatIntervalMs,
  getWorkerFreshness,
  getWorkerFreshnessThresholdMs,
  getWorkerLastSeenAgeMs,
  getServerStartupIssues,
  resolveManifestSource,
} from "./index";

test("createServerConfig applies defaults and resolves cwd-based paths", () => {
  const config = createServerConfig({
    cwd: "/repo",
    env: {},
  });

  expect(config).toEqual({
    port: 3000,
    dbPath: `/repo/${defaultLocalDbRelativePath}`,
    runtimeRole: "hooka-server",
    webhookSecret: undefined,
    adminToken: undefined,
    maxAttempts: 3,
    trustProxy: false,
    rateLimitWindowMs: defaultRateLimitWindowMs,
    apiRateLimit: defaultApiRateLimit,
    webhookRateLimit: defaultWebhookRateLimit,
    globalApiRateLimit: defaultGlobalApiRateLimit,
    globalWebhookRateLimit: defaultGlobalWebhookRateLimit,
    corsOrigins: [],
    maxBodyBytes: defaultMaxBodyBytes,
    capabilityManifestPath: `/repo/${defaultManifestRelativePath}`,
    targetsPath: `/repo/${defaultTargetsRelativePath}`,
    uiDistDir: "/repo/packages/admin-ui/dist",
  });
});

test("createWorkerConfig uses env overrides and derived worker id", () => {
  const config = createWorkerConfig({
    cwd: "/repo",
    env: {
      HOOKA_DB_PATH: "/tmp/hooka.sqlite",
      HOOKA_RUNTIME_ROLE: "cf-pages-worker",
      HOOKA_MANIFEST_PATH: "tmp/manifest.json",
      HOOKA_POLL_INTERVAL_MS: "5000",
      HOOKA_RUN_LEASE_MS: "120000",
      HOSTNAME: "worker-host",
    },
  });

  expect(config).toEqual({
    dbPath: "/tmp/hooka.sqlite",
    runtimeRole: "cf-pages-worker",
    manifestPath: "/repo/tmp/manifest.json",
    targetsPath: `/repo/${defaultTargetsRelativePath}`,
    workerId: "worker-host",
    pollIntervalMs: 5000,
    leaseMs: 120000,
    maxAttempts: 3,
    retryBaseDelayMs: defaultRetryBaseDelayMs,
    heartbeatIntervalMs: defaultWorkerHeartbeatIntervalMs,
    retentionRunDays: defaultRetentionRunDays,
    retentionAuditDays: defaultRetentionAuditDays,
    retentionSweepIntervalHours: defaultRetentionSweepIntervalHours,
  });
});

test("createCliConfig resolves manifest and db defaults", () => {
  const config = createCliConfig({
    cwd: "/repo",
    env: {},
  });

  expect(config).toEqual({
    dbPath: `/repo/${defaultLocalDbRelativePath}`,
    manifestPath: `/repo/${defaultManifestRelativePath}`,
    targetsPath: `/repo/${defaultTargetsRelativePath}`,
    retentionRunDays: defaultRetentionRunDays,
    retentionAuditDays: defaultRetentionAuditDays,
  });
});

test("createAdminUiDevConfig keeps local Bun HMR defaults", () => {
  const config = createAdminUiDevConfig({
    env: {},
  });

  expect(config).toEqual({
    uiPort: 4310,
    apiOrigin: "http://127.0.0.1:3000",
  });
});

test("resolveManifestSource distinguishes env override and manifest file precedence", () => {
  expect(
    resolveManifestSource({
      cwd: "/repo",
      env: {
        HOOKA_INSTALLED_CAPABILITIES: "wrangler",
      },
    }),
  ).toEqual({
    kind: "env-inline",
    manifestPath: `/repo/${defaultManifestRelativePath}`,
  });

  expect(
    resolveManifestSource({
      cwd: "/repo",
      env: {
        HOOKA_MANIFEST_PATH: "tmp/custom.json",
      },
    }),
  ).toEqual({
    kind: "manifest-explicit",
    manifestPath: "/repo/tmp/custom.json",
  });
});

test("server startup validation requires a webhook secret", () => {
  const config = createServerConfig({
    cwd: "/repo",
    env: {},
  });

  expect(getServerStartupIssues(config)).toEqual([
    "HOOKA_WEBHOOK_SECRET is required.",
    "HOOKA_ADMIN_TOKEN is required.",
  ]);
  expect(() => assertServerStartupConfig(config)).toThrow(
    "HOOKA_WEBHOOK_SECRET is required. HOOKA_ADMIN_TOKEN is required.",
  );
});

test("worker freshness helpers derive age and threshold state", () => {
  const now = Date.parse("2026-04-04T12:00:00.000Z");
  const lastSeenAt = "2026-04-04T11:59:55.000Z";

  expect(getWorkerFreshnessThresholdMs(10_000)).toBe(20_000);
  expect(getWorkerLastSeenAgeMs(lastSeenAt, now)).toBe(5_000);
  expect(getWorkerFreshness(lastSeenAt, 10_000, now)).toBe("healthy");
  expect(getWorkerFreshness(lastSeenAt, 2_000, now)).toBe("stale");
});

test("createServerConfig rejects invalid numeric env values", () => {
  expect(() =>
    createServerConfig({
      cwd: "/repo",
      env: {
        HOOKA_PORT: "abc",
        HOOKA_MAX_BODY_BYTES: "NaN",
      },
    }),
  ).toThrow("Invalid numeric value for HOOKA_PORT: abc");

  const validConfig = createServerConfig({
    cwd: "/repo",
    env: {
      HOOKA_CORS_ORIGINS: "https://admin.example.com, https://ops.example.com",
    },
  });

  expect(validConfig.maxBodyBytes).toBe(defaultMaxBodyBytes);
  expect(validConfig.corsOrigins).toEqual([
    "https://admin.example.com",
    "https://ops.example.com",
  ]);
});
