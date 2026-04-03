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
      target_id text,
      status text not null,
      payload_json text not null,
      result_json text,
      summary text,
      error_text text,
      capability_snapshot_json text not null,
      attempt_count integer not null default 0,
      max_attempts integer not null default 3,
      next_retry_at text,
      last_error_code text,
      target_policy_json text,
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
  db.exec(`
    create table if not exists worker_heartbeats (
      worker_id text primary key,
      runtime_role text not null,
      installed_capabilities_json text not null,
      last_seen_at text not null,
      current_run_id text
    );
  `);
  db.exec(`
    create table if not exists audit_events (
      sequence integer primary key autoincrement,
      created_at text not null,
      category text not null,
      action text not null,
      outcome text not null,
      subject_type text not null,
      subject_id text,
      client_ip text,
      request_path text,
      message text not null,
      context_json text
    );
  `);
  migrateRunsTable(db);
  db.exec(
    "create index if not exists idx_runs_status_queued on runs(status, queued_at, created_at);",
  );
  db.exec(
    "create index if not exists idx_runs_lease on runs(status, lease_expires_at);",
  );
  db.exec(
    "create index if not exists idx_runs_status_next_retry on runs(status, next_retry_at, queued_at, created_at);",
  );
  db.exec(
    "create index if not exists idx_run_events_run_id_created_at on run_events(run_id, created_at);",
  );
  db.exec(
    "create index if not exists idx_worker_heartbeats_last_seen on worker_heartbeats(last_seen_at);",
  );
  db.exec(
    "create index if not exists idx_audit_events_created_at on audit_events(created_at desc, sequence desc);",
  );
  db.exec(
    "create index if not exists idx_audit_events_category_outcome on audit_events(category, outcome, created_at desc);",
  );
}

function migrateRunsTable(db: Database): void {
  const columns = new Set(
    (db.query("pragma table_info(runs)").all() as Array<{ name: string }>).map(
      (column) => column.name,
    ),
  );

  ensureColumn(db, columns, "target_id", "text");
  ensureColumn(db, columns, "max_attempts", "integer not null default 3");
  ensureColumn(db, columns, "next_retry_at", "text");
  ensureColumn(db, columns, "last_error_code", "text");
  ensureColumn(db, columns, "target_policy_json", "text");
}

function ensureColumn(
  db: Database,
  columns: Set<string>,
  name: string,
  sqlType: string,
): void {
  if (columns.has(name)) {
    return;
  }

  db.exec(`alter table runs add column ${name} ${sqlType}`);
}
