import { defineTask } from "@hooka/task-sdk";
import { z } from "zod";

export const deploySimplyStaticInput = z.object({
  project: z.enum(["main-site", "staging-site"]),
  exportDir: z.string().default("/data/exports/simply-static"),
  branch: z.string().optional(),
  commitSha: z.string().optional(),
});

export const deploySimplyStaticTask = defineTask({
  id: "wordpress.deploy.simply-static",
  title: "Deploy Simply Static export to Cloudflare Pages",
  description:
    "Ship the exported static bundle from WordPress straight to Cloudflare Pages.",
  input: deploySimplyStaticInput,
  requires: ["wrangler", "wpcli"],
  executor: {
    kind: "process",
    command: "wrangler",
    args: ({ input }) => [
      "pages",
      "deploy",
      input.exportDir,
      "--project-name",
      input.project,
      ...(input.branch ? ["--branch", input.branch] : []),
      ...(input.commitSha ? ["--commit-dirty=true"] : []),
    ],
  },
  tags: ["wordpress", "cloudflare", "deploy"],
});
