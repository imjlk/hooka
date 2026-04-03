import type {
  EnqueueRunRequest,
  RunListQuery,
  TaskRunStatus,
  TargetPolicy,
  WorkerHeartbeat,
} from "@hooka/contracts";

export interface RunRow {
  id: string;
  task_id: string;
  source: string;
  source_event_id: string | null;
  target_id: string | null;
  status: string;
  payload_json: string;
  result_json: string | null;
  summary: string | null;
  error_text: string | null;
  capability_snapshot_json: string;
  attempt_count: number;
  max_attempts: number;
  next_retry_at: string | null;
  last_error_code: string | null;
  target_policy_json: string | null;
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
  maxAttempts?: number;
  targetId?: string;
  targetPolicy?: TargetPolicy;
}

export interface ClaimedRun {
  id: string;
  taskId: string;
  targetId: string | null;
  payload: unknown;
  attemptCount: number;
  maxAttempts: number;
  targetPolicy: TargetPolicy | null;
}

export interface RunSummaryFilters {
  limit?: number;
  status?: TaskRunStatus;
  taskId?: string;
  source?: string;
}

export interface WorkerHeartbeatRow {
  worker_id: string;
  runtime_role: string;
  installed_capabilities_json: string;
  last_seen_at: string;
  current_run_id: string | null;
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

export function toWorkerHeartbeat(row: WorkerHeartbeatRow): WorkerHeartbeat {
  return {
    workerId: row.worker_id,
    runtimeRole: row.runtime_role,
    installedCapabilities: JSON.parse(row.installed_capabilities_json),
    lastSeenAt: row.last_seen_at,
    currentRunId: row.current_run_id,
  };
}
