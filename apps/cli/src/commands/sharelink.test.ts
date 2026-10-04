import { expect, test } from "bun:test";
import { join } from "node:path";
import { temporarySetup } from "../../../../packages/pack-toss-sharelink/src/fixtures";
import { createRunStore } from "@hooka/run-store";

async function cli(args: string[], env: Record<string, string>) {
  const child = Bun.spawn(
    [process.execPath, "apps/cli/src/index.ts", "sharelink", ...args],
    { env: { ...Bun.env, ...env }, stdout: "pipe", stderr: "pipe" },
  );
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect(code, stderr).toBe(0);
  return JSON.parse(stdout);
}

test("offline tools validate, preview and plan without creating DBs or resolving provider secrets", async () => {
  const setup = await temporarySetup();
  try {
    const env = {
      ...setup.env,
      TEST_ACCESS: "",
      TEST_SECRET: "",
      HOOKA_DB_PATH: join(setup.directory, "queue.sqlite"),
    };
    expect((await cli(["validate"], env)).ok).toBe(true);
    expect((await cli(["status"], env)).initialized).toBe(false);
    expect((await cli(["plan"], env)).jobs).toHaveLength(1);
    expect((await cli(["tick", "--dry-run"], env)).jobs).toHaveLength(1);
    const fixture = join(setup.directory, "catalog.json");
    await Bun.write(
      fixture,
      JSON.stringify({
        categories: [{ id: "10", children: [] }],
        products: [
          {
            id: "123",
            title: "편안한 베개",
            categoryIds: ["10"],
            soldOut: false,
          },
        ],
      }),
    );
    expect(
      (await cli(["preview", "--app", "app-one", "--fixture", fixture], env))
        .subjects[0].candidates[0].productId,
    ).toBe("123");
    expect(await Bun.file(env.HOOKA_DB_PATH).exists()).toBe(false);
    expect(await Bun.file(env.HOOKA_SHARELINK_DB_PATH).exists()).toBe(false);
  } finally {
    await setup.cleanup();
  }
});

test("concurrent CLI ticks enqueue one active batch and status exposes only failure codes", async () => {
  const setup = await temporarySetup();
  try {
    const env = {
      ...setup.env,
      HOOKA_DB_PATH: join(setup.directory, "queue.sqlite"),
    };
    const reports = await Promise.all(
      Array.from({ length: 3 }, (_, index) =>
        cli(["tick", "--period-minutes", String(index + 1)], env),
      ),
    );
    expect(
      new Set(
        reports.flatMap((report) =>
          report.runs.map((run: { runId: string }) => run.runId),
        ),
      ).size,
    ).toBe(1);
    expect(
      reports.flatMap((report) => report.runs).filter((run) => run.created),
    ).toHaveLength(1);
    const store = await createRunStore({ dbPath: env.HOOKA_DB_PATH });
    const first = store.listRuns()[0];
    expect(first).toBeDefined();
    if (!first) throw new Error("Missing run");
    store.finishRun(first.id, {
      taskId: first.taskId,
      ok: false,
      status: "failed",
      errorCode: "sharelink_access_denied",
      stderr: "private-provider-response",
      durationMs: 1,
    });
    store.close();
    const status = await cli(["status"], env);
    expect(status.recentFailures[0].errorCode).toBe("sharelink_access_denied");
    expect(JSON.stringify(status)).not.toContain("private-provider-response");
  } finally {
    await setup.cleanup();
  }
});

test("status filters configured apps before limiting the newest failures", async () => {
  const setup = await temporarySetup();
  try {
    const env = {
      ...setup.env,
      HOOKA_DB_PATH: join(setup.directory, "queue.sqlite"),
    };
    const store = await createRunStore({ dbPath: env.HOOKA_DB_PATH });
    try {
      const insert = store.db.query(
        "INSERT INTO runs(id,task_id,source,status,payload_json,capability_snapshot_json,created_at,last_error_code) VALUES (?,?,?,?,?,?,?,?)",
      );
      store.db.transaction(() => {
        for (let index = 0; index < 102; index++) {
          insert.run(
            `failure-${index}`,
            "toss-sharelink.refresh",
            "test",
            "failed",
            JSON.stringify({ appId: index === 0 ? "app-one" : "another-app" }),
            "[]",
            new Date(Date.now() + index * 1000).toISOString(),
            "sharelink_access_denied",
          );
        }
      })();
    } finally {
      store.close();
    }
    const result = await cli(["status"], env);
    expect(result.recentFailures).toHaveLength(1);
    expect(result.recentFailures[0].runId).toBe("failure-0");
  } finally {
    await setup.cleanup();
  }
});
