import { defineTaskPack } from "@hooka/task-sdk";
import { pagesDeployTask } from "./tasks/pagesDeploy";

export { pagesDeployInput, pagesDeployTask } from "./tasks/pagesDeploy";

export const cloudflareTaskPack = defineTaskPack({
  id: "@hooka/pack-cloudflare",
  title: "Cloudflare Pack",
  description: "Cloudflare deployment tasks backed by wrangler.",
  tasks: [pagesDeployTask],
});
