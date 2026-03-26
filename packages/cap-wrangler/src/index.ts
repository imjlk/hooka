import { defineCapability } from "@hooka/task-sdk";

export const wranglerCapability = defineCapability({
  id: "wrangler",
  title: "Wrangler",
  description: "Cloudflare CLI support for Pages deployment and API tooling.",
  binaries: ["wrangler"],
  healthcheck: {
    command: "wrangler",
    args: ["--version"],
  },
  docker: {
    feature: "wrangler",
    installScript: "docker/features/wrangler.sh",
  },
  tasks: [
    "cloudflare.pages.deploy",
    "wordpress.deploy.simply-static",
  ],
});
