import { defineCommand, defineGroup, option } from "@bunli/core";
import {
  getCapability,
  getPresetPlan,
  listPresets,
  recommendPresetForTasks,
} from "@hooka/registry";
import { resolve } from "node:path";
import { z } from "zod";
import type { CliDefaults } from "../lib/shared";
import {
  ensureParentDirectory,
  parseFeatureList,
} from "../lib/shared";

export function createImageCommandGroup(defaults: CliDefaults) {
  return defineGroup({
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
              tier: preset.tier ?? "",
              imageTag: preset.imageTag,
              publicWorkerTag: preset.publicWorkerTag ?? preset.imageTag,
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
          manifest: option(z.string().default(defaults.manifestPath), {
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

            if (!capability) {
              throw new Error(`Unknown capability: ${feature}`);
            }

            if (!flags["dry-run"] && capability.docker) {
              const installScript = resolve(
                process.cwd(),
                capability.docker.installScript,
              );
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
  });
}
