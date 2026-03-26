import { defineTaskPack } from "@hooka/task-sdk";
import { deploySimplyStaticTask } from "./tasks/deploySimplyStatic";

export {
  deploySimplyStaticInput,
  deploySimplyStaticTask,
} from "./tasks/deploySimplyStatic";

export const wordpressCloudflareTaskPack = defineTaskPack({
  id: "@hooka/pack-wordpress-cloudflare",
  title: "WordPress + Cloudflare Pack",
  description: "Bridge tasks that move WordPress artifacts into Cloudflare.",
  tasks: [deploySimplyStaticTask],
});
