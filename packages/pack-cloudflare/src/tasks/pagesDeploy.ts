import { defineTask } from "@hooka/task-sdk";
import { z } from "zod";

export const pagesDeployInput = z.object({
  project: z.string().min(1),
  directory: z.string().default("./dist"),
  branch: z.string().optional(),
});

export const pagesDeployTask = defineTask({
  id: "cloudflare.pages.deploy",
  title: "Deploy static assets to Cloudflare Pages",
  description: "Push a local build directory to a Cloudflare Pages project.",
  input: pagesDeployInput,
  requires: ["wrangler"],
  executor: {
    kind: "process",
    command: "wrangler",
    args: ({ input }) => [
      "pages",
      "deploy",
      input.directory,
      "--project-name",
      input.project,
      ...(input.branch ? ["--branch", input.branch] : []),
    ],
  },
  tags: ["cloudflare", "deploy"],
});
