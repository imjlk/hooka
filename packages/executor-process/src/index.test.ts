import { expect, test } from "bun:test";
import { defineTask } from "@hooka/task-sdk";
import { z } from "zod";
import {
  bunCommandRunner,
  processOutputHeadBytes,
  processOutputTailBytes,
  runProcessTask,
} from "./index";

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

test("runProcessTask can reject zero-exit results with task validation", async () => {
  const validatedTask = defineTask({
    id: "test.process.validated",
    title: "Validated Process Task",
    input: processTaskInput,
    requires: [],
    executor: {
      kind: "process",
      command: "wrangler",
      args: ({ input }) => ["pages", "deploy", input.exportDir],
      validateResult: ({ stdout }) => {
        if (stdout.includes("success")) {
          return { ok: true, summary: "validated" };
        }

        return {
          ok: false,
          errorCode: "output_unverified",
          summary: "Output was not verifiable.",
        };
      },
    },
  });

  const result = await runProcessTask(
    validatedTask,
    {
      exportDir: "/shared-source/site",
    },
    false,
    {
      commandRunner: async () => ({
        stdout: "wrangler header only",
        stderr: "",
        exitCode: 0,
      }),
    },
  );

  expect(result).toMatchObject({
    ok: false,
    status: "failed",
    retryable: true,
    errorCode: "output_unverified",
    summary: "Output was not verifiable.",
  });
});

test("runProcessTask reports validator exceptions as validation failures", async () => {
  const validatedTask = defineTask({
    id: "test.process.validator-throws",
    title: "Validated Process Task",
    input: processTaskInput,
    requires: [],
    executor: {
      kind: "process",
      command: "wrangler",
      args: ({ input }) => ["pages", "deploy", input.exportDir],
      validateResult: () => {
        throw new Error("validator exploded");
      },
    },
  });

  const result = await runProcessTask(
    validatedTask,
    {
      exportDir: "/shared-source/site",
    },
    false,
    {
      commandRunner: async () => ({
        stdout: "zero exit output",
        stderr: "",
        exitCode: 0,
      }),
    },
  );

  expect(result).toMatchObject({
    ok: false,
    status: "failed",
    retryable: true,
    errorCode: "process_result_validation_failed",
    stderr: "validator exploded",
    summary: "test.process.validator-throws result validation failed.",
  });
});

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("bunCommandRunner stops the whole process group on timeout", async () => {
  const startedAt = performance.now();
  // The shell prints the pid of a background sleep, then waits on it. Only
  // killing the process group stops both and closes the output pipe.
  const result = await bunCommandRunner({
    command: ["sh", "-c", "sleep 30 & echo $!; wait"],
    env: Bun.env as Record<string, string | undefined>,
    timeoutMs: 200,
  });
  const elapsedMs = performance.now() - startedAt;
  const backgroundPid = Number(result.stdout.trim());

  expect(result.timedOut).toBe(true);
  expect(elapsedMs).toBeLessThan(3_000);
  expect(Number.isInteger(backgroundPid) && backgroundPid > 0).toBe(true);
  expect(isProcessAlive(backgroundPid)).toBe(false);
});

test("bunCommandRunner escalates to SIGKILL when the group ignores SIGTERM", async () => {
  const startedAt = performance.now();
  const result = await bunCommandRunner({
    command: ["sh", "-c", "trap '' TERM; while :; do sleep 0.05; done"],
    env: Bun.env as Record<string, string | undefined>,
    timeoutMs: 100,
    killGraceMs: 200,
  });

  expect(result.timedOut).toBe(true);
  expect(performance.now() - startedAt).toBeLessThan(3_000);
});

test("bunCommandRunner returns when a background descendant keeps the pipes open", async () => {
  const startedAt = performance.now();
  const result = await bunCommandRunner({
    command: ["sh", "-c", "sleep 30 & echo started"],
    env: Bun.env as Record<string, string | undefined>,
    timeoutMs: 10_000,
    outputDrainMs: 200,
  });

  expect(result).toMatchObject({
    exitCode: 0,
    timedOut: false,
  });
  expect(result.stdout.trim()).toBe("started");
  expect(performance.now() - startedAt).toBeLessThan(3_000);
});

test("bunCommandRunner keeps the head and tail of oversized output", async () => {
  const totalBytes = 1_000_000;
  const result = await bunCommandRunner({
    command: [
      "sh",
      "-c",
      `printf 'first-line\\n'; head -c ${totalBytes} /dev/zero | tr '\\0' a; printf '\\nlast-line\\n'`,
    ],
    env: Bun.env as Record<string, string | undefined>,
    timeoutMs: 10_000,
  });

  expect(result.exitCode).toBe(0);
  expect(result.stdout.startsWith("first-line\n")).toBe(true);
  expect(result.stdout.endsWith("\nlast-line\n")).toBe(true);
  expect(result.stdout).toContain("bytes truncated");
  expect(result.stdout.length).toBeLessThan(
    processOutputHeadBytes + processOutputTailBytes + 100,
  );
});

test("runProcessTask withholds Hooka secrets from spawned tools", async () => {
  let childEnv: Record<string, string | undefined> = {};

  await runProcessTask(
    processTask,
    {
      exportDir: "/shared-source/site",
    },
    false,
    {
      env: {
        PATH: "/usr/bin",
        CLOUDFLARE_API_TOKEN: "cf-token",
        HOOKA_ADMIN_TOKEN: "admin-token",
        HOOKA_WEBHOOK_SECRET: "webhook-secret",
      },
      commandRunner: async ({ env }) => {
        childEnv = env;
        return {
          stdout: "",
          stderr: "",
          exitCode: 0,
        };
      },
    },
  );

  expect(childEnv).toEqual({
    PATH: "/usr/bin",
    CLOUDFLARE_API_TOKEN: "cf-token",
  });
});
