import { defineTask } from "@hooka/task-sdk";
import { z } from "zod";

export const copyDirectoryInput = z.object({
  sourcePath: z.string().min(1),
  destination: z.string().min(1),
});

export const copyDirectoryTask = defineTask({
  id: "rclone.copy.directory",
  title: "Copy local directory to remote with rclone",
  description:
    "Copy a worker-visible local directory into a configured rclone remote destination.",
  input: copyDirectoryInput,
  requires: ["rclone"],
  executor: {
    kind: "process",
    command: "rclone",
    args: ({ input }) => ["copy", input.sourcePath, input.destination],
  },
  tags: ["rclone", "copy", "remote", "artifact"],
});
