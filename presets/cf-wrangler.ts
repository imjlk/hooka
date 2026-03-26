import { definePreset } from "@hooka/task-sdk";

export const cfWranglerPreset = definePreset({
  id: "cf-wrangler",
  title: "Cloudflare Wrangler",
  description: "A compact preset for Cloudflare Pages operations.",
  imageTag: "cf-wrangler",
  capabilities: ["wrangler", "git"],
  taskPacks: ["@hooka/pack-cloudflare"],
});
