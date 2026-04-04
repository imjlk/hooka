import { createCLI } from "@bunli/core";
import { createAuditCommandGroup } from "./commands/audit";
import { createCapabilityCommandGroup } from "./commands/capability";
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
import { cliDefaults } from "./lib/shared";

const cli = await createCLI({
  name: "hooka",
  version: "1.0.0",
  description:
    "Composable task, capability, and preset control plane for Hooka.",
  commands: {
    entry: "./apps/cli/src/index.ts",
  },
});

cli.command(createTaskCommandGroup(cliDefaults));
cli.command(createCapabilityCommandGroup());
cli.command(createAuditCommandGroup());
cli.command(createImageCommandGroup(cliDefaults));
cli.command(createRunCommandGroup(cliDefaults));
cli.command(createStatusCommand());
cli.command(createConfigCommand());
cli.command(createTargetCommandGroup(cliDefaults));
cli.command(createInitCommand());
cli.command(createDevCommand());
cli.command(createDoctorCommand(cliDefaults));
cli.command(createWebhookCommandGroup());

await cli.init();
await cli.run();
