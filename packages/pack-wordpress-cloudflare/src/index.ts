import { defineTaskPack } from "@hooka/task-sdk";
export type { CompatibilityWebhookAdapter } from "@hooka/task-sdk";
import {
  sharedVolumeWranglerTask,
  trailbaseUploadsPagesTask,
} from "./tasks/deploySimplyStatic";

export {
  sharedVolumeWranglerInput,
  sharedVolumeWranglerTask,
  deploySimplyStaticInput,
  deploySimplyStaticTask,
  trailbaseUploadsPagesInput,
  trailbaseUploadsPagesTask,
} from "./tasks/deploySimplyStatic";
export {
  sharedVolumeWranglerInputSchema,
  trailbaseAssetsDrainedWebhookSchema,
  wordpressSimplyStaticWebhookSchema,
} from "./schema";
export {
  normalizeTrailBaseAssetsDrainedWebhook,
  parseTrailBaseAssetsDrainedWebhook,
  trailbaseAssetsDrainedWebhookAdapter,
} from "./trailbaseAssetsWebhookAdapter";
export {
  normalizeWordpressSimplyStaticWebhook,
  parseWordpressSimplyStaticWebhook,
  wordpressSimplyStaticWebhookAdapter,
} from "./wordpressWebhookAdapter";
export type {
  SharedVolumeWranglerInput,
  TrailBaseAssetsDrainedWebhook,
  WordpressSimplyStaticWebhook,
} from "./schema";

export const wordpressCloudflareTaskPack = defineTaskPack({
  id: "@hooka/pack-wordpress-cloudflare",
  title: "Webhook Wrangler Pack",
  description:
    "Generic wrangler-backed tasks that deploy shared-volume artifacts after a signed webhook.",
  tasks: [sharedVolumeWranglerTask, trailbaseUploadsPagesTask],
});
