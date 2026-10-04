import { expect, test } from "bun:test";
import { deploySimplyStaticTask } from "@hooka/pack-wordpress-cloudflare";
import { buildTaskInputFromFlags, taskToCliOptions } from "./task-options";

test("scalar task schemas turn into CLI options", () => {
  const options = taskToCliOptions(deploySimplyStaticTask);

  expect(Object.keys(options)).toEqual([
    "kind",
    "source-path",
    "project",
    "branch",
    "commit-sha",
    "commit-message",
    "commit-dirty",
    "skip-caching",
    "no-bundle",
    "upload-source-maps",
    "payload-json",
    "payload-file",
    "dry-run",
  ]);
});

test("enqueue option mode omits dry-run", () => {
  const options = taskToCliOptions(deploySimplyStaticTask, {
    includeDryRun: false,
  });

  expect(Object.keys(options)).not.toContain("dry-run");
});

test("payload json merges with scalar flags", async () => {
  const input = await buildTaskInputFromFlags(deploySimplyStaticTask, {
    "payload-json": JSON.stringify({
      project: "main-site",
      sourcePath: "/shared-source/from-json",
    }),
    "source-path": "/shared-source/override",
    "dry-run": true,
  });

  expect(input).toEqual({
    project: "main-site",
    sourcePath: "/shared-source/override",
  });
});
