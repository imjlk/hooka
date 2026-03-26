import { listPresets, listTasks } from "@hooka/registry";
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

console.log(
  JSON.stringify(
    {
      service: "hooka-worker",
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
