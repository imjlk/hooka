import { createWorkerConfig } from "@hooka/config";
import { createLogger } from "@hooka/logger";
import { listCapabilities, listPresets, listTasks } from "@hooka/registry";
import { findMissingCapabilityEnvRequirements } from "@hooka/runtime-contracts";
import { createRunStore } from "@hooka/run-store";
import { loadInstalledCapabilities } from "@hooka/runner-core";
import { startWorkerLoop } from "./lib/worker";
import { registerWorkerShutdownHandlers } from "./lib/shutdown";

const config = createWorkerConfig();
const logger = createLogger({
  service: "hooka-worker",
  runtimeRole: config.runtimeRole,
});
const runStore = await createRunStore({
  dbPath: config.dbPath,
});
const shutdownSignal = registerWorkerShutdownHandlers({
  logger,
});
const manifest = await loadInstalledCapabilities(config.manifestPath);

const missingEnv = findMissingCapabilityEnvRequirements(
  listCapabilities(),
  manifest.installed,
  Bun.env as Record<string, string | undefined>,
);

if (missingEnv.length > 0) {
  const details = missingEnv
    .map(
      (entry) =>
        `${entry.capabilityId}:${entry.match}(${entry.missingNames.join(", ")})`,
    )
    .join(", ");
  logger.error("Missing required runtime environment", {
    missingEnv,
  });
  throw new Error(`Missing required runtime environment: ${details}.`);
}

logger.info("Worker started", {
  dbPath: config.dbPath,
  workerId: config.workerId,
  pollIntervalMs: config.pollIntervalMs,
  leaseMs: config.leaseMs,
  maxAttempts: config.maxAttempts,
  retryBaseDelayMs: config.retryBaseDelayMs,
  heartbeatIntervalMs: config.heartbeatIntervalMs,
  manifestPath: config.manifestPath,
  targetsPath: config.targetsPath,
  installedCapabilities: manifest.installed,
  presets: listPresets().map((preset) => preset.id),
  tasks: listTasks().map((task) => task.id),
});

try {
  await startWorkerLoop({
    installedCapabilities: manifest.installed,
    manifestPath: config.manifestPath,
    runStore,
    workerId: config.workerId,
    runtimeRole: config.runtimeRole,
    leaseMs: config.leaseMs,
    retryBaseDelayMs: config.retryBaseDelayMs,
    pollIntervalMs: config.pollIntervalMs,
    heartbeatIntervalMs: config.heartbeatIntervalMs,
    shutdownSignal,
    logger,
  });
} finally {
  runStore.close();
}
