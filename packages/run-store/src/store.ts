import type {
  EnqueueRunResponse,
  RunDetail,
  RunEvent,
  RunSummary,
  TaskRunResult,
} from "@hooka/contracts";
import { runListQuerySchema } from "@hooka/contracts";
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
} from "./rows";
import type {
  ClaimedRun,
  EnqueueRunInput,
  RunEventRow,
  RunRow,
  RunStoreOptions,
  RunSummaryFilters,
} from "./rows";
import { initializeRunStoreSchema } from "./schema";

export const defaultHookaDbPath = "/data/hooka.sqlite";

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
