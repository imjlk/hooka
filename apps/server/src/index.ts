import {
  assertServerStartupConfig,
  createServerConfig,
  getServerStartupIssues,
} from "@hooka/config";
import { createLogger } from "@hooka/logger";
import { createRunStore } from "@hooka/run-store";
import { createInstalledCapabilitiesLoader } from "@hooka/runner-core";
import { createHookaFetchHandler } from "./app";
import { registerServerShutdownHandlers } from "./shutdown";

const config = createServerConfig();
const logger = createLogger({
  service: "hooka-server",
  runtimeRole: config.runtimeRole,
});
const startupIssues = getServerStartupIssues(config);

if (startupIssues.length > 0) {
  logger.error("Server startup validation failed", {
    issues: startupIssues,
  });
}

assertServerStartupConfig(config);
const runStore = await createRunStore({
  dbPath: config.dbPath,
});
const loadCapabilities = createInstalledCapabilitiesLoader(1_000);

const server = Bun.serve({
  port: config.port,
  idleTimeout: 30,
  fetch: createHookaFetchHandler({
    adminToken: config.adminToken,
    apiRateLimit: config.apiRateLimit,
    capabilityManifestPath: config.capabilityManifestPath,
    corsOrigins: config.corsOrigins,
    defaultMaxAttempts: config.maxAttempts,
    globalApiRateLimit: config.globalApiRateLimit,
    globalWebhookRateLimit: config.globalWebhookRateLimit,
    loadCapabilities,
    rateLimitWindowMs: config.rateLimitWindowMs,
    maxBodyBytes: config.maxBodyBytes,
    runStore,
    targetsPath: config.targetsPath,
    trustProxy: config.trustProxy,
    uiDistDir: config.uiDistDir,
    webhookRateLimit: config.webhookRateLimit,
    webhookSecret: config.webhookSecret,
    logger,
  }),
});

registerServerShutdownHandlers({
  server,
  runStore,
  logger,
});

logger.info("Server started", {
  port: server.port,
  dbPath: config.dbPath,
  capabilityManifestPath: config.capabilityManifestPath,
  targetsPath: config.targetsPath,
  maxAttempts: config.maxAttempts,
  trustProxy: config.trustProxy,
  rateLimitWindowMs: config.rateLimitWindowMs,
  apiRateLimit: config.apiRateLimit,
  webhookRateLimit: config.webhookRateLimit,
  globalApiRateLimit: config.globalApiRateLimit,
  globalWebhookRateLimit: config.globalWebhookRateLimit,
  corsOrigins: config.corsOrigins,
  maxBodyBytes: config.maxBodyBytes,
});
