import { cli } from "gunshi";
import { createSharelinkCommandGroup } from "./commands/sharelink";
import packageJson from "../../../package.json" with { type: "json" };
import { createAuditCommandGroup } from "./commands/audit";
import { createCapabilityCommandGroup } from "./commands/capability";
import { createCleanupCommand } from "./commands/cleanup";
import { createConfigCommand } from "./commands/config";
import { createDevCommand } from "./commands/dev";
import { createDoctorCommand } from "./commands/doctor";
import { createImageCommandGroup } from "./commands/image";
import { createInitCommand } from "./commands/init";
import { createRunCommandGroup } from "./commands/run";
import { createStatusCommand } from "./commands/status";
import { createTargetCommandGroup } from "./commands/target";
import { createTaskCommandGroup } from "./commands/task";
import { createWebhookCommandGroup } from "./commands/webhook";
import { defineGroup } from "./lib/command";
import { cliDefaults } from "./lib/shared";

const commands = [
  createSharelinkCommandGroup(cliDefaults),
  createTaskCommandGroup(cliDefaults),
  createCapabilityCommandGroup(),
  createCleanupCommand(cliDefaults),
  createAuditCommandGroup(),
  createImageCommandGroup(cliDefaults),
  createRunCommandGroup(cliDefaults),
  createStatusCommand(),
  createConfigCommand(),
  createTargetCommandGroup(cliDefaults),
  createInitCommand(),
  createDevCommand(),
  createDoctorCommand(cliDefaults),
  createWebhookCommandGroup(),
];

const root = defineGroup({
  name: "hooka",
  description:
    "Composable task, capability, and preset control plane for Hooka.",
  commands,
});

try {
  await cli(process.argv.slice(2), root, {
    name: "hooka",
    version: packageJson.version,
    description:
      "Composable task, capability, and preset control plane for Hooka.",
    subCommands: root.subCommands,
    strict: true,
    renderHeader: null,
    renderValidationErrors: null,
  });
} catch (error) {
  const errors: unknown[] =
    error instanceof AggregateError ? error.errors : [error];
  console.error(
    errors
      .map((issue) => (issue instanceof Error ? issue.message : String(issue)))
      .join("\n"),
  );
  process.exitCode = 1;
}
