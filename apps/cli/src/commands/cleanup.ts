import { defineCommand, option } from "@bunli/core";
import { z } from "zod";
import type { CliDefaults } from "../lib/shared";
import {
  booleanFlagSchema,
  resolveBooleanFlag,
  withRunStore,
} from "../lib/shared";

const dayMs = 24 * 60 * 60 * 1000;

export function createCleanupCommand(defaults: CliDefaults) {
  return defineCommand({
    name: "cleanup",
    description: "Prune old run and audit data from the Hooka SQLite store.",
    options: {
      db: option(z.string().default(defaults.dbPath), {
        description: "Path to the Hooka SQLite database.",
      }),
      runDays: option(
        z.coerce.number().int().positive().default(defaults.retentionRunDays),
        {
          description: "Delete terminal runs older than this many days.",
        },
      ),
      auditDays: option(
        z.coerce.number().int().positive().default(defaults.retentionAuditDays),
        {
          description: "Delete audit events older than this many days.",
        },
      ),
      vacuum: option(booleanFlagSchema, {
        description: "Run SQLite VACUUM after deleting old rows.",
      }),
      json: option(booleanFlagSchema, {
        description: "Print raw JSON instead of a summary line.",
      }),
    },
    handler: async ({ flags }) => {
      const now = Date.now();
      const result = await withRunStore(flags.db, (runStore) => {
        return runStore.cleanupRetention({
          runFinishedBefore: new Date(
            now - flags.runDays * dayMs,
          ).toISOString(),
          auditCreatedBefore: new Date(
            now - flags.auditDays * dayMs,
          ).toISOString(),
          vacuum: resolveBooleanFlag(flags.vacuum, "--vacuum"),
        });
      });

      if (resolveBooleanFlag(flags.json, "--json")) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      console.log(
        `Deleted runs=${result.deletedRuns} runEvents=${result.deletedRunEvents} auditEvents=${result.deletedAuditEvents}`,
      );
    },
  });
}
