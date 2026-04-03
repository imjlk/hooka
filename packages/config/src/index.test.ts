import { expect, test } from "bun:test";
import {
  assertServerStartupConfig,
  createAdminUiDevConfig,
  createCliConfig,
  createServerConfig,
  createWorkerConfig,
  defaultLocalDbRelativePath,
  defaultManifestRelativePath,
  defaultRetryBaseDelayMs,
  defaultTargetsRelativePath,
  defaultWorkerHeartbeatIntervalMs,
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
