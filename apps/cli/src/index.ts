import {
  createCLI,
  defineCommand,
  defineGroup,
  option,
} from "@bunli/core";
import { enqueueRunRequestSchema } from "@hooka/contracts";
import {
  createRunStore,
  defaultHookaDbPath,
} from "@hooka/run-store";
import {
  getCapability,
  getPresetPlan,
  listCapabilities,
  listPresets,
  listTasks,
  recommendPresetForTasks,
  validateRegistry,
} from "@hooka/registry";
import { loadInstalledCapabilities, runTask } from "@hooka/runner-core";
import type { AnyTask } from "@hooka/task-sdk";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import {
  buildTaskInputFromFlags,
  taskToBunliOptions,
} from "./lib/task-options";

const manifestPathDefault = resolve(
  process.cwd(),
  "docker/manifests/installed-capabilities.json",
);
const dbPathDefault = Bun.env.HOOKA_DB_PATH ?? defaultHookaDbPath;

const taskRunCommands = listTasks().map((task) => createTaskRunCommand(task));
const taskEnqueueCommands = listTasks().map((task) => createTaskEnqueueCommand(task));

const cli = await createCLI({
  name: "hooka",
  version: "0.1.0",
  description:
    "Composable task, capability, and preset control plane for Hooka.",
  commands: {
    entry: "./apps/cli/src/index.ts",
  },
});

cli.command(
  defineGroup({
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
  }),
);

cli.command(
  defineGroup({
    name: "capability",
    description: "Inspect runtime capability contracts.",
    commands: [
      defineCommand({
        name: "list",
        description: "List capabilities and their healthchecks.",
        options: {
          json: option(z.coerce.boolean().default(false), {
            description: "Print raw JSON instead of a table.",
          }),
        },
        handler: async ({ flags }) => {
          const capabilities = listCapabilities().map((capability) => ({
            id: capability.id,
            binaries: capability.binaries.join(", "),
            healthcheck: [
              capability.healthcheck.command,
              ...(capability.healthcheck.args ?? []),
            ].join(" "),
            feature: capability.docker?.feature ?? "",
          }));

          if (flags.json) {
            console.log(JSON.stringify(capabilities, null, 2));
            return;
          }

          console.table(capabilities);
        },
      }),
    ],
  }),
);

cli.command(
  defineGroup({
    name: "image",
    description: "Plan and assemble preset-oriented images.",
    commands: [
      defineCommand({
        name: "list-presets",
        description: "List public image presets.",
        handler: async () => {
          console.table(
            listPresets().map((preset) => ({
              id: preset.id,
              imageTag: preset.imageTag,
              capabilities: preset.capabilities.join(", "),
              taskPacks: preset.taskPacks.join(", "),
            })),
          );
        },
      }),
      defineCommand({
        name: "plan",
        description: "Show the capability plan for a preset or task list.",
        options: {
          preset: option(z.string().optional(), {
            description: "Preset id to inspect.",
          }),
          tasks: option(z.string().optional(), {
            description: "Comma-separated task ids to recommend a preset for.",
          }),
        },
        handler: async ({ flags }) => {
          const taskIds =
            typeof flags.tasks === "string" && flags.tasks.length > 0
              ? flags.tasks.split(",").map((taskId) => taskId.trim())
              : [];

          if (flags.preset) {
            const plan = getPresetPlan(flags.preset);

            if (!plan) {
              throw new Error(`Unknown preset: ${flags.preset}`);
            }

            console.log(JSON.stringify(plan, null, 2));
            return;
          }

          if (taskIds.length > 0) {
            const recommendation = recommendPresetForTasks(taskIds);

            if (!recommendation) {
              throw new Error(
                `No preset covers all requested tasks: ${taskIds.join(", ")}`,
              );
            }

            console.log(
              JSON.stringify(
                {
                  preset: recommendation.id,
                  plan: getPresetPlan(recommendation.id),
                },
                null,
                2,
              ),
            );
            return;
          }

          throw new Error("Provide either --preset or --tasks.");
        },
      }),
      defineCommand({
        name: "install-features",
        description:
          "Install capability features and refresh the installed-capabilities manifest.",
        options: {
          features: option(z.string().default("core"), {
            description: "Comma-separated capability ids to install.",
          }),
          manifest: option(z.string().default(manifestPathDefault), {
            description: "Path to the installed-capabilities manifest.",
          }),
          image: option(z.string().default("hooka:custom"), {
            description: "Image label to write into the manifest.",
          }),
          "dry-run": option(z.coerce.boolean().default(false), {
            description: "Print the installation plan without running scripts.",
          }),
        },
        handler: async ({ flags, shell }) => {
          const requested = parseFeatureList(flags.features);
          const installed = new Set<string>();

          for (const feature of requested) {
            if (feature === "core") {
              continue;
            }

            const capability = getCapability(feature);

            if (!capability || !capability.docker) {
              throw new Error(`Unknown installable capability: ${feature}`);
            }

            if (!flags["dry-run"]) {
              const installScript = resolve(process.cwd(), capability.docker.installScript);
              await shell`sh ${installScript}`;
            }

            installed.add(capability.id);
          }

          const manifest = {
            image: flags.image,
            generatedAt: new Date().toISOString(),
            installed: [...installed],
          };

          if (!flags["dry-run"]) {
            await ensureParentDirectory(flags.manifest);
            await Bun.write(flags.manifest, `${JSON.stringify(manifest, null, 2)}\n`);
          }

          console.log(JSON.stringify(manifest, null, 2));
        },
      }),
    ],
  }),
);

cli.command(
  defineGroup({
    name: "run",
    description: "Inspect queued and completed runs from SQLite.",
    commands: [
      defineCommand({
        name: "list",
        description: "List recent queued or completed runs.",
        options: {
          db: option(z.string().default(dbPathDefault), {
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
          const runStore = await createRunStore({
            dbPath: flags.db,
          });
          const runs = runStore.listRuns(flags.limit);

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

          runStore.close();
        },
      }),
      defineCommand({
        name: "show",
        description: "Show one run with payload, result, and events.",
        options: {
          db: option(z.string().default(dbPathDefault), {
            description: "Path to the Hooka SQLite database.",
          }),
        },
        handler: async ({ flags, positional }) => {
          const runId = positional[0];

          if (!runId) {
            throw new Error("Usage: hooka run show <run-id>");
          }

          const runStore = await createRunStore({
            dbPath: flags.db,
          });
          const run = runStore.getRun(runId);
          runStore.close();

          if (!run) {
            throw new Error(`Run not found: ${runId}`);
          }

          console.log(JSON.stringify(run, null, 2));
        },
      }),
    ],
  }),
);

cli.command(
  defineCommand({
    name: "doctor",
    description: "Check installed capabilities against the registered tasks.",
    options: {
      manifest: option(z.string().default(manifestPathDefault), {
        description: "Path to the installed-capabilities manifest.",
      }),
    },
    handler: async ({ flags }) => {
      const manifest = await loadInstalledCapabilities(flags.manifest);
      const missingByTask = listTasks()
        .map((task) => ({
          id: task.id,
          missing: task.requires.filter((requirement) => {
            return !manifest.installed.includes(requirement);
          }),
        }))
        .filter((entry) => entry.missing.length > 0);

      console.log(
        JSON.stringify(
          {
            installed: manifest.installed,
            missingByTask,
            suggestedPreset: recommendPresetForTasks(
              listTasks().map((task) => task.id),
            )?.id,
          },
          null,
          2,
        ),
      );
    },
  }),
);

await cli.init();
await cli.run();

function createTaskRunCommand(task: AnyTask) {
  return defineCommand({
    name: task.id,
    description: task.description ?? task.title,
    options: taskToBunliOptions(task, {
      includeDryRun: true,
    }),
    handler: async ({ flags }) => {
      const manifest = await loadInstalledCapabilities(manifestPathDefault);
      const input = await buildTaskInputFromFlags(
        task,
        flags as Record<string, unknown>,
      );
      const result = await runTask(task, input, {
        dryRun: Boolean((flags as Record<string, unknown>)["dry-run"]),
        installedCapabilities: manifest.installed,
        manifestPath: manifestPathDefault,
      });

      console.log(JSON.stringify(result, null, 2));

      if (!result.ok) {
        process.exitCode = 1;
      }
    },
  });
}

function createTaskEnqueueCommand(task: AnyTask) {
  return defineCommand({
    name: task.id,
    description: `Queue ${task.description ?? task.title}`,
    options: {
      ...taskToBunliOptions(task, {
        includeDryRun: false,
      }),
      db: option(z.string().default(dbPathDefault), {
        description: "Path to the Hooka SQLite database.",
      }),
      manifest: option(z.string().default(manifestPathDefault), {
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
  });
}

function parseFeatureList(value: string): string[] {
  return value
    .split(",")
    .map((feature) => feature.trim())
    .filter(Boolean);
}

async function ensureParentDirectory(path: string): Promise<void> {
  const parent = dirname(path);

  await Bun.$`mkdir -p ${parent}`.quiet();
}
