import type {
  EnqueueRunRequest,
  EnqueueRunResponse,
  RunDetail,
  RunEvent,
  RunSummary,
  TaskRunResult,
} from "@hooka/contracts";
import {
  enqueueRunResponseSchema,
  runDetailSchema,
  runEventSchema,
  runSummarySchema,
} from "@hooka/contracts";
import { ensureDir } from "@hooka/bun-utils";
import { Database } from "bun:sqlite";
import { dirname } from "node:path";

export const defaultHookaDbPath = "/data/hooka.sqlite";

interface RunRow {
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

interface RunEventRow {
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

export class RunStore {
  readonly db: Database;
  readonly now: () => Date;

  constructor(dbPath: string, options: RunStoreOptions = {}) {
    this.db = new Database(dbPath, {
      create: true,
      strict: true,
    });
    this.now = options.now ?? (() => new Date());
    this.initialize();
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
            response: this.toEnqueueResponse(existing, true),
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
            status,
            payload_json,
            result_json,
            summary,
            error_text,
            capability_snapshot_json,
            attempt_count,
            created_at,
            queued_at,
            started_at,
            finished_at,
            lease_expires_at,
            worker_id
          ) values (?, ?, ?, ?, 'queued', ?, null, null, null, ?, 0, ?, ?, null, null, null, null)`,
        )
        .run(
          runId,
          input.taskId,
          input.source,
          input.sourceEventId ?? null,
          JSON.stringify(input.input),
          JSON.stringify(input.capabilitySnapshot),
          queuedAt,
          queuedAt,
        );

      this.insertEvent(
        runId,
        "queued",
        `Run queued for ${input.taskId}.`,
        {
          source: input.source,
          sourceEventId: input.sourceEventId ?? null,
        },
      );

      const createdRun = this.requireRun(runId);
      return {
        response: this.toEnqueueResponse(createdRun, false),
        run: createdRun,
        created: true,
      };
    });
  }

  listRuns(limit = 20): RunSummary[] {
    const rows = this.db
      .query(
        `select * from runs
         order by created_at desc
         limit ?`,
      )
      .all(limit) as RunRow[];

    return rows.map((row) => this.toRunSummary(row));
  }

  getRun(runId: string): RunDetail | null {
    const row = this.db
      .query(`select * from runs where id = ? limit 1`)
      .get(runId) as RunRow | null;

    if (!row) {
      return null;
    }

    return this.toRunDetail(row);
  }

  requeueExpiredRuns(): number {
    const now = this.timestamp();
    const rows = this.db
      .query(
        `select id from runs
         where status = 'running'
           and lease_expires_at is not null
           and lease_expires_at <= ?
         order by lease_expires_at asc`,
      )
      .all(now) as Array<{ id: string }>;

    if (rows.length === 0) {
      return 0;
    }

    return this.withTransaction(() => {
      for (const row of rows) {
        this.db
          .query(
            `update runs
             set status = 'queued',
                 queued_at = ?,
                 started_at = null,
                 finished_at = null,
                 lease_expires_at = null,
                 worker_id = null,
                 attempt_count = attempt_count + 1
             where id = ?`,
          )
          .run(now, row.id);

        this.insertEvent(
          row.id,
          "requeued",
          "Run lease expired and was returned to the queue.",
        );
      }

      return rows.length;
    });
  }

  claimNextQueuedRun(workerId: string, leaseMs: number): ClaimedRun | null {
    const queued = this.db
      .query(
        `select id from runs
         where status = 'queued'
         order by queued_at asc, created_at asc
         limit 1`,
      )
      .get() as { id: string } | null;

    if (!queued) {
      return null;
    }

    const startedAt = this.timestamp();
    const leaseExpiresAt = new Date(this.now().getTime() + leaseMs).toISOString();
    const changes = this.db
      .query(
        `update runs
         set status = 'running',
             worker_id = ?,
             started_at = ?,
             lease_expires_at = ?
         where id = ?
           and status = 'queued'`,
      )
      .run(workerId, startedAt, leaseExpiresAt, queued.id).changes;

    if (changes === 0) {
      return this.claimNextQueuedRun(workerId, leaseMs);
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

    const claimed = this.requireRun(queued.id);
    return {
      id: claimed.id,
      taskId: claimed.taskId,
      payload: claimed.payload,
      attemptCount: claimed.attemptCount,
    };
  }

  finishRun(runId: string, result: TaskRunResult): RunDetail {
    return this.withTransaction(() => {
      const finishedAt = this.timestamp();
      const errorText =
        result.status === "failed" ? (result.stderr ?? result.summary ?? null) : null;

      this.db
        .query(
          `update runs
           set status = ?,
               result_json = ?,
               summary = ?,
               error_text = ?,
               finished_at = ?,
               lease_expires_at = null
           where id = ?`,
        )
        .run(
          result.status,
          JSON.stringify(result),
          result.summary ?? null,
          errorText,
          finishedAt,
          runId,
        );

      this.insertEvent(
        runId,
        result.status,
        result.summary ?? `Run finished with status ${result.status}.`,
        {
          ok: result.ok,
          command: result.command,
          durationMs: result.durationMs,
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
    this.insertEvent(runId, type, message, data);
    return this.requireEvent(runId);
  }

  private initialize(): void {
    this.db.exec("pragma journal_mode = WAL;");
    this.db.exec("pragma busy_timeout = 5000;");
    this.db.exec(`
      create table if not exists runs (
        id text primary key,
        task_id text not null,
        source text not null,
        source_event_id text unique,
        status text not null,
        payload_json text not null,
        result_json text,
        summary text,
        error_text text,
        capability_snapshot_json text not null,
        attempt_count integer not null default 0,
        created_at text not null,
        queued_at text,
        started_at text,
        finished_at text,
        lease_expires_at text,
        worker_id text
      );
    `);
    this.db.exec(`
      create table if not exists run_events (
        id text primary key,
        run_id text not null,
        type text not null,
        message text not null,
        data_json text,
        created_at text not null
      );
    `);
    this.db.exec(
      "create index if not exists idx_runs_status_queued on runs(status, queued_at, created_at);",
    );
    this.db.exec(
      "create index if not exists idx_runs_lease on runs(status, lease_expires_at);",
    );
    this.db.exec(
      "create index if not exists idx_run_events_run_id_created_at on run_events(run_id, created_at);",
    );
  }

  private findRunBySourceEventId(sourceEventId: string): RunDetail | null {
    const row = this.db
      .query(`select * from runs where source_event_id = ? limit 1`)
      .get(sourceEventId) as RunRow | null;

    return row ? this.toRunDetail(row) : null;
  }

  private toEnqueueResponse(
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

  private toRunSummary(row: RunRow): RunSummary {
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

  private toRunDetail(row: RunRow): RunDetail {
    const events = this.db
      .query(
        `select * from run_events
         where run_id = ?
         order by created_at asc`,
      )
      .all(row.id) as RunEventRow[];

    return runDetailSchema.parse({
      ...this.toRunSummary(row),
      payload: JSON.parse(row.payload_json),
      result: row.result_json ? JSON.parse(row.result_json) : null,
      capabilitySnapshot: JSON.parse(row.capability_snapshot_json),
      workerId: row.worker_id,
      leaseExpiresAt: row.lease_expires_at,
      events: events.map((event) => this.toRunEvent(event)),
    });
  }

  private toRunEvent(row: RunEventRow): RunEvent {
    return runEventSchema.parse({
      id: row.id,
      runId: row.run_id,
      type: row.type,
      message: row.message,
      data: row.data_json ? JSON.parse(row.data_json) : undefined,
      createdAt: row.created_at,
    });
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

    return this.toRunEvent(row);
  }

  private timestamp(): string {
    return this.now().toISOString();
  }

  private withTransaction<T>(callback: () => T): T {
    this.db.exec("begin immediate");
    try {
      const result = callback();
      this.db.exec("commit");
      return result;
    } catch (error) {
      this.db.exec("rollback");
      throw error;
    }
  }
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
