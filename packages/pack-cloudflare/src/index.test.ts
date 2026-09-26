import { expect, test } from "bun:test";
import { runProcessTask } from "@hooka/executor-process";
import { runTask } from "@hooka/runner-core";
import { pagesDeployTask } from "./index";

test("pagesDeployTask dry run builds the expected wrangler command", async () => {
  const result = await runProcessTask(
    pagesDeployTask,
    {
      project: "docs-site",
      directory: "/shared-source/site",
      branch: "preview",
    },
    true,
  );

  expect(result).toMatchObject({
    ok: true,
    status: "skipped",
    command: [
      "wrangler",
      "pages",
      "deploy",
      "/shared-source/site",
      "--project-name=docs-site",
      "--branch=preview",
    ],
  });
});

test("pagesDeployTask rejects a directory that wrangler would parse as a flag", async () => {
  const result = await runTask(
    pagesDeployTask,
    {
      project: "docs-site",
      directory: "--help",
    },
    {
      dryRun: true,
    },
  );

  expect(result).toMatchObject({
    ok: false,
    status: "failed",
    retryable: false,
    errorCode: "input_invalid",
  });
});
