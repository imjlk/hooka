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
    packages: [
      "php-cli",
      "php-phar",
      "php-mysqli",
      "php-mbstring",
      "php-openssl",
      "php-curl",
      "php-iconv",
      "php-ctype",
      "php-tokenizer",
      "curl",
      "bash",
    ],
  },
  tasks: ["wordpress.wpcli.eval"],
});
