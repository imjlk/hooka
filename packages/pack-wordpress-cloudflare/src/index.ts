import { defineTaskPack } from "@hooka/task-sdk";
import { sharedVolumeWranglerTask } from "./tasks/deploySimplyStatic";

export {
  sharedVolumeWranglerInput,
  sharedVolumeWranglerTask,
  deploySimplyStaticInput,
  deploySimplyStaticTask,
} from "./tasks/deploySimplyStatic";

export const wordpressCloudflareTaskPack = defineTaskPack({
  id: "@hooka/pack-webhook-wrangler",
  title: "Webhook Wrangler Pack",
  description:
    "Generic wrangler-backed tasks that deploy shared-volume artifacts after a signed webhook.",
  tasks: [sharedVolumeWranglerTask],
});
