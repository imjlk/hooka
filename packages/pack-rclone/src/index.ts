import { defineTaskPack } from "@hooka/task-sdk";
import { copyDirectoryTask } from "./tasks/copyDirectory";

export { copyDirectoryInput, copyDirectoryTask } from "./tasks/copyDirectory";

export const rcloneTaskPack = defineTaskPack({
  id: "@hooka/pack-rclone",
  title: "rclone Pack",
  description: "Artifact copy tasks backed by rclone.",
  tasks: [copyDirectoryTask],
});
