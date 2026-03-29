import { expect, test } from "bun:test";
import { runTask } from "@hooka/runner-core";
import { sharedVolumeWranglerTask } from "./index";

test("shared-volume wrangler task forwards useful Pages deploy flags", async () => {
  const result = await runTask(
    sharedVolumeWranglerTask,
    {
      kind: "pages-deploy",
      sourcePath: "/shared-source/export",
      project: "staging-site",
      branch: "main",
      commitSha: "abc123",
      commitMessage: "deploy export",
      commitDirty: true,
      skipCaching: true,
      noBundle: true,
      uploadSourceMaps: true,
    },
    {
      dryRun: true,
      installedCapabilities: ["wrangler"],
    },
  );

  expect(result.ok).toBe(true);
  expect(result.status).toBe("skipped");
  expect(result.command).toEqual([
    "wrangler",
    "pages",
    "deploy",
    "/shared-source/export",
    "--project-name",
    "staging-site",
    "--branch",
    "main",
    "--commit-hash",
    "abc123",
    "--commit-message",
    "deploy export",
    "--commit-dirty=true",
    "--skip-caching",
    "--no-bundle",
    "--upload-source-maps",
  ]);
});
