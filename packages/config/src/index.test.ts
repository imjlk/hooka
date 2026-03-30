import { expect, test } from "bun:test";
import {
  createAdminUiDevConfig,
  createCliConfig,
  createServerConfig,
  createWorkerConfig,
  defaultManifestRelativePath,
} from "./index";

test("createServerConfig applies defaults and resolves cwd-based paths", () => {
  const config = createServerConfig({
    cwd: "/repo",
    env: {},
  });

  expect(config).toEqual({
    port: 3000,
    dbPath: "/data/hooka.sqlite",
    runtimeRole: "hooka-server",
    webhookSecret: undefined,
    capabilityManifestPath: `/repo/${defaultManifestRelativePath}`,
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
    workerId: "worker-host",
    pollIntervalMs: 5000,
    leaseMs: 120000,
  });
});

test("createCliConfig resolves manifest and db defaults", () => {
  const config = createCliConfig({
    cwd: "/repo",
    env: {},
  });

  expect(config).toEqual({
    dbPath: "/data/hooka.sqlite",
    manifestPath: `/repo/${defaultManifestRelativePath}`,
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
