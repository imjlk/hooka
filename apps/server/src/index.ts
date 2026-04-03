import {
  assertServerStartupConfig,
  createServerConfig,
  getServerStartupIssues,
} from "@hooka/config";
import { createLogger } from "@hooka/logger";
import { createRunStore } from "@hooka/run-store";
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

const server = Bun.serve({
  port: config.port,
  idleTimeout: 30,
  fetch: createHookaFetchHandler({
    capabilityManifestPath: config.capabilityManifestPath,
    runStore,
    uiDistDir: config.uiDistDir,
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
});
