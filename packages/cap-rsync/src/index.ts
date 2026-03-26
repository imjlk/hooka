import { defineCapability } from "@hooka/task-sdk";

export const rsyncCapability = defineCapability({
  id: "rsync",
  title: "rsync",
  description: "Filesystem sync support for export distribution and backups.",
  binaries: ["rsync"],
  healthcheck: {
    command: "rsync",
    args: ["--version"],
  },
  docker: {
    feature: "rsync",
    installScript: "docker/features/rsync.sh",
  },
});
