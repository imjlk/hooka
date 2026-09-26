import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { createTempDir, removeDir } from "@hooka/bun-utils";
import { join } from "node:path";
import { createRunStore } from "./index";

const childScript = join(
  import.meta.dir,
  "fixtures/concurrent-store-process.ts",
);

async function runConcurrentStoreProcesses(
  dbPath: string,
  mode: "claim" | "open",
  count: number,
): Promise<Array<{ claimed: string[] }>> {
  const startAt = Date.now() + 500;
  const processes = Array.from({ length: count }, (_, index) =>
    Bun.spawn(
      [
        process.execPath,
        childScript,
        dbPath,
        mode,
        `worker-${index}`,
        String(startAt),
      ],
      { stdout: "pipe", stderr: "pipe" },
    ),
  );

  return Promise.all(
    processes.map(async (child) => {
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);

      if (exitCode !== 0) {
        throw new Error(`store process exited with ${exitCode}: ${stderr}`);
      }

      return JSON.parse(stdout) as { claimed: string[] };
    }),
  );
}

test("workers racing over an expired lease never claim the same run twice", async () => {
  const tempDir = await createTempDir("hooka-run-store-race");
  const dbPath = join(tempDir, "hooka.sqlite");

  try {
    const store = await createRunStore({ dbPath });
    for (let index = 0; index < 20; index += 1) {
      store.enqueueRun({
        taskId: "deploy.shared-volume.wrangler",
        input: { index },
        source: "test",
        capabilitySnapshot: [],
        maxAttempts: 10,
      });
    }
    // Every run is held by a worker that died a minute ago.
    store.db
      .query(
        `update runs
           set status = 'running',
               worker_id = 'dead-worker',
               started_at = ?,
               lease_expires_at = ?`,
      )
      .run(
        new Date(Date.now() - 120_000).toISOString(),
        new Date(Date.now() - 60_000).toISOString(),
      );
    store.close();

    const results = await runConcurrentStoreProcesses(dbPath, "claim", 4);
    const claims = results.flatMap((result) => result.claimed);

    expect(claims).toHaveLength(20);
    expect(new Set(claims).size).toBe(20);
  } finally {
    await removeDir(tempDir);
  }
}, 30_000);

test("processes opening an old database together migrate it once", async () => {
  const tempDir = await createTempDir("hooka-run-store-migrate");
  const dbPath = join(tempDir, "hooka.sqlite");

  try {
    // The 1.0.0 runs table, before the target and retry columns existed.
    const db = new Database(dbPath, { create: true });
    db.exec("pragma journal_mode = WAL;");
    db.exec(`
        create table runs (
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
    db.close();

    await runConcurrentStoreProcesses(dbPath, "open", 3);

    const store = await createRunStore({ dbPath });
    const columns = (
      store.db.query("pragma table_info(runs)").all() as Array<{
        name: string;
      }>
    ).map((column) => column.name);
    store.close();

    expect(columns).toEqual(
      expect.arrayContaining([
        "target_id",
        "max_attempts",
        "target_max_concurrent_runs",
        "next_retry_at",
        "last_error_code",
        "target_policy_json",
      ]),
    );
  } finally {
    await removeDir(tempDir);
  }
}, 30_000);
