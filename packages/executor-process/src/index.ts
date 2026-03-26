import type { TaskRunResult } from "@hooka/contracts";
import type { HookaTask, TaskInputSchema } from "@hooka/task-sdk";
import { z } from "zod";

export interface CommandExecutionResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface CommandRunnerInput {
  command: string[];
  cwd?: string;
  env: Record<string, string | undefined>;
}

export type CommandRunner = (
  input: CommandRunnerInput,
) => Promise<CommandExecutionResult>;

export interface RunProcessTaskOptions {
  commandRunner?: CommandRunner;
  env?: Record<string, string | undefined>;
}

export const bunCommandRunner: CommandRunner = async ({
  command,
  cwd,
  env,
}) => {
  const subprocess = Bun.spawn({
    cmd: command,
    cwd,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(subprocess.stdout).text(),
    new Response(subprocess.stderr).text(),
    subprocess.exited,
  ]);

  return {
    stdout,
    stderr,
    exitCode,
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

  if (dryRun) {
    return {
      taskId: task.id,
      ok: true,
      status: "skipped",
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
    });

    return {
      taskId: task.id,
      ok: result.exitCode === 0,
      status: result.exitCode === 0 ? "succeeded" : "failed",
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
      command,
      stderr: error instanceof Error ? error.message : String(error),
      summary: `Failed to spawn ${command[0]}.`,
      durationMs: performance.now() - startedAt,
    };
  }
}
