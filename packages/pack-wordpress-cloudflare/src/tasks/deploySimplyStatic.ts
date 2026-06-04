import { defineTask } from "@hooka/task-sdk";
import { sharedVolumeWranglerInputSchema } from "../schema";

export const sharedVolumeWranglerInput = sharedVolumeWranglerInputSchema;
export const deploySimplyStaticInput = sharedVolumeWranglerInput;
export const trailbaseUploadsPagesInput = sharedVolumeWranglerInputSchema;

function wranglerPagesDeployArgs(input: {
  sourcePath: string;
  project: string;
  branch?: string;
  commitSha?: string;
  commitMessage?: string;
  commitDirty?: boolean;
  skipCaching?: boolean;
  noBundle?: boolean;
  uploadSourceMaps?: boolean;
}) {
  return [
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
  ];
}

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
    args: ({ input }) => wranglerPagesDeployArgs(input),
  },
  tags: ["wrangler", "deploy", "shared-volume"],
});

export const trailbaseUploadsPagesTask = defineTask({
  id: "deploy.trailbase-pages.full",
  aliases: ["deploy.trailbase-uploads.pages"],
  title: "Deploy TrailBase full static Pages root",
  description:
    "Run wrangler against a TrailBase shared Pages root with generated uploads and static files.",
  input: trailbaseUploadsPagesInput,
  requires: ["wrangler"],
  executor: {
    kind: "process",
    command: "wrangler",
    args: ({ input }) => wranglerPagesDeployArgs(input),
  },
  tags: ["wrangler", "deploy", "shared-volume", "trailbase"],
});

export const deploySimplyStaticTask = sharedVolumeWranglerTask;
