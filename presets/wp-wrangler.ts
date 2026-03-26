import { definePreset } from "@hooka/task-sdk";

export const wpWranglerPreset = definePreset({
  id: "wp-wrangler",
  title: "WordPress Wrangler",
  description:
    "Primary preset for WordPress export, wp-cli operations, and Cloudflare deploys.",
  imageTag: "wp-wrangler",
  capabilities: ["wrangler", "wpcli", "php-cli", "rsync", "git"],
  taskPacks: [
    "@hooka/pack-wordpress",
    "@hooka/pack-cloudflare",
    "@hooka/pack-wordpress-cloudflare",
  ],
});
