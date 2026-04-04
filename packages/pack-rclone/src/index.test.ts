import { expect, test } from "bun:test";
import { runTask } from "@hooka/runner-core";
import { copyDirectoryTask } from "./index";

test("copyDirectoryTask dry run builds the expected rclone command", async () => {
  const result = await runTask(
    copyDirectoryTask,
    {
      sourcePath: "/shared-source/site",
      destination: "remote:bucket/site",
    },
    {
      dryRun: true,
    },
  );

  expect(result).toMatchObject({
    ok: true,
    status: "skipped",
    retryable: false,
    command: ["rclone", "copy", "/shared-source/site", "remote:bucket/site"],
  });
});

test("copyDirectoryTask executes through the injected command runner", async () => {
  const result = await runTask(
    copyDirectoryTask,
    {
      sourcePath: "/shared-source/site",
      destination: "remote:bucket/site",
    },
    {
      installedCapabilities: ["rclone"],
      commandRunner: async ({ command }) => {
        expect(command).toEqual([
          "rclone",
          "copy",
          "/shared-source/site",
          "remote:bucket/site",
        ]);

        return {
          stdout: "copied",
          stderr: "",
          exitCode: 0,
        };
      },
    },
  );

  expect(result).toMatchObject({
    ok: true,
    status: "succeeded",
    retryable: false,
    stdout: "copied",
    command: ["rclone", "copy", "/shared-source/site", "remote:bucket/site"],
  });
});
