import { defineCommand, defineGroup, option } from "@bunli/core";
import { listCapabilities } from "@hooka/registry";
import { booleanFlagSchema, resolveBooleanFlag } from "../lib/shared";

export function createCapabilityCommandGroup() {
  return defineGroup({
    name: "capability",
    description: "Inspect runtime capability contracts.",
    commands: [
      defineCommand({
        name: "list",
        description: "List capabilities and their healthchecks.",
        options: {
          json: option(booleanFlagSchema, {
            description: "Print raw JSON instead of a table.",
          }),
        },
        handler: async ({ flags }) => {
          const json = resolveBooleanFlag(flags.json, "--json");
          const capabilities = listCapabilities().map((capability) => ({
            id: capability.id,
            binaries: capability.binaries.join(", "),
            healthcheck: [
              capability.healthcheck.command,
              ...(capability.healthcheck.args ?? []),
            ].join(" "),
            feature: capability.docker?.feature ?? "",
            requiredEnv: (capability.requiredEnv ?? [])
              .map(
                (requirement) =>
                  `${requirement.match}(${requirement.names.join(", ")})`,
              )
              .join(", "),
          }));

          if (json) {
            console.log(JSON.stringify(capabilities, null, 2));
            return;
          }

          console.table(capabilities);
        },
      }),
    ],
  });
}
