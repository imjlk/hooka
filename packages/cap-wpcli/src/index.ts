import { defineCapability } from "@hooka/task-sdk";

export const wpcliCapability = defineCapability({
  id: "wpcli",
  title: "WP-CLI",
  description: "WordPress operational commands executed through wp-cli.",
  binaries: ["wp"],
  healthcheck: {
    command: "wp",
    args: ["--info"],
  },
  docker: {
    feature: "wpcli",
    installScript: "docker/features/wpcli.sh",
    packages: ["php-cli", "curl", "bash"],
  },
  tasks: [
    "wordpress.wpcli.eval",
  ],
});
