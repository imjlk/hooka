import { expect, test } from "bun:test";
import { deploySimplyStaticTask } from "@hooka/pack-wordpress-cloudflare";
import {
  buildTaskInputFromFlags,
  taskToBunliOptions,
} from "./task-options";

test("scalar task schemas turn into bunli options", () => {
  const options = taskToBunliOptions(deploySimplyStaticTask);

  expect(Object.keys(options)).toEqual([
    "kind",
    "source-path",
    "project",
    "branch",
    "commit-sha",
    "payload-json",
    "payload-file",
    "dry-run",
  ]);
});

test("enqueue option mode omits dry-run", () => {
  const options = taskToBunliOptions(deploySimplyStaticTask, {
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
