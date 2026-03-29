import { defineCommand, option } from "@bunli/core";
import {
  findMissingCapabilityEnv,
  getCapabilityEnvRequirements,
  listTasks,
  recommendPresetForTasks,
} from "@hooka/registry";
import { loadInstalledCapabilities } from "@hooka/runner-core";
import { z } from "zod";
import type { CliDefaults } from "../lib/shared";

export function createDoctorCommand(defaults: CliDefaults) {
  return defineCommand({
    name: "doctor",
    description: "Check installed capabilities against the registered tasks.",
    options: {
      manifest: option(z.string().default(defaults.manifestPath), {
        description: "Path to the installed-capabilities manifest.",
      }),
    },
    handler: async ({ flags }) => {
      const manifest = await loadInstalledCapabilities(flags.manifest);
      const missingEnv = findMissingCapabilityEnv(
        manifest.installed,
        Bun.env as Record<string, string | undefined>,
      );
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
            requiredEnv: getCapabilityEnvRequirements(manifest.installed),
            missingEnv,
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
  });
}
