import type {
  EnqueueRunResponse,
  RunDetail,
  RunEvent,
  RunSummary,
} from "@hooka/contracts";
import {
  enqueueRunResponseSchema,
  runDetailSchema,
  runEventSchema,
  runSummarySchema,
} from "@hooka/contracts";
import type { RunEventRow, RunRow } from "./rows";

export function toEnqueueResponse(
  run: RunDetail,
  existing: boolean,
): EnqueueRunResponse {
  return enqueueRunResponseSchema.parse({
    runId: run.id,
    taskId: run.taskId,
    status: run.status,
    createdAt: run.createdAt,
    existing,
  });
}

export function toRunSummary(row: RunRow): RunSummary {
  return runSummarySchema.parse({
    id: row.id,
    taskId: row.task_id,
    source: row.source,
    sourceEventId: row.source_event_id,
    status: row.status,
    summary: row.summary,
    errorText: row.error_text,
    attemptCount: row.attempt_count,
    createdAt: row.created_at,
    queuedAt: row.queued_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  });
}

export function toRunEvent(row: RunEventRow): RunEvent {
  return runEventSchema.parse({
    id: row.id,
    runId: row.run_id,
    type: row.type,
    message: row.message,
    data: row.data_json ? JSON.parse(row.data_json) : undefined,
    createdAt: row.created_at,
  });
}

export function toRunDetail(row: RunRow, events: RunEventRow[]): RunDetail {
  return runDetailSchema.parse({
    ...toRunSummary(row),
    payload: JSON.parse(row.payload_json),
    result: row.result_json ? JSON.parse(row.result_json) : null,
    capabilitySnapshot: JSON.parse(row.capability_snapshot_json),
    workerId: row.worker_id,
    leaseExpiresAt: row.lease_expires_at,
    events: events.map((event) => toRunEvent(event)),
  });
}
