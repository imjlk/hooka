import { defineCommand, defineGroup, option } from "@bunli/core";
import { z } from "zod";
import type { CliDefaults } from "../lib/shared";
import {
  booleanFlagSchema,
  resolveBooleanFlag,
  withRunStore,
} from "../lib/shared";

export function createRunCommandGroup(defaults: CliDefaults) {
  return defineGroup({
    name: "run",
    description: "Inspect queued and completed runs from SQLite.",
    commands: [
      defineCommand({
        name: "retry",
        description:
          "Retry a completed run by enqueueing the same task payload again.",
        options: {
          db: option(z.string().default(defaults.dbPath), {
            description: "Path to the Hooka SQLite database.",
          }),
        },
        handler: async ({ flags, positional }) => {
          const runId = positional[0];

          if (!runId) {
            throw new Error("Usage: hooka run retry <run-id>");
          }

          const queued = await withRunStore(flags.db, (runStore) => {
            const run = runStore.getRun(runId);

            if (!run) {
              throw new Error(`Run not found: ${runId}`);
            }

            if (
              run.status !== "failed" &&
              run.status !== "succeeded" &&
              run.status !== "dead-lettered" &&
              run.status !== "skipped"
            ) {
              throw new Error(
                `Only terminal runs can be retried. Current status: ${run.status}`,
              );
            }

            return runStore.enqueueRun({
              taskId: run.taskId,
              input: run.payload,
              source: "cli.retry",
              capabilitySnapshot: run.capabilitySnapshot,
            });
          });

          console.log(JSON.stringify(queued.response, null, 2));
        },
      }),
      defineCommand({
        name: "watch",
        description: "Poll one run until it reaches a terminal state.",
        options: {
          db: option(z.string().default(defaults.dbPath), {
            description: "Path to the Hooka SQLite database.",
          }),
          interval: option(z.coerce.number().int().positive().default(1000), {
            description: "Polling interval in milliseconds.",
          }),
        },
        handler: async ({ flags, positional }) => {
          const runId = positional[0];

          if (!runId) {
            throw new Error("Usage: hooka run watch <run-id>");
          }

          let lastStatus: string | null = null;

          while (true) {
            const run = await withRunStore(flags.db, (runStore) => {
              return runStore.getRun(runId);
            });

            if (!run) {
              throw new Error(`Run not found: ${runId}`);
            }

            if (run.status !== lastStatus) {
              lastStatus = run.status;
              console.log(
                `${run.status} ${run.taskId} attempts=${run.attemptCount}/${run.maxAttempts} summary=${run.summary ?? "(none)"}`,
              );
            }

            if (
              run.status === "succeeded" ||
              run.status === "failed" ||
              run.status === "dead-lettered" ||
              run.status === "skipped"
            ) {
              console.log(JSON.stringify(run, null, 2));
              if (run.status !== "succeeded" && run.status !== "skipped") {
                process.exitCode = 1;
              }
              return;
            }

            await Bun.sleep(flags.interval);
          }
        },
      }),
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
          json: option(booleanFlagSchema, {
            description: "Print raw JSON instead of a table.",
          }),
        },
        handler: async ({ flags }) => {
          const json = resolveBooleanFlag(flags.json, "--json");
          const runs = await withRunStore(flags.db, (runStore) => {
            return runStore.listRuns(flags.limit);
          });

          if (json) {
            console.log(JSON.stringify(runs, null, 2));
          } else {
            console.table(
              runs.map((run) => ({
                id: run.id,
                taskId: run.taskId,
                status: run.status,
                source: run.source,
                attempts: `${run.attemptCount}/${run.maxAttempts}`,
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
