import { defaultRetentionSweepIntervalHours } from "@hooka/config";
import { z } from "zod";
import { defineCommand, option } from "../lib/command";
import type { CliDefaults } from "../lib/shared";
import { booleanFlag, withRunStore } from "../lib/shared";

const dayMs = 24 * 60 * 60 * 1000;
const hourMs = 60 * 60 * 1000;

export function createCleanupCommand(defaults: CliDefaults) {
  return defineCommand({
    name: "cleanup",
    description:
      "Prune old run, audit, and stale worker heartbeat data from the Hooka SQLite store.",
    options: {
      db: option(z.string().default(defaults.dbPath), {
        description: "Path to the Hooka SQLite database.",
      }),
      "run-days": option(
        z.coerce.number().int().positive().default(defaults.retentionRunDays),
        {
          description: "Delete terminal runs older than this many days.",
        },
      ),
      "audit-days": option(
        z.coerce.number().int().positive().default(defaults.retentionAuditDays),
        {
          description: "Delete audit events older than this many days.",
        },
      ),
      "worker-heartbeat-hours": option(
        z.coerce
          .number()
          .int()
          .positive()
          .default(defaultRetentionSweepIntervalHours),
        {
          description: "Delete worker heartbeats older than this many hours.",
        },
      ),
      vacuum: booleanFlag({
        description: "Run SQLite VACUUM after deleting old rows.",
      }),
      json: booleanFlag({
        description: "Print raw JSON instead of a summary line.",
      }),
    },
    handler: async ({ flags }) => {
      const now = Date.now();
      const result = await withRunStore(flags.db, (runStore) => {
        return runStore.cleanupRetention({
          runFinishedBefore: new Date(
            now - flags["run-days"] * dayMs,
          ).toISOString(),
          auditCreatedBefore: new Date(
            now - flags["audit-days"] * dayMs,
          ).toISOString(),
          workerHeartbeatSeenBefore: new Date(
            now - flags["worker-heartbeat-hours"] * hourMs,
          ).toISOString(),
          vacuum: flags.vacuum,
        });
      });

      if (flags.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      console.log(
        `Deleted runs=${result.deletedRuns} runEvents=${result.deletedRunEvents} auditEvents=${result.deletedAuditEvents} workerHeartbeats=${result.deletedWorkerHeartbeats}`,
      );
    },
  });
}
