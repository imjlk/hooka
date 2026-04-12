import { expect, test } from "bun:test";
import { defineTask } from "@hooka/task-sdk";
import { z } from "zod";
import { runProcessTask } from "./index";

const processTaskInput = z.object({
  exportDir: z.string(),
});

const processTask = defineTask({
  id: "test.process.task",
  title: "Test Process Task",
  input: processTaskInput,
  requires: [],
  executor: {
    kind: "process",
    command: "wrangler",
    args: ({ input }) => ["pages", "deploy", input.exportDir],
  },
});

test("runProcessTask returns skipped results for dry runs", async () => {
  const result = await runProcessTask(
    processTask,
    {
      exportDir: "/shared-source/site",
    },
    true,
  );

  expect(result).toMatchObject({
    ok: true,
    status: "skipped",
    command: ["wrangler", "pages", "deploy", "/shared-source/site"],
  });
});

test("runProcessTask reports command failures from the injected runner", async () => {
  const result = await runProcessTask(
    processTask,
    {
      exportDir: "/shared-source/site",
    },
    false,
    {
      commandRunner: async ({ command, env }) => {
        expect(command).toEqual([
          "wrangler",
          "pages",
          "deploy",
          "/shared-source/site",
        ]);
        expect(env).toBeDefined();

        return {
          stdout: "",
          stderr: "wrangler failed",
          exitCode: 1,
        };
      },
    },
  );

  expect(result).toMatchObject({
    ok: false,
    status: "failed",
    stderr: "wrangler failed",
    summary: "test.process.task exited with status 1.",
  });
});

test("runProcessTask reports timeout failures from the command runner", async () => {
  const timeoutTask = defineTask({
    id: processTask.id,
    title: processTask.title,
    input: processTask.input,
    requires: processTask.requires,
    executor: {
      kind: "process",
      command: "wrangler",
      args: ({ input }) => ["pages", "deploy", input.exportDir],
      timeoutMs: 25,
    },
  });

  const result = await runProcessTask(
    timeoutTask,
    {
      exportDir: "/shared-source/site",
    },
    false,
    {
      commandRunner: async ({ timeoutMs }) => {
        expect(timeoutMs).toBe(25);

        return {
          stdout: "",
          stderr: "",
          exitCode: 1,
          timedOut: true,
        };
      },
    },
  );

  expect(result).toMatchObject({
    ok: false,
    status: "failed",
    retryable: true,
    errorCode: "process_timeout",
    summary: "test.process.task timed out after 25ms.",
  });
});
