import { defineCapability } from "@hooka/task-sdk";

export const cloudflareApiCapability = defineCapability({
  id: "cloudflare-api",
  title: "Cloudflare API",
  description: "Direct Cloudflare API access for cache purge and future control-plane tasks.",
  binaries: ["bun"],
  requiredEnv: [
    {
      match: "allOf",
      names: ["CLOUDFLARE_API_TOKEN"],
      description: "Cloudflare API token with cache purge permission.",
      secret: true,
    },
  ],
  healthcheck: {
    command: "bun",
    args: ["--version"],
  },
  tasks: ["cloudflare.cache.purge.urls"],
});
