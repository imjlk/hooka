import { defineTaskPack } from "@hooka/task-sdk";
export type { CompatibilityWebhookAdapter } from "@hooka/task-sdk";
import { sharedVolumeWranglerTask } from "./tasks/deploySimplyStatic";

export {
  sharedVolumeWranglerInput,
  sharedVolumeWranglerTask,
  deploySimplyStaticInput,
  deploySimplyStaticTask,
} from "./tasks/deploySimplyStatic";
export {
  sharedVolumeWranglerInputSchema,
  wordpressSimplyStaticWebhookSchema,
} from "./schema";
export {
  normalizeWordpressSimplyStaticWebhook,
  parseWordpressSimplyStaticWebhook,
  wordpressSimplyStaticWebhookAdapter,
} from "./wordpressWebhookAdapter";
export type {
  SharedVolumeWranglerInput,
  WordpressSimplyStaticWebhook,
} from "./schema";

export const wordpressCloudflareTaskPack = defineTaskPack({
  id: "@hooka/pack-wordpress-cloudflare",
  title: "Webhook Wrangler Pack",
  description:
    "Generic wrangler-backed tasks that deploy shared-volume artifacts after a signed webhook.",
  tasks: [sharedVolumeWranglerTask],
});
