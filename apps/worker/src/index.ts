import { getEnvOrDefault, getNumberEnv } from "@hooka/bun-utils";
import { listCapabilities, listPresets, listTasks } from "@hooka/registry";
import { findMissingCapabilityEnvRequirements } from "@hooka/runtime-contracts";
import { createRunStore, defaultHookaDbPath } from "@hooka/run-store";
import {
  getDefaultManifestPath,
  loadInstalledCapabilities,
} from "@hooka/runner-core";
import {
  defaultRunLeaseMs,
  defaultWorkerPollIntervalMs,
  getDefaultWorkerId,
  startWorkerLoop,
} from "./lib/worker";
import { registerWorkerShutdownHandlers } from "./lib/shutdown";

const dbPath = getEnvOrDefault("HOOKA_DB_PATH", defaultHookaDbPath);
const runtimeRole = getEnvOrDefault("HOOKA_RUNTIME_ROLE", "hooka-worker");
const manifestPath = getDefaultManifestPath();
const workerId = getDefaultWorkerId();
const pollIntervalMs = getNumberEnv(
  "HOOKA_POLL_INTERVAL_MS",
  defaultWorkerPollIntervalMs,
);
const leaseMs = getNumberEnv("HOOKA_RUN_LEASE_MS", defaultRunLeaseMs);
const runStore = await createRunStore({
  dbPath,
});
const shutdownSignal = registerWorkerShutdownHandlers();
const manifest = await loadInstalledCapabilities(manifestPath);

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
  throw new Error(`Missing required runtime environment: ${details}.`);
}

console.log(
  JSON.stringify(
    {
      service: "hooka-worker",
      runtimeRole,
      dbPath,
      workerId,
      pollIntervalMs,
      leaseMs,
      manifestPath,
      installedCapabilities: manifest.installed,
      presets: listPresets().map((preset) => preset.id),
      tasks: listTasks().map((task) => task.id),
    },
    null,
    2,
  ),
);

try {
  await startWorkerLoop({
    installedCapabilities: manifest.installed,
    manifestPath,
    runStore,
    workerId,
    leaseMs,
    pollIntervalMs,
    shutdownSignal,
  });
} finally {
  runStore.close();
}
