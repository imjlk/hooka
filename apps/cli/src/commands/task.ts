import { defineCommand, defineGroup, option } from "@bunli/core";
import { enqueueRunRequestSchema } from "@hooka/contracts";
import { createRunStore } from "@hooka/run-store";
import { loadInstalledCapabilities, runTask } from "@hooka/runner-core";
import type { AnyTask } from "@hooka/task-sdk";
import { listTasks } from "@hooka/registry";
import { z } from "zod";
import type { CliDefaults } from "../lib/shared";
import {
  buildTaskInputFromFlags,
  taskToBunliOptions,
} from "../lib/task-options";

export function createTaskCommandGroup(defaults: CliDefaults) {
  const taskRunCommands = listTasks().flatMap((task) =>
    createTaskRunCommands(task, defaults),
  );
  const taskEnqueueCommands = listTasks().flatMap((task) =>
    createTaskEnqueueCommands(task, defaults),
  );

  return defineGroup({
    name: "task",
    description: "Inspect and run Hooka tasks.",
    commands: [
      defineCommand({
        name: "list",
        description: "List registered tasks and their capability contracts.",
        options: {
          json: option(z.coerce.boolean().default(false), {
            description: "Print raw JSON instead of a table.",
          }),
        },
        handler: async ({ flags }) => {
          const tasks = listTasks().map((task) => ({
            id: task.id,
            title: task.title,
            requires: task.requires.join(", "),
          }));

          if (flags.json) {
            console.log(JSON.stringify(tasks, null, 2));
            return;
          }

          console.table(tasks);
        },
      }),
      defineCommand({
        name: "validate",
        description: "Validate the in-repo registry graph.",
        handler: async () => {
          const { validateRegistry } = await import("@hooka/registry");
          const result = validateRegistry();

          if (result.ok) {
            console.log("Registry OK");
            return;
          }

          for (const error of result.errors) {
            console.error(`- ${error}`);
          }
          process.exitCode = 1;
        },
      }),
      defineGroup({
        name: "run",
        description:
          "Run a specific task. Complex nested values can fall back to --payload-json or --payload-file.",
        commands: taskRunCommands,
      }),
      defineGroup({
        name: "enqueue",
        description: "Queue a task for worker execution in SQLite.",
        commands: taskEnqueueCommands,
      }),
    ],
  });
}

function createTaskRunCommands(task: AnyTask, defaults: CliDefaults) {
  return [task.id, ...(task.aliases ?? [])].map((commandName) =>
    defineCommand({
      name: commandName,
      description:
        commandName === task.id
          ? (task.description ?? task.title)
          : `${task.description ?? task.title} (compat alias for ${task.id})`,
      options: taskToBunliOptions(task, {
        includeDryRun: true,
      }),
      handler: async ({ flags }) => {
        const manifest = await loadInstalledCapabilities(defaults.manifestPath);
        const input = await buildTaskInputFromFlags(
          task,
          flags as Record<string, unknown>,
        );
        const result = await runTask(task, input, {
          dryRun: Boolean((flags as Record<string, unknown>)["dry-run"]),
          installedCapabilities: manifest.installed,
          manifestPath: defaults.manifestPath,
        });

        console.log(JSON.stringify(result, null, 2));

        if (!result.ok) {
          process.exitCode = 1;
        }
      },
    }),
  );
}

function createTaskEnqueueCommands(task: AnyTask, defaults: CliDefaults) {
  return [task.id, ...(task.aliases ?? [])].map((commandName) =>
    defineCommand({
      name: commandName,
      description:
        commandName === task.id
          ? `Queue ${task.description ?? task.title}`
          : `Queue ${task.description ?? task.title} (compat alias for ${task.id})`,
      options: {
        ...taskToBunliOptions(task, {
          includeDryRun: false,
        }),
        db: option(z.string().default(defaults.dbPath), {
          description: "Path to the Hooka SQLite database.",
        }),
        manifest: option(z.string().default(defaults.manifestPath), {
          description: "Path to the installed-capabilities manifest.",
        }),
      },
      handler: async ({ flags }) => {
        const manifest = await loadInstalledCapabilities(flags.manifest);
        const input = await buildTaskInputFromFlags(
          task,
          flags as Record<string, unknown>,
        );
        const parsedInput = task.input.parse(input);
        const payload = enqueueRunRequestSchema.parse({
          taskId: task.id,
          input: parsedInput,
          source: "cli",
        });
        const runStore = await createRunStore({
          dbPath: flags.db,
        });
        const queued = runStore.enqueueRun({
          ...payload,
          capabilitySnapshot: manifest.installed,
        });
        runStore.close();

        console.log(JSON.stringify(queued.response, null, 2));
      },
    }),
  );
}
