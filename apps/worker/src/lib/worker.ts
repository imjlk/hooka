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
import { getTask, listTasks } from "@hooka/registry";
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
  logger?: Logger;
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
  retentionAuditDays?: number;
  retentionRunDays?: number;
  retentionSweepIntervalHours?: number;
  shutdownSignal?: WorkerShutdownSignal;
  sleep?: (ms: number) => Promise<void>;
  pollIntervalMs?: number;
}

export async function processNextRun(
  options: ProcessNextRunOptions,
): Promise<boolean> {
  options.runStore.requeueExpiredRuns();
  const eligibleTaskIds = getEligibleTaskIds(options.installedCapabilities);
  const claimed = options.runStore.claimNextQueuedRun(
    options.workerId,
    options.leaseMs,
    { eligibleTaskIds },
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
        options.logger?.error("Run moved to dead-letter queue", {
          runId: claimed.id,
          taskId: claimed.taskId,
          targetId: claimed.targetId,
          attemptCount,
          maxAttempts: claimed.maxAttempts,
          errorCode: result.errorCode ?? null,
        });
      } else {
        const nextRetryAt = new Date(
          Date.now() +
            computeRetryDelayMs(attemptCount, options.retryBaseDelayMs),
        ).toISOString();
        options.runStore.scheduleRetry(claimed.id, result, {
          attemptCount,
          nextRetryAt,
        });
        options.logger?.warn("Run retry scheduled", {
          runId: claimed.id,
          taskId: claimed.taskId,
          targetId: claimed.targetId,
          attemptCount,
          maxAttempts: claimed.maxAttempts,
          nextRetryAt,
          errorCode: result.errorCode ?? null,
        });
      }
    } else {
      options.runStore.finishRun(claimed.id, result, {
        attemptCount,
      });
      const log = result.ok ? options.logger?.info : options.logger?.warn;
      log?.call(options.logger, "Run finished", {
        runId: claimed.id,
        taskId: claimed.taskId,
        targetId: claimed.targetId,
        status: result.status,
        attemptCount,
        maxAttempts: claimed.maxAttempts,
        errorCode: result.errorCode ?? null,
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
  const retentionRunDays = options.retentionRunDays ?? 30;
  const retentionAuditDays = options.retentionAuditDays ?? 90;
  const retentionSweepIntervalMs =
    (options.retentionSweepIntervalHours ?? 24) * 60 * 60 * 1000;
  const workerHeartbeatRetentionMs = Math.max(
    retentionSweepIntervalMs,
    heartbeatIntervalMs * 12,
  );
  const sleepFn = options.sleep ?? sleep;
  let consecutiveErrors = 0;
  let lastHeartbeatAt = 0;
  let lastRetentionSweepAt = 0;

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

      if (now - lastRetentionSweepAt >= retentionSweepIntervalMs) {
        const cleanupResult = options.runStore.cleanupRetention({
          runFinishedBefore: new Date(
            now - retentionRunDays * 24 * 60 * 60 * 1000,
          ).toISOString(),
          auditCreatedBefore: new Date(
            now - retentionAuditDays * 24 * 60 * 60 * 1000,
          ).toISOString(),
          workerHeartbeatSeenBefore: new Date(
            now - workerHeartbeatRetentionMs,
          ).toISOString(),
        });
        lastRetentionSweepAt = now;

        if (
          cleanupResult.deletedRuns > 0 ||
          cleanupResult.deletedRunEvents > 0 ||
          cleanupResult.deletedAuditEvents > 0 ||
          cleanupResult.deletedWorkerHeartbeats > 0
        ) {
          options.logger?.info(
            "Worker retention sweep completed",
            cleanupResult,
          );
        }
      }

      const processed = await processNextRun(options);
      consecutiveErrors = 0;

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
        consecutiveErrors += 1;
        await sleepFn(
          Math.min(1_000 * 2 ** Math.max(0, consecutiveErrors - 1), 30_000),
        );
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

export function getEligibleTaskIds(installedCapabilities: string[]): string[] {
  const installed = new Set(installedCapabilities);

  return listTasks()
    .filter((task) =>
      task.requires.every((requirement) => installed.has(requirement)),
    )
    .map((task) => task.id)
    .sort();
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
    options.runStore.appendAuditEvent({
      category: "policy",
      action: "target_policy_rejected",
      outcome: "rejected",
      subjectType: "target",
      subjectId: claimed.targetId,
      message: summary,
      context: {
        runId: claimed.id,
        taskId: task.id,
        issues: preflightIssues,
      },
    });
    options.logger?.warn("Target policy rejected during preflight", {
      runId: claimed.id,
      taskId: task.id,
      targetId: claimed.targetId,
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
