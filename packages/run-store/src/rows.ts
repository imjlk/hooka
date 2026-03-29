import type {
  EnqueueRunRequest,
  RunListQuery,
  TaskRunStatus,
} from "@hooka/contracts";

export interface RunRow {
  id: string;
  task_id: string;
  source: string;
  source_event_id: string | null;
  status: string;
  payload_json: string;
  result_json: string | null;
  summary: string | null;
  error_text: string | null;
  capability_snapshot_json: string;
  attempt_count: number;
  created_at: string;
  queued_at: string | null;
  started_at: string | null;
  finished_at: string | null;
  lease_expires_at: string | null;
  worker_id: string | null;
}

export interface RunEventRow {
  id: string;
  run_id: string;
  type: string;
  message: string;
  data_json: string | null;
  created_at: string;
}

export interface RunStoreOptions {
  dbPath?: string;
  now?: () => Date;
}

export interface EnqueueRunInput extends EnqueueRunRequest {
  capabilitySnapshot: string[];
}

export interface ClaimedRun {
  id: string;
  taskId: string;
  payload: unknown;
  attemptCount: number;
}

export interface RunSummaryFilters {
  limit?: number;
  status?: TaskRunStatus;
  taskId?: string;
  source?: string;
}

export function normalizeRunSummaryFilters(
  filters: RunListQuery,
): RunSummaryFilters {
  return {
    limit: filters.limit,
    status: filters.status,
    taskId: filters.taskId,
    source: filters.source,
  };
}
