import type { Database } from "bun:sqlite";

export function initializeRunStoreSchema(db: Database): void {
  db.exec("pragma journal_mode = WAL;");
  db.exec("pragma busy_timeout = 5000;");
  db.exec(`
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
  db.exec(`
    create table if not exists run_events (
      id text primary key,
      run_id text not null,
      type text not null,
      message text not null,
      data_json text,
      created_at text not null
    );
  `);
  db.exec(
    "create index if not exists idx_runs_status_queued on runs(status, queued_at, created_at);",
  );
  db.exec(
    "create index if not exists idx_runs_lease on runs(status, lease_expires_at);",
  );
  db.exec(
    "create index if not exists idx_run_events_run_id_created_at on run_events(run_id, created_at);",
  );
}
