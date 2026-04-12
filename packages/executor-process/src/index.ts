import type { TaskRunResult } from "@hooka/contracts";
import type { HookaTask, TaskInputSchema } from "@hooka/task-sdk";
import type { z } from "zod";

export interface CommandExecutionResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut?: boolean;
}

export interface CommandRunnerInput {
  command: string[];
  cwd?: string;
  env: Record<string, string | undefined>;
  timeoutMs?: number;
}

export type CommandRunner = (
  input: CommandRunnerInput,
) => Promise<CommandExecutionResult>;

export interface RunProcessTaskOptions {
  commandRunner?: CommandRunner;
  env?: Record<string, string | undefined>;
}

export const defaultProcessTaskTimeoutMs = 60_000;

export const bunCommandRunner: CommandRunner = async ({
  command,
  cwd,
  env,
  timeoutMs,
}) => {
  const subprocess = Bun.spawn({
    cmd: command,
    cwd,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });

  let timedOut = false;
  const timeoutId =
    timeoutMs === undefined
      ? undefined
      : setTimeout(() => {
          timedOut = true;
          subprocess.kill();
        }, timeoutMs);

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(subprocess.stdout).text(),
    new Response(subprocess.stderr).text(),
    subprocess.exited,
  ]);

  if (timeoutId) {
    clearTimeout(timeoutId);
  }

  return {
    stdout,
    stderr,
    exitCode,
    timedOut,
  };
};

export async function runProcessTask<TSchema extends TaskInputSchema>(
  task: HookaTask<TSchema>,
  input: z.output<TSchema>,
  dryRun = false,
  options: RunProcessTaskOptions = {},
): Promise<TaskRunResult> {
  const startedAt = performance.now();
  const env = options.env ?? (Bun.env as Record<string, string | undefined>);
  const context = {
    input,
    dryRun,
    env,
  };
  const executor = task.executor;

  if (executor.kind !== "process") {
    throw new Error(`Task ${task.id} is not a process executor.`);
  }

  const command = [executor.command, ...executor.args(context)];
  const timeoutMs = executor.timeoutMs ?? defaultProcessTaskTimeoutMs;

  if (dryRun) {
    return {
      taskId: task.id,
      ok: true,
      status: "skipped",
      retryable: false,
      command,
      summary: "Dry run only. Command generation skipped execution.",
      durationMs: performance.now() - startedAt,
    };
  }

  try {
    const result = await (options.commandRunner ?? bunCommandRunner)({
      command,
      cwd: executor.cwd?.(context),
      env: {
        ...env,
        ...executor.env?.(context),
      },
      timeoutMs,
    });

    if (result.timedOut) {
      return {
        taskId: task.id,
        ok: false,
        status: "failed",
        retryable: true,
        errorCode: "process_timeout",
        command,
        stdout: result.stdout,
        stderr: result.stderr || `Process timed out after ${timeoutMs}ms.`,
        summary: `${task.id} timed out after ${timeoutMs}ms.`,
        durationMs: performance.now() - startedAt,
      };
    }

    return {
      taskId: task.id,
      ok: result.exitCode === 0,
      status: result.exitCode === 0 ? "succeeded" : "failed",
      retryable: result.exitCode !== 0,
      errorCode:
        result.exitCode === 0 ? undefined : `process_exit_${result.exitCode}`,
      command,
      stdout: result.stdout,
      stderr: result.stderr,
      summary:
        result.exitCode === 0
          ? `${task.id} completed successfully.`
          : `${task.id} exited with status ${result.exitCode}.`,
      durationMs: performance.now() - startedAt,
    };
  } catch (error) {
    return {
      taskId: task.id,
      ok: false,
      status: "failed",
      retryable: true,
      errorCode: "process_spawn_failed",
      command,
      stderr: error instanceof Error ? error.message : String(error),
      summary: `Failed to spawn ${command[0]}.`,
      durationMs: performance.now() - startedAt,
    };
  }
}
