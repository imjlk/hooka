import { defineTask } from "@hooka/task-sdk";
import { z } from "zod";

export const wpcliEvalInput = z.object({
  path: z.string().default("/var/www/html"),
  code: z.string().min(1),
  user: z.string().optional(),
});

export const wpcliEvalTask = defineTask({
  id: "wordpress.wpcli.eval",
  title: "Run WP-CLI eval",
  description: "Execute inline PHP through wp-cli inside a WordPress install.",
  input: wpcliEvalInput,
  requires: ["wpcli", "php-cli"],
  executor: {
    kind: "process",
    command: "wp",
    args: ({ input }) => [
      "--path",
      input.path,
      ...(input.user ? ["--user", input.user] : []),
      "eval",
      input.code,
    ],
  },
  tags: ["wordpress", "wpcli"],
});
