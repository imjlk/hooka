import { defineCapability } from "@hooka/task-sdk";

export const gitCapability = defineCapability({
  id: "git",
  title: "Git",
  description: "Git support for release and deployment metadata workflows.",
  binaries: ["git"],
  healthcheck: {
    command: "git",
    args: ["--version"],
  },
  docker: {
    feature: "git",
    installScript: "docker/features/git.sh",
  },
});
