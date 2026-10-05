import { defineCapability } from "@hooka/task-sdk";

export const recommendationsCapability = defineCapability({
  id: "recommendations",
  title: "Offline Recommendations",
  description:
    "Private local recommendation jobs; operator paths and explicit enablement are checked per task.",
  binaries: ["bun"],
  // Optional in the Sharelink image. Do not make model paths mandatory at startup.
  healthcheck: { command: "bun", args: ["--version"] },
  tasks: [
    "recommendations.validate",
    "recommendations.ingest",
    "recommendations.build",
    "recommendations.plan",
    "recommendations.export",
    "recommendations.status",
    "recommendations.prune",
  ],
});
