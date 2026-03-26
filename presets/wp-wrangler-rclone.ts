import { definePreset } from "@hooka/task-sdk";

export const wpWranglerRclonePreset = definePreset({
  id: "wp-wrangler-rclone",
  title: "WordPress Wrangler + rclone",
  description:
    "Extended preset for WordPress and Cloudflare flows that also need object storage sync.",
  imageTag: "wp-wrangler-rclone",
  capabilities: ["wrangler", "wpcli", "php-cli", "rsync", "git", "rclone"],
  taskPacks: [
    "@hooka/pack-wordpress",
    "@hooka/pack-cloudflare",
    "@hooka/pack-wordpress-cloudflare",
  ],
});
