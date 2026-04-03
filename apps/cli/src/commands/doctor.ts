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
import { booleanFlagSchema, resolveBooleanFlag } from "../lib/shared";

export function createDoctorCommand(defaults: CliDefaults) {
  return defineCommand({
    name: "doctor",
    description: "Check installed capabilities against the registered tasks.",
    options: {
      manifest: option(z.string().default(defaults.manifestPath), {
        description: "Path to the installed-capabilities manifest.",
      }),
      json: option(booleanFlagSchema, {
        description: "Print raw JSON instead of a human-readable report.",
      }),
    },
    handler: async ({ flags }) => {
      const json = resolveBooleanFlag(flags.json, "--json");
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

      const report = {
        installed: manifest.installed,
        requiredEnv: getCapabilityEnvRequirements(manifest.installed),
        missingEnv,
        missingByTask,
        suggestedPreset: recommendPresetForTasks(
          listTasks().map((task) => task.id),
        )?.id,
      };

      if (json) {
        console.log(JSON.stringify(report, null, 2));
        return;
      }

      console.log(
        `Installed capabilities: ${report.installed.join(", ") || "(none)"}`,
      );
      console.log(`Suggested preset: ${report.suggestedPreset ?? "(none)"}`);
      if (report.missingEnv.length === 0) {
        console.log("Capability env: ok");
      } else {
        console.log("Capability env:");
        for (const entry of report.missingEnv) {
          console.log(
            `- ${entry.capabilityId}: missing ${entry.missingNames.join(", ")}`,
          );
        }
      }
      if (report.missingByTask.length === 0) {
        console.log("Task coverage: ok");
      } else {
        console.log("Task coverage:");
        for (const entry of report.missingByTask) {
          console.log(`- ${entry.id}: missing ${entry.missing.join(", ")}`);
        }
      }
    },
  });
}
