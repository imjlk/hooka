import { defineCapability } from "@hooka/task-sdk";

export const rcloneCapability = defineCapability({
  id: "rclone",
  title: "rclone",
  description: "Object storage sync and backup support through rclone.",
  binaries: ["rclone"],
  healthcheck: {
    command: "rclone",
    args: ["version"],
  },
  docker: {
    feature: "rclone",
    installScript: "docker/features/rclone.sh",
  },
});
