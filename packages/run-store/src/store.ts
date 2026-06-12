import type {
  AuditEvent,
  EnqueueRunResponse,
  RunDetail,
  RunEvent,
  RunSummary,
  TaskRunResult,
  WorkerHeartbeat,
} from "@hooka/contracts";
import {
  auditEventListQuerySchema,
  runListQuerySchema,
} from "@hooka/contracts";
import { ensureDir } from "@hooka/bun-utils";
import { Database } from "bun:sqlite";
import { dirname } from "node:path";
import {
  toEnqueueResponse,
  toRunDetail,
  toRunEvent,
  toRunSummary,
} from "./mappers";
import {
  normalizeRunSummaryFilters,
  toAuditEvent,
  toWorkerHeartbeat,
} from "./rows";
import type {
  AuditEventFilters,
  AuditEventRow,
  ClaimedRun,
  EnqueueRunInput,
  RunEventRow,
  RunRow,
  RunStoreOptions,
  RunSummaryFilters,
  WorkerHeartbeatRow,
} from "./rows";
import { initializeRunStoreSchema } from "./schema";

export const defaultHookaDbPath = "/data/hooka.sqlite";
const terminalRunStatuses = [
  "succeeded",
  "failed",
  "dead-lettered",
  "skipped",
] as const;

export class RunStore {
  readonly db: Database;
  readonly now: () => Date;

  constructor(dbPath: string, options: RunStoreOptions = {}) {
    this.db = new Database(dbPath, {
      create: true,
      strict: true,
    });
    this.now = options.now ?? (() => new Date());
    initializeRunStoreSchema(this.db);
  }

  close(): void {
    this.db.close();
  }

  enqueueRun(input: EnqueueRunInput): {
    response: EnqueueRunResponse;
    run: RunDetail;
    created: boolean;
  } {
    const queuedAt = this.timestamp();
    const runId = crypto.randomUUID();

    return this.withTransaction(() => {
      if (input.sourceEventId) {
        const existing = this.findRunBySourceEventId(input.sourceEventId);
        if (existing) {
          return {
            response: toEnqueueResponse(existing, true),
            run: existing,
            created: false,
          };
        }
      }

      this.db
        .query(
          `insert into runs (
            id,
            task_id,
            source,
            source_event_id,
            target_id,
            status,
            payload_json,
            result_json,
            summary,
            error_text,
            capability_snapshot_json,
            attempt_count,
            max_attempts,
            target_max_concurrent_runs,
            next_retry_at,
            last_error_code,
            target_policy_json,
            created_at,
            queued_at,
            started_at,
            finished_at,
            lease_expires_at,
            worker_id
          ) values (?, ?, ?, ?, ?, 'queued', ?, null, null, null, ?, 0, ?, ?, null, null, ?, ?, ?, null, null, null, null)`,
        )
        .run(
          runId,
          input.taskId,
          input.source,
          input.sourceEventId ?? null,
          input.targetId ?? null,
          JSON.stringify(input.input),
          JSON.stringify(input.capabilitySnapshot),
          input.maxAttempts ?? 3,
          input.targetMaxConcurrentRuns ?? null,
          input.targetPolicy ? JSON.stringify(input.targetPolicy) : null,
          queuedAt,
          queuedAt,
        );

      this.insertEvent(runId, "queued", `Run queued for ${input.taskId}.`, {
        source: input.source,
        sourceEventId: input.sourceEventId ?? null,
      });

      const createdRun = this.requireRun(runId);
      return {
        response: toEnqueueResponse(createdRun, false),
        run: createdRun,
        created: true,
      };
    });
  }

  listRuns(limit = 20): RunSummary[] {
    return this.queryRuns({
      limit,
    });
  }

  queryRuns(filters: RunSummaryFilters = {}): RunSummary[] {
    const normalizedFilters = normalizeRunSummaryFilters(
      runListQuerySchema.parse({
        limit: filters.limit,
        status: filters.status,
        taskId: filters.taskId,
        source: filters.source,
      }),
    );
    const conditions: string[] = [];
    const params: Array<string | number> = [];

    if (normalizedFilters.status) {
      conditions.push("status = ?");
      params.push(normalizedFilters.status);
    }

    if (normalizedFilters.taskId) {
      conditions.push("task_id = ?");
      params.push(normalizedFilters.taskId);
    }

    if (normalizedFilters.source) {
      conditions.push("source = ?");
      params.push(normalizedFilters.source);
    }

    const whereClause =
      conditions.length > 0 ? `where ${conditions.join(" and ")}` : "";
    params.push(normalizedFilters.limit ?? 20);

    const rows = this.db
      .query(
        `select * from runs
         ${whereClause}
         order by created_at desc
         limit ?`,
      )
      .all(...params) as RunRow[];

    return rows.map((row) => toRunSummary(row));
  }

  getRun(runId: string): RunDetail | null {
    const row = this.db
      .query(`select * from runs where id = ? limit 1`)
      .get(runId) as RunRow | null;

    if (!row) {
      return null;
    }

    return this.toDetailedRun(row);
  }

  requeueExpiredRuns(): number {
    const now = this.timestamp();
    const rows = this.db
      .query(
        `select id, attempt_count, max_attempts from runs
         where status = 'running'
           and lease_expires_at is not null
           and lease_expires_at <= ?
         order by lease_expires_at asc`,
      )
      .all(now) as Array<{
      id: string;
      attempt_count: number;
      max_attempts: number;
    }>;

    if (rows.length === 0) {
      return 0;
    }

    return this.withTransaction(() => {
      for (const row of rows) {
        const nextAttemptCount = row.attempt_count + 1;

        if (nextAttemptCount >= row.max_attempts) {
          this.db
            .query(
              `update runs
               set status = 'dead-lettered',
                   summary = ?,
                   error_text = ?,
                   attempt_count = ?,
                   next_retry_at = null,
                   finished_at = ?,
                   lease_expires_at = null,
                   worker_id = null
               where id = ?`,
            )
            .run(
              "Run lease expired too many times and was moved to the dead-letter queue.",
              "Run lease expired too many times and was moved to the dead-letter queue.",
              nextAttemptCount,
              now,
              row.id,
            );

          this.insertEvent(
            row.id,
            "dead-lettered",
            "Run lease expired too many times and was moved to the dead-letter queue.",
            {
              attempts: nextAttemptCount,
              errorCode: "lease_expired",
            },
          );
          continue;
        }

        this.db
          .query(
            `update runs
             set status = 'queued',
                 queued_at = ?,
                 started_at = null,
                 finished_at = null,
                 lease_expires_at = null,
                 next_retry_at = null,
                 worker_id = null,
                 attempt_count = ?
             where id = ?`,
          )
          .run(now, nextAttemptCount, row.id);

        this.insertEvent(
          row.id,
          "requeued",
          "Run lease expired and was returned to the queue.",
        );
      }

      return rows.length;
    });
  }

  claimNextQueuedRun(
    workerId: string,
    leaseMs: number,
    options: { eligibleTaskIds?: string[]; knownTaskIds?: string[] } = {},
  ): ClaimedRun | null {
    const eligibleTaskIds =
      options.eligibleTaskIds === undefined
        ? undefined
        : [...new Set(options.eligibleTaskIds)].filter(Boolean).sort();
    const knownTaskIds =
      options.knownTaskIds === undefined
        ? undefined
        : [...new Set(options.knownTaskIds)].filter(Boolean).sort();

    if (eligibleTaskIds?.length === 0 && knownTaskIds === undefined) {
      return null;
    }

    const taskFilter = buildClaimTaskFilter(eligibleTaskIds, knownTaskIds);

    return this.withTransaction(() => {
      for (let attempt = 0; attempt < 10; attempt += 1) {
        const now = this.timestamp();
        const queued = this.db
          .query(
            `select id from runs
             where status = 'queued'
               and (next_retry_at is null or next_retry_at <= ?)
               ${taskFilter.sql}
               and (
                 target_id is null
                 or target_max_concurrent_runs is null
                 or (
                   select count(*)
                   from runs running_runs
                   where running_runs.status = 'running'
                     and running_runs.target_id = runs.target_id
                 ) < target_max_concurrent_runs
               )
             order by queued_at asc, created_at asc
             limit 1`,
          )
          .get(now, ...taskFilter.params) as { id: string } | null;

        if (!queued) {
          return null;
        }

        const startedAt = this.timestamp();
        const leaseExpiresAt = new Date(
          this.now().getTime() + leaseMs,
        ).toISOString();
        const changes = this.db
          .query(
            `update runs
             set status = 'running',
                 worker_id = ?,
                 started_at = ?,
                 lease_expires_at = ?,
                 next_retry_at = null
             where id = ?
               and status = 'queued'`,
          )
          .run(workerId, startedAt, leaseExpiresAt, queued.id).changes;

        if (changes === 0) {
          continue;
        }

        this.insertEvent(
          queued.id,
          "started",
          `Worker ${workerId} started execution.`,
          {
            workerId,
            leaseExpiresAt,
          },
        );

        const claimed = this.requireRunRow(queued.id);
        return {
          id: claimed.id,
          taskId: claimed.task_id,
          targetId: claimed.target_id,
          payload: JSON.parse(claimed.payload_json),
          attemptCount: claimed.attempt_count,
          maxAttempts: claimed.max_attempts,
          targetPolicy: claimed.target_policy_json
            ? JSON.parse(claimed.target_policy_json)
            : null,
        };
      }

      return null;
    });
  }

  finishRun(
    runId: string,
    result: TaskRunResult,
    input: { attemptCount?: number } = {},
  ): RunDetail {
    return this.withTransaction(() => {
      const finishedAt = this.timestamp();
      const errorText =
        result.status === "failed" || result.status === "dead-lettered"
          ? (result.stderr ?? result.summary ?? null)
          : null;

      this.db
        .query(
          `update runs
           set status = ?,
               result_json = ?,
               summary = ?,
               error_text = ?,
               attempt_count = ?,
               next_retry_at = null,
               last_error_code = ?,
               finished_at = ?,
               lease_expires_at = null
           where id = ?`,
        )
        .run(
          result.status,
          JSON.stringify(result),
          result.summary ?? null,
          errorText,
          input.attemptCount ?? this.requireRun(runId).attemptCount,
          result.errorCode ?? null,
          finishedAt,
          runId,
        );

      this.insertEvent(
        runId,
        result.status,
        result.summary ?? `Run finished with status ${result.status}.`,
        {
          ok: result.ok,
          status: result.status,
          retryable: result.retryable ?? false,
          errorCode: result.errorCode ?? null,
          command: result.command,
          durationMs: result.durationMs,
        },
      );

      return this.requireRun(runId);
    });
  }

  scheduleRetry(
    runId: string,
    result: TaskRunResult,
    input: { attemptCount: number; nextRetryAt: string },
  ): RunDetail {
    return this.withTransaction(() => {
      this.db
        .query(
          `update runs
           set status = 'queued',
               result_json = ?,
               summary = ?,
               error_text = ?,
               attempt_count = ?,
               next_retry_at = ?,
               last_error_code = ?,
               queued_at = ?,
               started_at = null,
               finished_at = null,
               lease_expires_at = null,
               worker_id = null
           where id = ?`,
        )
        .run(
          JSON.stringify(result),
          result.summary ?? "Retry scheduled.",
          result.stderr ?? result.summary ?? null,
          input.attemptCount,
          input.nextRetryAt,
          result.errorCode ?? null,
          this.timestamp(),
          runId,
        );

      this.insertEvent(
        runId,
        "retry-scheduled",
        result.summary
          ? `${result.summary} Retry scheduled.`
          : "Retry scheduled.",
        {
          status: result.status,
          retryable: result.retryable ?? true,
          attemptCount: input.attemptCount,
          retryAt: input.nextRetryAt,
          errorCode: result.errorCode ?? null,
        },
      );

      return this.requireRun(runId);
    });
  }

  deadLetterRun(
    runId: string,
    result: TaskRunResult,
    input: { attemptCount: number },
  ): RunDetail {
    return this.withTransaction(() => {
      this.db
        .query(
          `update runs
           set status = 'dead-lettered',
               result_json = ?,
               summary = ?,
               error_text = ?,
               attempt_count = ?,
               next_retry_at = null,
               last_error_code = ?,
               finished_at = ?,
               lease_expires_at = null
           where id = ?`,
        )
        .run(
          JSON.stringify({
            ...result,
            status: "dead-lettered",
            retryable: false,
          }),
          result.summary ?? "Run moved to the dead-letter queue.",
          result.stderr ?? result.summary ?? null,
          input.attemptCount,
          result.errorCode ?? null,
          this.timestamp(),
          runId,
        );

      this.insertEvent(
        runId,
        "dead-lettered",
        result.summary ?? "Run moved to the dead-letter queue.",
        {
          status: "dead-lettered",
          retryable: false,
          attempts: input.attemptCount,
          errorCode: result.errorCode ?? null,
        },
      );

      return this.requireRun(runId);
    });
  }

  appendEvent(
    runId: string,
    type: string,
    message: string,
    data?: unknown,
  ): RunEvent {
    return this.withBusyRetry(() => {
      this.insertEvent(runId, type, message, data);
      return this.requireEvent(runId);
    });
  }

  upsertWorkerHeartbeat(input: {
    workerId: string;
    runtimeRole: string;
    installedCapabilities: string[];
    currentRunId?: string | null;
  }): WorkerHeartbeat {
    const lastSeenAt = this.timestamp();
    return this.withBusyRetry(() => {
      this.db
        .query(
          `insert into worker_heartbeats (
            worker_id,
            runtime_role,
            installed_capabilities_json,
            last_seen_at,
            current_run_id
          ) values (?, ?, ?, ?, ?)
          on conflict(worker_id) do update set
            runtime_role = excluded.runtime_role,
            installed_capabilities_json = excluded.installed_capabilities_json,
            last_seen_at = excluded.last_seen_at,
            current_run_id = excluded.current_run_id`,
        )
        .run(
          input.workerId,
          input.runtimeRole,
          JSON.stringify(input.installedCapabilities),
          lastSeenAt,
          input.currentRunId ?? null,
        );

      return this.requireWorkerHeartbeat(input.workerId);
    });
  }

  listWorkerHeartbeats(): WorkerHeartbeat[] {
    const rows = this.db
      .query(
        `select * from worker_heartbeats
         order by last_seen_at desc, worker_id asc`,
      )
      .all() as WorkerHeartbeatRow[];

    return rows.map((row) => toWorkerHeartbeat(row));
  }

  appendAuditEvent(input: {
    category: AuditEvent["category"];
    action: string;
    outcome: AuditEvent["outcome"];
    subjectType: string;
    subjectId?: string | null;
    clientIp?: string | null;
    requestPath?: string | null;
    message: string;
    context?: unknown;
  }): AuditEvent {
    return this.withBusyRetry(() => {
      const result = this.db
        .query(
          `insert into audit_events (
            created_at,
            category,
            action,
            outcome,
            subject_type,
            subject_id,
            client_ip,
            request_path,
            message,
            context_json
          ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          this.timestamp(),
          input.category,
          input.action,
          input.outcome,
          input.subjectType,
          input.subjectId ?? null,
          input.clientIp ?? null,
          input.requestPath ?? null,
          input.message,
          input.context === undefined ? null : JSON.stringify(input.context),
        );

      return this.requireAuditEvent(Number(result.lastInsertRowid));
    });
  }

  listAuditEvents(filters: AuditEventFilters = {}): AuditEvent[] {
    const normalizedFilters = auditEventListQuerySchema.parse({
      limit: filters.limit,
      category: filters.category,
      outcome: filters.outcome,
    });
    const conditions: string[] = [];
    const params: Array<string | number> = [];

    if (normalizedFilters.category) {
      conditions.push("category = ?");
      params.push(normalizedFilters.category);
    }

    if (normalizedFilters.outcome) {
      conditions.push("outcome = ?");
      params.push(normalizedFilters.outcome);
    }

    const whereClause =
      conditions.length > 0 ? `where ${conditions.join(" and ")}` : "";
    params.push(normalizedFilters.limit ?? 20);

    const rows = this.db
      .query(
        `select * from audit_events
         ${whereClause}
         order by sequence desc
         limit ?`,
      )
      .all(...params) as AuditEventRow[];

    return rows.map((row) => toAuditEvent(row));
  }

  getLastRunEventSequence(): number {
    const row = this.db
      .query(`select max(rowid) as value from run_events`)
      .get() as { value: number | null };

    return row.value ?? 0;
  }

  getLastAuditEventSequence(): number {
    const row = this.db
      .query(`select max(sequence) as value from audit_events`)
      .get() as { value: number | null };

    return row.value ?? 0;
  }

  cleanupRetention(input: {
    runFinishedBefore?: string;
    auditCreatedBefore?: string;
    workerHeartbeatSeenBefore?: string;
    vacuum?: boolean;
  }): {
    deletedRuns: number;
    deletedRunEvents: number;
    deletedAuditEvents: number;
    deletedWorkerHeartbeats: number;
  } {
    const result = this.withTransaction(() => {
      let deletedRuns = 0;
      let deletedRunEvents = 0;
      let deletedAuditEvents = 0;
      let deletedWorkerHeartbeats = 0;

      if (input.runFinishedBefore) {
        deletedRunEvents = this.db
          .query(
            `delete from run_events
             where run_id in (
               select id from runs
               where status in (${terminalRunStatuses.map(() => "?").join(", ")})
                 and finished_at is not null
                 and finished_at < ?
             )`,
          )
          .run(...terminalRunStatuses, input.runFinishedBefore).changes;

        deletedRuns = this.db
          .query(
            `delete from runs
             where status in (${terminalRunStatuses.map(() => "?").join(", ")})
               and finished_at is not null
               and finished_at < ?`,
          )
          .run(...terminalRunStatuses, input.runFinishedBefore).changes;
      }

      if (input.auditCreatedBefore) {
        deletedAuditEvents = this.db
          .query(`delete from audit_events where created_at < ?`)
          .run(input.auditCreatedBefore).changes;
      }

      if (input.workerHeartbeatSeenBefore) {
        deletedWorkerHeartbeats = this.db
          .query(`delete from worker_heartbeats where last_seen_at < ?`)
          .run(input.workerHeartbeatSeenBefore).changes;
      }

      return {
        deletedRuns,
        deletedRunEvents,
        deletedAuditEvents,
        deletedWorkerHeartbeats,
      };
    });

    if (
      input.vacuum &&
      (result.deletedRuns > 0 ||
        result.deletedRunEvents > 0 ||
        result.deletedAuditEvents > 0 ||
        result.deletedWorkerHeartbeats > 0)
    ) {
      this.withBusyRetry(() => {
        this.db.exec("vacuum");
      });
    }

    return result;
  }

  listRunEventsSince(
    sequence = 0,
    limit = 100,
  ): Array<RunEvent & { sequence: number }> {
    const rows = this.db
      .query(
        `select rowid as sequence, * from run_events
         where rowid > ?
         order by rowid asc
         limit ?`,
      )
      .all(sequence, limit) as Array<RunEventRow & { sequence: number }>;

    return rows.map((row) => ({
      sequence: row.sequence,
      ...toRunEvent(row),
    }));
  }

  private findRunBySourceEventId(sourceEventId: string): RunDetail | null {
    const row = this.db
      .query(`select * from runs where source_event_id = ? limit 1`)
      .get(sourceEventId) as RunRow | null;

    return row ? this.toDetailedRun(row) : null;
  }

  private toDetailedRun(row: RunRow): RunDetail {
    const events = this.db
      .query(
        `select * from run_events
         where run_id = ?
         order by created_at asc`,
      )
      .all(row.id) as RunEventRow[];

    return toRunDetail(row, events);
  }

  private insertEvent(
    runId: string,
    type: string,
    message: string,
    data?: unknown,
  ): void {
    this.db
      .query(
        `insert into run_events (
          id,
          run_id,
          type,
          message,
          data_json,
          created_at
        ) values (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        crypto.randomUUID(),
        runId,
        type,
        message,
        data === undefined ? null : JSON.stringify(data),
        this.timestamp(),
      );
  }

  private requireRun(runId: string): RunDetail {
    const run = this.getRun(runId);

    if (!run) {
      throw new Error(`Run not found after write: ${runId}`);
    }

    return run;
  }

  private requireRunRow(runId: string): RunRow {
    const row = this.db
      .query(`select * from runs where id = ? limit 1`)
      .get(runId) as RunRow | null;

    if (!row) {
      throw new Error(`Run row not found after write: ${runId}`);
    }

    return row;
  }

  private requireEvent(runId: string): RunEvent {
    const row = this.db
      .query(
        `select * from run_events
         where run_id = ?
         order by created_at desc
         limit 1`,
      )
      .get(runId) as RunEventRow | null;

    if (!row) {
      throw new Error(`Run event not found after write: ${runId}`);
    }

    return toRunEvent(row);
  }

  private requireWorkerHeartbeat(workerId: string): WorkerHeartbeat {
    const row = this.db
      .query(`select * from worker_heartbeats where worker_id = ? limit 1`)
      .get(workerId) as WorkerHeartbeatRow | null;

    if (!row) {
      throw new Error(`Worker heartbeat not found after write: ${workerId}`);
    }

    return toWorkerHeartbeat(row);
  }

  private requireAuditEvent(sequence: number): AuditEvent {
    const row = this.db
      .query(
        `select * from audit_events
         where sequence = ?
         limit 1`,
      )
      .get(sequence) as AuditEventRow | null;

    if (!row) {
      throw new Error(`Audit event not found after write: ${sequence}`);
    }

    return toAuditEvent(row);
  }

  private timestamp(): string {
    return this.now().toISOString();
  }

  private withTransaction<T>(callback: () => T): T {
    return this.withBusyRetry(() => {
      this.db.exec("begin immediate");
      try {
        const result = callback();
        if (result instanceof Promise) {
          throw new Error("withTransaction callback must be synchronous.");
        }
        this.db.exec("commit");
        return result;
      } catch (error) {
        this.db.exec("rollback");
        throw error;
      }
    });
  }

  private withBusyRetry<T>(callback: () => T): T {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        return callback();
      } catch (error) {
        if (!isSqliteBusyError(error) || attempt === 4) {
          throw error;
        }

        sleepSync(25 * (attempt + 1));
      }
    }

    throw new Error("Unreachable SQLite retry state.");
  }
}

function buildClaimTaskFilter(
  eligibleTaskIds: string[] | undefined,
  knownTaskIds: string[] | undefined,
): { sql: string; params: string[] } {
  if (eligibleTaskIds === undefined) {
    return { sql: "", params: [] };
  }

  if (knownTaskIds === undefined) {
    return {
      sql: `and task_id in (${eligibleTaskIds.map(() => "?").join(", ")})`,
      params: eligibleTaskIds,
    };
  }

  if (knownTaskIds.length === 0) {
    return { sql: "", params: [] };
  }

  const clauses: string[] = [];
  const params: string[] = [];

  if (eligibleTaskIds.length > 0) {
    clauses.push(`task_id in (${eligibleTaskIds.map(() => "?").join(", ")})`);
    params.push(...eligibleTaskIds);
  }

  clauses.push(`task_id not in (${knownTaskIds.map(() => "?").join(", ")})`);
  params.push(...knownTaskIds);

  return {
    sql: `and (${clauses.join(" or ")})`,
    params,
  };
}

function isSqliteBusyError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const code =
    "code" in error && typeof error.code === "string" ? error.code : "";
  const text = `${code} ${error.message}`;

  return text.includes("SQLITE_BUSY") || text.includes("SQLITE_LOCKED");
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export async function createRunStore(
  options: RunStoreOptions = {},
): Promise<RunStore> {
  const dbPath = options.dbPath ?? defaultHookaDbPath;

  if (dbPath !== ":memory:") {
    await ensureDir(dirname(dbPath));
  }

  return new RunStore(dbPath, options);
}
