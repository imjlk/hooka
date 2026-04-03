import { defineCommand, defineGroup, option } from "@bunli/core";
import type { Target } from "@hooka/contracts";
import {
  createTarget,
  deleteTarget,
  loadTargets,
  updateTarget,
} from "@hooka/targets";
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
      defineCommand({
        name: "create",
        description: "Create one target from a JSON file.",
        options: {
          targets: option(z.string().default(defaults.targetsPath), {
            description: "Path to the Hooka targets file.",
          }),
          file: option(z.string(), {
            description:
              "Path to a JSON file that contains one full target object.",
          }),
        },
        handler: async ({ flags }) => {
          const payload = (await Bun.file(flags.file).json()) as Target;
          const targets = await createTarget(flags.targets, payload);
          const created = targets.find((target) => target.id === payload.id);

          console.log(JSON.stringify(created ?? payload, null, 2));
        },
      }),
      defineCommand({
        name: "update",
        description: "Replace one target from a JSON file.",
        options: {
          targets: option(z.string().default(defaults.targetsPath), {
            description: "Path to the Hooka targets file.",
          }),
          file: option(z.string(), {
            description:
              "Path to a JSON file that contains one full target object.",
          }),
        },
        handler: async ({ flags, positional }) => {
          const targetId = positional[0];

          if (!targetId) {
            throw new Error(
              "Usage: hooka target update <target-id> --file <target.json>",
            );
          }

          const payload = (await Bun.file(flags.file).json()) as Target;
          const targets = await updateTarget(flags.targets, targetId, payload);
          const updated = targets.find((target) => target.id === targetId);

          console.log(JSON.stringify(updated ?? payload, null, 2));
        },
      }),
      defineCommand({
        name: "delete",
        description: "Delete one target from the configured targets file.",
        options: {
          targets: option(z.string().default(defaults.targetsPath), {
            description: "Path to the Hooka targets file.",
          }),
          yes: option(booleanFlagSchema, {
            description: "Confirm deletion without an interactive prompt.",
          }),
        },
        handler: async ({ flags, positional }) => {
          const targetId = positional[0];
          const yes = resolveBooleanFlag(flags.yes, "--yes");

          if (!targetId) {
            throw new Error("Usage: hooka target delete <target-id> [--yes]");
          }

          if (!yes) {
            throw new Error("Refusing to delete target without --yes.");
          }

          await deleteTarget(flags.targets, targetId);
          console.log(
            JSON.stringify(
              {
                ok: true,
                targetId,
              },
              null,
              2,
            ),
          );
        },
      }),
    ],
  });
}
