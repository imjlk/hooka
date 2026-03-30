import { expect, test } from "bun:test";
import { runProcessTask } from "@hooka/executor-process";
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
      "--project-name",
      "docs-site",
      "--branch",
      "preview",
    ],
  });
});
