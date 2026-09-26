import { defineTask } from "@hooka/task-sdk";
import { z } from "zod";

// rclone would parse a leading `-` as a flag, so reject it up front.
const rclonePathSchema = (field: string) =>
  z
    .string()
    .min(1)
    .refine((value) => !value.startsWith("-"), {
      message: `${field} must not start with '-'.`,
    });

export const copyDirectoryInput = z.object({
  sourcePath: rclonePathSchema("sourcePath"),
  destination: rclonePathSchema("destination"),
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
