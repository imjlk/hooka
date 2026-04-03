import type { TaskRunResult } from "@hooka/contracts";
import type { HookaTask, TaskInputSchema } from "@hooka/task-sdk";
import type { z } from "zod";

export interface RunHttpTaskOptions {
  env?: Record<string, string | undefined>;
}

export async function runHttpTask<TSchema extends TaskInputSchema>(
  task: HookaTask<TSchema>,
  input: z.output<TSchema>,
  dryRun = false,
  options: RunHttpTaskOptions = {},
): Promise<TaskRunResult> {
  const startedAt = performance.now();
  const context = {
    input,
    dryRun,
    env: options.env ?? (Bun.env as Record<string, string | undefined>),
  };
  const executor = task.executor;

  if (executor.kind !== "http") {
    throw new Error(`Task ${task.id} is not an HTTP executor.`);
  }

  const url = executor.url(context);
  const headers = executor.headers?.(context) ?? {};
  const body = executor.body?.(context);

  if (dryRun) {
    return {
      taskId: task.id,
      ok: true,
      status: "skipped",
      retryable: false,
      summary: `Dry run only. ${executor.method} ${url} was not sent.`,
      durationMs: performance.now() - startedAt,
      data: body,
    };
  }

  try {
    const response = await fetch(url, {
      method: executor.method,
      headers: {
        "content-type": "application/json",
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();

    return {
      taskId: task.id,
      ok: response.ok,
      status: response.ok ? "succeeded" : "failed",
      retryable: !response.ok,
      errorCode: response.ok ? undefined : `http_status_${response.status}`,
      summary: `${executor.method} ${url} returned ${response.status}.`,
      durationMs: performance.now() - startedAt,
      stdout: text,
    };
  } catch (error) {
    return {
      taskId: task.id,
      ok: false,
      status: "failed",
      retryable: true,
      errorCode: "http_request_failed",
      stderr: error instanceof Error ? error.message : String(error),
      summary: `HTTP execution for ${task.id} failed.`,
      durationMs: performance.now() - startedAt,
    };
  }
}
