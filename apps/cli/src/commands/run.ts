import { defineCommand, defineGroup, option } from "@bunli/core";
import { z } from "zod";
import type { CliDefaults } from "../lib/shared";
import { withRunStore } from "../lib/shared";

export function createRunCommandGroup(defaults: CliDefaults) {
  return defineGroup({
    name: "run",
    description: "Inspect queued and completed runs from SQLite.",
    commands: [
      defineCommand({
        name: "list",
        description: "List recent queued or completed runs.",
        options: {
          db: option(z.string().default(defaults.dbPath), {
            description: "Path to the Hooka SQLite database.",
          }),
          limit: option(z.coerce.number().int().positive().default(20), {
            description: "Maximum number of runs to return.",
          }),
          json: option(z.coerce.boolean().default(false), {
            description: "Print raw JSON instead of a table.",
          }),
        },
        handler: async ({ flags }) => {
          const runs = await withRunStore(flags.db, (runStore) => {
            return runStore.listRuns(flags.limit);
          });

          if (flags.json) {
            console.log(JSON.stringify(runs, null, 2));
          } else {
            console.table(
              runs.map((run) => ({
                id: run.id,
                taskId: run.taskId,
                status: run.status,
                source: run.source,
                attempts: run.attemptCount,
                createdAt: run.createdAt,
              })),
            );
          }
        },
      }),
      defineCommand({
        name: "show",
        description: "Show one run with payload, result, and events.",
        options: {
          db: option(z.string().default(defaults.dbPath), {
            description: "Path to the Hooka SQLite database.",
          }),
        },
        handler: async ({ flags, positional }) => {
          const runId = positional[0];

          if (!runId) {
            throw new Error("Usage: hooka run show <run-id>");
          }

          const run = await withRunStore(flags.db, (runStore) => {
            return runStore.getRun(runId);
          });

          if (!run) {
            throw new Error(`Run not found: ${runId}`);
          }

          console.log(JSON.stringify(run, null, 2));
        },
      }),
    ],
  });
}
