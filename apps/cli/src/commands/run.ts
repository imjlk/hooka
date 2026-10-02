import { defineCommand, defineGroup, option } from "@bunli/core";
import { taskRunStatusSchema } from "@hooka/contracts";
import { z } from "zod";
import { createRunClient } from "../lib/run-client";
import type { CliDefaults } from "../lib/shared";
import { booleanFlag } from "../lib/shared";

export function createRunCommandGroup(defaults: CliDefaults) {
  return defineGroup({
    name: "run",
    description: "Inspect and retry runs from SQLite or a remote Hooka server.",
    commands: [
      defineCommand({
        name: "retry",
        description:
          "Retry a completed run by enqueueing the same task payload again.",
        options: {
          ...createConnectionOptions(defaults),
        },
        handler: async ({ flags, positional }) => {
          const runId = positional[0];

          if (!runId) {
            throw new Error("Usage: hooka run retry <run-id>");
          }

          const queued = await clientFromFlags(flags).retryRun(runId);

          console.log(JSON.stringify(queued, null, 2));
        },
      }),
      defineCommand({
        name: "watch",
        description: "Poll one run until it reaches a terminal state.",
        options: {
          ...createConnectionOptions(defaults),
          interval: option(z.coerce.number().int().positive().default(1000), {
            description: "Polling interval in milliseconds.",
          }),
        },
        handler: async ({ flags, positional }) => {
          const runId = positional[0];

          if (!runId) {
            throw new Error("Usage: hooka run watch <run-id>");
          }

          const client = clientFromFlags(flags);
          let lastStatus: string | null = null;

          while (true) {
            const run = await client.getRun(runId);

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
          ...createConnectionOptions(defaults),
          limit: option(z.coerce.number().int().positive().default(20), {
            description: "Maximum number of runs to return.",
          }),
          status: option(taskRunStatusSchema.optional(), {
            description: "Filter runs by queue or terminal status.",
          }),
          "task-id": option(z.string().min(1).optional(), {
            description: "Filter runs by task id.",
          }),
          source: option(z.string().min(1).optional(), {
            description: "Filter runs by source.",
          }),
          json: booleanFlag({
            description: "Print raw JSON instead of a table.",
          }),
        },
        handler: async ({ flags }) => {
          const json = flags.json;
          const runs = await clientFromFlags(flags).listRuns({
            limit: flags.limit,
            status: flags.status,
            taskId: flags["task-id"],
            source: flags.source,
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
          ...createConnectionOptions(defaults),
        },
        handler: async ({ flags, positional }) => {
          const runId = positional[0];

          if (!runId) {
            throw new Error("Usage: hooka run show <run-id>");
          }

          const run = await clientFromFlags(flags).getRun(runId);

          if (!run) {
            throw new Error(`Run not found: ${runId}`);
          }

          console.log(JSON.stringify(run, null, 2));
        },
      }),
    ],
  });
}

function createConnectionOptions(defaults: CliDefaults) {
  return {
    db: option(z.string().default(defaults.dbPath), {
      description: "Path to the local SQLite database when --url is omitted.",
    }),
    url: option(
      z
        .string()
        .url()
        .refine((value) => /^https?:\/\//i.test(value), {
          message: "Hooka server URL must use HTTP or HTTPS.",
        })
        .optional(),
      {
        description: "Hooka server base URL. Selects remote API mode.",
      },
    ),
    token: option(z.string().min(1).optional(), {
      description:
        "Admin bearer token for --url. Falls back to HOOKA_ADMIN_TOKEN.",
    }),
    "request-timeout": option(
      z.coerce.number().int().positive().default(10_000),
      { description: "Timeout for each remote API request in milliseconds." },
    ),
    "allow-insecure-http": booleanFlag({
      description:
        "Allow sending the admin token over non-loopback HTTP on a trusted network.",
    }),
  };
}

function clientFromFlags(flags: {
  db: string;
  url?: string;
  token?: string;
  "request-timeout": number;
  "allow-insecure-http": boolean;
}) {
  if (flags.token && !flags.url) {
    throw new Error("--token requires --url to select a remote Hooka server.");
  }

  return createRunClient({
    dbPath: flags.db,
    url: flags.url,
    token: flags.token ?? Bun.env["HOOKA_ADMIN_TOKEN"],
    requestTimeoutMs: flags["request-timeout"],
    allowInsecureHttp: flags["allow-insecure-http"],
  });
}
