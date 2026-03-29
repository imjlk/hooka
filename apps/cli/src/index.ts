import { createCLI } from "@bunli/core";
import { createCapabilityCommandGroup } from "./commands/capability";
import { createDoctorCommand } from "./commands/doctor";
import { createImageCommandGroup } from "./commands/image";
import { createRunCommandGroup } from "./commands/run";
import { createTaskCommandGroup } from "./commands/task";
import { createWebhookCommandGroup } from "./commands/webhook";
import { cliDefaults } from "./lib/shared";

const cli = await createCLI({
  name: "hooka",
  version: "0.1.0",
  description:
    "Composable task, capability, and preset control plane for Hooka.",
  commands: {
    entry: "./apps/cli/src/index.ts",
  },
});

cli.command(createTaskCommandGroup(cliDefaults));
cli.command(createCapabilityCommandGroup());
cli.command(createImageCommandGroup(cliDefaults));
cli.command(createRunCommandGroup(cliDefaults));
cli.command(createDoctorCommand(cliDefaults));
cli.command(createWebhookCommandGroup());

await cli.init();
await cli.run();
