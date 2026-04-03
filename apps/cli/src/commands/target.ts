import { defineCommand, defineGroup, option } from "@bunli/core";
import { loadTargets } from "@hooka/targets";
import { z } from "zod";
import type { CliDefaults } from "../lib/shared";
import { booleanFlagSchema, resolveBooleanFlag } from "../lib/shared";

export function createTargetCommandGroup(defaults: CliDefaults) {
  return defineGroup({
    name: "target",
    description: "Inspect target policies and defaults.",
    commands: [
      defineCommand({
        name: "list",
        description: "List configured targets.",
        options: {
          targets: option(z.string().default(defaults.targetsPath), {
            description: "Path to the Hooka targets file.",
          }),
          json: option(booleanFlagSchema, {
            description: "Print raw JSON instead of a table.",
          }),
        },
        handler: async ({ flags }) => {
          const targets = await loadTargets(flags.targets);
          const json = resolveBooleanFlag(flags.json, "--json");

          if (json) {
            console.log(JSON.stringify(targets, null, 2));
            return;
          }

          console.table(
            targets.map((target) => ({
              id: target.id,
              taskId: target.taskId,
              source: target.source,
              maxAttempts: target.maxAttempts,
            })),
          );
        },
      }),
      defineCommand({
        name: "show",
        description: "Show one configured target as JSON.",
        options: {
          targets: option(z.string().default(defaults.targetsPath), {
            description: "Path to the Hooka targets file.",
          }),
        },
        handler: async ({ flags, positional }) => {
          const targetId = positional[0];

          if (!targetId) {
            throw new Error("Usage: hooka target show <target-id>");
          }

          const target = (await loadTargets(flags.targets)).find(
            (candidate) => candidate.id === targetId,
          );

          if (!target) {
            throw new Error(`Target not found: ${targetId}`);
          }

          console.log(JSON.stringify(target, null, 2));
        },
      }),
    ],
  });
}
