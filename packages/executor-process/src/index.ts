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
  /** Defaults to `processKillGraceMs`. */
  killGraceMs?: number;
  /** Defaults to `processOutputDrainMs`. */
  outputDrainMs?: number;
}

export type CommandRunner = (
  input: CommandRunnerInput,
) => Promise<CommandExecutionResult>;

export interface RunProcessTaskOptions {
  commandRunner?: CommandRunner;
  env?: Record<string, string | undefined>;
}

/**
 * Upper bound for a process task that does not set its own `timeoutMs`. It
 * stays below the default 15-minute run lease; deploy and sync tools such as
 * wrangler and rclone routinely need more than a minute.
 */
export const defaultProcessTaskTimeoutMs = 10 * 60_000;
/** How long a timed-out process group gets to exit before SIGKILL. */
export const processKillGraceMs = 5_000;
/** How long to wait for stdout/stderr to close after the child exits. */
export const processOutputDrainMs = 2_000;
/** Bytes kept from the start and the end of each output stream. */
export const processOutputHeadBytes = 64 * 1024;
export const processOutputTailBytes = 192 * 1024;

/** Worker secrets that spawned tools never need. */
const withheldEnvNames = ["HOOKA_ADMIN_TOKEN", "HOOKA_WEBHOOK_SECRET"];

export const bunCommandRunner: CommandRunner = async ({
  command,
  cwd,
  env,
  timeoutMs,
  killGraceMs = processKillGraceMs,
  outputDrainMs = processOutputDrainMs,
}) => {
  // Run the command in its own process group so a timeout can stop the
  // whole tree. Signalling only the direct child left grandchildren running
  // and holding the output pipes open, so the task never returned.
  const subprocess = Bun.spawn({
    cmd: command,
    cwd,
    env,
    stdout: "pipe",
    stderr: "pipe",
    detached: true,
  });
  const stdout = readBoundedOutput(subprocess.stdout);
  const stderr = readBoundedOutput(subprocess.stderr);

  let timedOut = false;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const timeoutTimer =
    timeoutMs === undefined
      ? undefined
      : setTimeout(() => {
          if (subprocess.exitCode !== null || subprocess.signalCode !== null) {
            return;
          }

          timedOut = true;
          signalProcessGroup(subprocess.pid, "SIGTERM");
          killTimer = setTimeout(() => {
            signalProcessGroup(subprocess.pid, "SIGKILL");
          }, killGraceMs);
        }, timeoutMs);

  const exitCode = await subprocess.exited;
  clearTimeout(timeoutTimer);
  clearTimeout(killTimer);

  // Descendants that outlive the child (for example `cmd &`) keep the pipes
  // open. Give the output a short drain window, then stop what is left of the
  // group and return whatever was captured.
  const drained = await Promise.race([
    Promise.all([stdout.done, stderr.done]).then(() => true),
    Bun.sleep(outputDrainMs).then(() => false),
  ]);

  if (!drained) {
    signalProcessGroup(subprocess.pid, "SIGKILL");
    stdout.cancel();
    stderr.cancel();
  }

  return {
    stdout: stdout.text(),
    stderr: stderr.text(),
    exitCode,
    timedOut,
  };
};

function signalProcessGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    // The group already exited.
  }
}

interface BoundedOutput {
  done: Promise<void>;
  cancel(): void;
  text(): string;
}

/**
 * Captures a stream without holding all of it in memory: keeps the first
 * `processOutputHeadBytes` and the last `processOutputTailBytes`, and replaces
 * the middle with a marker. Tools still print their final status last.
 */
function readBoundedOutput(stream: ReadableStream<Uint8Array>): BoundedOutput {
  const reader = stream.getReader();
  const head: Uint8Array[] = [];
  const tail: Uint8Array[] = [];
  let headBytes = 0;
  let tailBytes = 0;
  let droppedBytes = 0;

  const done = (async () => {
    try {
      while (true) {
        const { done: finished, value } = await reader.read();
        if (finished) {
          return;
        }

        let chunk = value;
        if (headBytes < processOutputHeadBytes) {
          const taken = chunk.subarray(0, processOutputHeadBytes - headBytes);
          head.push(taken);
          headBytes += taken.byteLength;
          chunk = chunk.subarray(taken.byteLength);
        }

        if (chunk.byteLength === 0) {
          continue;
        }

        tail.push(chunk);
        tailBytes += chunk.byteLength;
        while (tailBytes > processOutputTailBytes) {
          const first = tail[0];
          if (!first) {
            break;
          }

          const excess = tailBytes - processOutputTailBytes;
          if (first.byteLength <= excess) {
            tail.shift();
            tailBytes -= first.byteLength;
            droppedBytes += first.byteLength;
          } else {
            tail[0] = first.subarray(excess);
            tailBytes -= excess;
            droppedBytes += excess;
          }
        }
      }
    } catch {
      // Cancelled or the pipe broke; keep what was read.
    }
  })();

  return {
    done,
    cancel() {
      void reader.cancel().catch(() => {});
    },
    text() {
      const decode = (chunks: Uint8Array[]) =>
        new TextDecoder().decode(Buffer.concat(chunks));
      const marker =
        droppedBytes > 0 ? `\n[... ${droppedBytes} bytes truncated ...]\n` : "";
      return `${decode(head)}${marker}${decode(tail)}`;
    },
  };
}

function withoutWithheldEnv(
  env: Record<string, string | undefined>,
): Record<string, string | undefined> {
  const childEnv = { ...env };
  for (const name of withheldEnvNames) {
    delete childEnv[name];
  }
  return childEnv;
}

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
        ...withoutWithheldEnv(env),
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

    let validation:
      | ReturnType<NonNullable<typeof executor.validateResult>>
      | undefined;

    if (result.exitCode === 0 && executor.validateResult) {
      try {
        validation = executor.validateResult({
          input,
          dryRun,
          env,
          command,
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode,
        });
      } catch (error) {
        return {
          taskId: task.id,
          ok: false,
          status: "failed",
          retryable: true,
          errorCode: "process_result_validation_failed",
          command,
          stdout: result.stdout,
          stderr: error instanceof Error ? error.message : String(error),
          summary: `${task.id} result validation failed.`,
          durationMs: performance.now() - startedAt,
        };
      }
    }

    if (validation?.ok === false) {
      return {
        taskId: task.id,
        ok: false,
        status: "failed",
        retryable: validation.retryable ?? true,
        errorCode: validation.errorCode ?? "process_result_invalid",
        command,
        stdout: result.stdout,
        stderr: validation.stderr ?? result.stderr,
        summary: validation.summary,
        durationMs: performance.now() - startedAt,
        data: validation.data,
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
        validation?.summary ??
        (result.exitCode === 0
          ? `${task.id} completed successfully.`
          : `${task.id} exited with status ${result.exitCode}.`),
      durationMs: performance.now() - startedAt,
      data: validation?.data,
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
