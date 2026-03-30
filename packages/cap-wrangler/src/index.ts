import { defineCapability } from "@hooka/task-sdk";

export const wranglerCapability = defineCapability({
  id: "wrangler",
  title: "Wrangler",
  description: "Cloudflare CLI support for Pages deployment and API tooling.",
  binaries: ["wrangler"],
  requiredEnv: [
    {
      match: "allOf",
      names: ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"],
      description:
        "Cloudflare credentials used by wrangler for non-interactive deploys.",
      secret: true,
    },
  ],
  healthcheck: {
    command: "wrangler",
    args: ["--version"],
  },
  docker: {
    feature: "wrangler",
    installScript: "docker/features/wrangler.sh",
  },
  tasks: ["cloudflare.pages.deploy", "deploy.shared-volume.wrangler"],
});
