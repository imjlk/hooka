import type { TaskRunResult } from "@hooka/contracts";
import type { CommandRunner } from "@hooka/executor-process";
import { getTask } from "@hooka/registry";
import type { RunStore } from "@hooka/run-store";
import { runTask } from "@hooka/runner-core";

export const defaultWorkerPollIntervalMs = 2_000;
export const defaultRunLeaseMs = 900_000;

export interface ProcessNextRunOptions {
  commandRunner?: CommandRunner;
  installedCapabilities: string[];
  manifestPath: string;
  runStore: RunStore;
  workerId: string;
  leaseMs: number;
}

export interface WorkerLoopOptions extends ProcessNextRunOptions {
  pollIntervalMs?: number;
}

export async function processNextRun(
  options: ProcessNextRunOptions,
): Promise<boolean> {
  options.runStore.requeueExpiredRuns();
  const claimed = options.runStore.claimNextQueuedRun(
    options.workerId,
    options.leaseMs,
  );

  if (!claimed) {
    return false;
  }

  const task = getTask(claimed.taskId);
  const result = task
    ? await executeTaskSafely(task, claimed.payload, options)
    : missingTaskResult(claimed.taskId);

  options.runStore.finishRun(claimed.id, result);
  return true;
}

export async function startWorkerLoop(options: WorkerLoopOptions): Promise<never> {
  const pollIntervalMs =
    options.pollIntervalMs ?? defaultWorkerPollIntervalMs;

  while (true) {
    try {
      const processed = await processNextRun(options);

      if (!processed) {
        await sleep(pollIntervalMs);
      }
    } catch (error) {
      console.error(
        `[${new Date().toISOString()}] hooka-worker loop error`,
        error,
      );
      await sleep(pollIntervalMs);
    }
  }
}

export function getDefaultWorkerId(): string {
  return Bun.env.HOOKA_WORKER_ID ?? Bun.env.HOSTNAME ?? process.env.HOSTNAME ?? "hooka-worker";
}

function missingTaskResult(taskId: string): TaskRunResult {
  return {
    taskId,
    ok: false,
    status: "failed",
    summary: `Task not found: ${taskId}.`,
    durationMs: 0,
  };
}

async function executeTaskSafely(
  task: NonNullable<ReturnType<typeof getTask>>,
  payload: unknown,
  options: ProcessNextRunOptions,
): Promise<TaskRunResult> {
  try {
    return await runTask(task, payload, {
      installedCapabilities: options.installedCapabilities,
      manifestPath: options.manifestPath,
      commandRunner: options.commandRunner,
    });
  } catch (error) {
    return {
      taskId: task.id,
      ok: false,
      status: "failed",
      summary: error instanceof Error ? error.message : String(error),
      stderr: error instanceof Error ? error.stack ?? error.message : String(error),
      durationMs: 0,
    };
  }
}

async function sleep(ms: number): Promise<void> {
  await Bun.sleep(ms);
}
