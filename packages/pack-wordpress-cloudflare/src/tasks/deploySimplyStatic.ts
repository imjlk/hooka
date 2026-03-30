import { defineTask } from "@hooka/task-sdk";
import { sharedVolumeWranglerInputSchema } from "../schema";

export const sharedVolumeWranglerInput = sharedVolumeWranglerInputSchema;
export const deploySimplyStaticInput = sharedVolumeWranglerInput;

export const sharedVolumeWranglerTask = defineTask({
  id: "deploy.shared-volume.wrangler",
  aliases: ["wordpress.deploy.simply-static"],
  title: "Deploy a shared-volume bundle with Wrangler",
  description:
    "Run wrangler against a directory that the worker can read from a shared source volume.",
  input: sharedVolumeWranglerInput,
  requires: ["wrangler"],
  executor: {
    kind: "process",
    command: "wrangler",
    args: ({ input }) => [
      "pages",
      "deploy",
      input.sourcePath,
      "--project-name",
      input.project,
      ...(input.branch ? ["--branch", input.branch] : []),
      ...(input.commitSha ? ["--commit-hash", input.commitSha] : []),
      ...(input.commitMessage ? ["--commit-message", input.commitMessage] : []),
      ...(input.commitDirty === undefined
        ? []
        : [`--commit-dirty=${input.commitDirty}`]),
      ...(input.skipCaching ? ["--skip-caching"] : []),
      ...(input.noBundle ? ["--no-bundle"] : []),
      ...(input.uploadSourceMaps ? ["--upload-source-maps"] : []),
    ],
  },
  tags: ["wrangler", "deploy", "shared-volume"],
});

export const deploySimplyStaticTask = sharedVolumeWranglerTask;
