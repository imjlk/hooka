import { TaskExecutionError } from "@hooka/task-sdk";

/** Never include upstream bodies, URLs, tokens, or configuration values in task logs. */
export function failure(code: string, retryable = false): TaskExecutionError {
  return new TaskExecutionError(`Toss Sharelink: ${code}.`, {
    code: `sharelink_${code}`,
    retryable,
  });
}
