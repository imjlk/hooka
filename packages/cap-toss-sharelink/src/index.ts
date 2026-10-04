import { defineCapability } from "@hooka/task-sdk";

export const tossSharelinkCapability = defineCapability({
  id: "toss-sharelink",
  title: "Toss Shopping Sharelink",
  description:
    "Server-only product matching and issued affiliate links with shared account budgets.",
  binaries: ["bun"],
  requiredEnv: [
    {
      match: "allOf",
      names: [
        "HOOKA_SHARELINK_CONFIG_PATH",
        "HOOKA_SHARELINK_DB_PATH",
        "HOOKA_SHARELINK_RESULTS_PATH",
      ],
      description:
        "Operator-owned configuration, private SQLite store, and consumer snapshot directory.",
    },
  ],
  healthcheck: { command: "bun", args: ["--version"] },
  tasks: [
    "toss-sharelink.refresh",
    "toss-sharelink.export",
    "toss-sharelink.subtag.ensure",
    "toss-sharelink.performance.sync",
    "toss-sharelink.settlement.sync",
  ],
});
