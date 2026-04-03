import type { TaskRunResult } from "@hooka/contracts";
import {
  defaultRunLeaseMs,
  defaultRetryBaseDelayMs,
  defaultWorkerHeartbeatIntervalMs,
  defaultWorkerPollIntervalMs,
  getDefaultWorkerId,
} from "@hooka/config";
import type { CommandRunner } from "@hooka/executor-process";
import type { Logger } from "@hooka/logger";
import { getTask } from "@hooka/registry";
import type { ClaimedRun, RunStore } from "@hooka/run-store";
import { runTask } from "@hooka/runner-core";
import {
  validateArtifactReadiness,
  validateTargetPolicyInput,
} from "@hooka/targets";
import type { WorkerShutdownSignal } from "./shutdown";

export {
  defaultRetryBaseDelayMs,
  defaultRunLeaseMs,
  defaultWorkerHeartbeatIntervalMs,
  defaultWorkerPollIntervalMs,
  getDefaultWorkerId,
};

export interface ProcessNextRunOptions {
  commandRunner?: CommandRunner;
  installedCapabilities: string[];
  manifestPath: string;
  runtimeRole: string;
  runStore: RunStore;
  workerId: string;
  leaseMs: number;
  retryBaseDelayMs: number;
}

export interface WorkerLoopOptions extends ProcessNextRunOptions {
  heartbeatIntervalMs?: number;
  logger?: Logger;
  shutdownSignal?: WorkerShutdownSignal;
  sleep?: (ms: number) => Promise<void>;
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

  options.runStore.upsertWorkerHeartbeat({
    workerId: options.workerId,
    runtimeRole: options.runtimeRole,
    installedCapabilities: options.installedCapabilities,
    currentRunId: claimed.id,
  });

  try {
    const task = getTask(claimed.taskId);
    const result = task
      ? await executeTaskWithPreflight(task, claimed, options)
      : missingTaskResult(claimed.taskId);

    const attemptCount = claimed.attemptCount + 1;
    if (result.status === "failed" && result.retryable) {
      if (attemptCount >= claimed.maxAttempts) {
        options.runStore.deadLetterRun(claimed.id, result, {
          attemptCount,
        });
      } else {
        options.runStore.scheduleRetry(claimed.id, result, {
          attemptCount,
          nextRetryAt: new Date(
            Date.now() +
              computeRetryDelayMs(attemptCount, options.retryBaseDelayMs),
          ).toISOString(),
        });
      }
    } else {
      options.runStore.finishRun(claimed.id, result, {
        attemptCount,
      });
    }
  } finally {
    options.runStore.upsertWorkerHeartbeat({
      workerId: options.workerId,
      runtimeRole: options.runtimeRole,
      installedCapabilities: options.installedCapabilities,
      currentRunId: null,
    });
  }
  return true;
}

export async function startWorkerLoop(
  options: WorkerLoopOptions,
): Promise<void> {
  const pollIntervalMs = options.pollIntervalMs ?? defaultWorkerPollIntervalMs;
  const heartbeatIntervalMs =
    options.heartbeatIntervalMs ?? defaultWorkerHeartbeatIntervalMs;
  const sleepFn = options.sleep ?? sleep;
  let lastHeartbeatAt = 0;

  while (!options.shutdownSignal?.isShutdownRequested()) {
    try {
      const now = Date.now();
      if (now - lastHeartbeatAt >= heartbeatIntervalMs) {
        options.runStore.upsertWorkerHeartbeat({
          workerId: options.workerId,
          runtimeRole: options.runtimeRole,
          installedCapabilities: options.installedCapabilities,
          currentRunId: null,
        });
        lastHeartbeatAt = now;
      }

      const processed = await processNextRun(options);

      if (!processed && !options.shutdownSignal?.isShutdownRequested()) {
        await sleepFn(pollIntervalMs);
      }
    } catch (error) {
      if (error instanceof Error) {
        options.logger?.error("Worker loop error", error);
      } else {
        options.logger?.error("Worker loop error", {
          error: String(error),
        });
      }
      if (!options.shutdownSignal?.isShutdownRequested()) {
        await sleepFn(pollIntervalMs);
      }
    }
  }
}

function missingTaskResult(taskId: string): TaskRunResult {
  return {
    taskId,
    ok: false,
    status: "failed",
    retryable: false,
    errorCode: "task_not_found",
    summary: `Task not found: ${taskId}.`,
    durationMs: 0,
  };
}

async function executeTaskWithPreflight(
  task: NonNullable<ReturnType<typeof getTask>>,
  claimed: ClaimedRun,
  options: ProcessNextRunOptions,
): Promise<TaskRunResult> {
  const payload = claimed.payload;
  const preflightIssues = await getPreflightIssues(claimed, payload);

  if (preflightIssues.length > 0) {
    const retryable = preflightIssues.every((issue) => issue.retryable);
    const summary = preflightIssues.map((issue) => issue.message).join(" ");
    options.runStore.appendEvent(claimed.id, "preflight-rejected", summary, {
      issues: preflightIssues,
    });

    return {
      taskId: task.id,
      ok: false,
      status: "failed",
      retryable,
      errorCode: preflightIssues[0]?.code ?? "preflight_rejected",
      summary,
      stderr: summary,
      durationMs: 0,
      data: {
        issues: preflightIssues,
      },
    };
  }

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
      retryable: true,
      errorCode: "task_runtime_failed",
      summary: error instanceof Error ? error.message : String(error),
      stderr:
        error instanceof Error ? (error.stack ?? error.message) : String(error),
      durationMs: 0,
    };
  }
}

async function getPreflightIssues(claimed: ClaimedRun, payload: unknown) {
  if (!claimed.targetId || !claimed.targetPolicy) {
    return [];
  }

  const input =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : {};

  const target = {
    id: claimed.targetId,
    title: claimed.targetId,
    taskId: "",
    source: "target",
    defaultInput: {},
    maxAttempts: 1,
    policy: claimed.targetPolicy,
  };
  const policyIssues = validateTargetPolicyInput(target, input);
  if (policyIssues.length > 0) {
    return policyIssues;
  }

  return validateArtifactReadiness(
    input,
    claimed.targetPolicy.artifactReadiness,
  );
}

function computeRetryDelayMs(
  attemptCount: number,
  baseDelayMs: number,
): number {
  return Math.min(baseDelayMs * 2 ** Math.max(0, attemptCount - 1), 300_000);
}

async function sleep(ms: number): Promise<void> {
  await Bun.sleep(ms);
}
