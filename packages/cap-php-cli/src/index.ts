import { defineCapability } from "@hooka/task-sdk";

export const phpCliCapability = defineCapability({
  id: "php-cli",
  title: "PHP CLI",
  description: "PHP runtime for wp-cli and other PHP-backed utilities.",
  binaries: ["php"],
  healthcheck: {
    command: "php",
    args: ["--version"],
  },
  docker: {
    feature: "php-cli",
    installScript: "docker/features/php-cli.sh",
  },
  tasks: ["wordpress.wpcli.eval"],
});
