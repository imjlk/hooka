import { listCapabilities, listPresets, listTasks } from "@hooka/registry";
import { findMissingCapabilityEnvRequirements } from "@hooka/runtime-contracts";
import { createRunStore, defaultHookaDbPath } from "@hooka/run-store";
import { loadInstalledCapabilities } from "@hooka/runner-core";
import { resolve } from "node:path";
import {
  defaultRunLeaseMs,
  defaultWorkerPollIntervalMs,
  getDefaultWorkerId,
  startWorkerLoop,
} from "./lib/worker";

const dbPath = Bun.env.HOOKA_DB_PATH ?? defaultHookaDbPath;
const runtimeRole = Bun.env.HOOKA_RUNTIME_ROLE ?? "hooka-worker";
const manifestPath = resolve(
  process.cwd(),
  "docker/manifests/installed-capabilities.json",
);
const workerId = getDefaultWorkerId();
const pollIntervalMs = Number(
  Bun.env.HOOKA_POLL_INTERVAL_MS ?? defaultWorkerPollIntervalMs,
);
const leaseMs = Number(Bun.env.HOOKA_RUN_LEASE_MS ?? defaultRunLeaseMs);
const runStore = await createRunStore({
  dbPath,
});
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
      installedCapabilities: manifest.installed,
      presets: listPresets().map((preset) => preset.id),
      tasks: listTasks().map((task) => task.id),
    },
    null,
    2,
  ),
);

await startWorkerLoop({
  installedCapabilities: manifest.installed,
  manifestPath,
  runStore,
  workerId,
  leaseMs,
  pollIntervalMs,
});
