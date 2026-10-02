import { afterEach, beforeEach, expect, test } from "bun:test";
import { createTempDir, removeDir } from "@hooka/bun-utils";
import type { RunDetail, TaskRunStatus } from "@hooka/contracts";
import { targetPolicySchema } from "@hooka/contracts";
import { createRunStore, type RunStore } from "@hooka/run-store";
import { join } from "node:path";
import { createHookaFetchHandler } from "../../../server/src/app";

const cliEntry = join(process.cwd(), "apps/cli/src/index.ts");
let tempDir: string;
const stores: RunStore[] = [];
const servers: Array<ReturnType<typeof Bun.serve>> = [];

beforeEach(async () => {
  tempDir = await createTempDir("hooka-cli-runs");
});

afterEach(async () => {
  for (const server of servers.splice(0)) server.stop(true);
  for (const store of stores.splice(0)) store.close();
  await removeDir(tempDir);
});

async function createStore(dbPath = ":memory:") {
  const store = await createRunStore({ dbPath });
  stores.push(store);
  return store;
}

function serve(fetch: (request: Request) => Response | Promise<Response>) {
  const server = Bun.serve({ port: 0, fetch });
  servers.push(server);
  return `http://127.0.0.1:${server.port}`;
}

function serveHooka(runStore: RunStore) {
  return serve(
    createHookaFetchHandler({
      adminToken: "admin-token",
      apiRateLimit: 120,
      capabilityManifestPath: join(tempDir, "manifest.json"),
      loadCapabilities: async () => ({
        image: "hooka:test",
        generatedAt: new Date().toISOString(),
        installed: ["wrangler"],
      }),
      corsOrigins: [],
      defaultMaxAttempts: 3,
      globalApiRateLimit: 1200,
      globalWebhookRateLimit: 600,
      maxBodyBytes: 1_048_576,
      rateLimitWindowMs: 60_000,
      runStore,
      targetsPath: join(tempDir, "targets.json"),
      trustProxy: false,
      uiDistDir: join(tempDir, "ui"),
      webhookRateLimit: 60,
      webhookSecret: "secret",
    }),
  );
}

function enqueue(
  store: RunStore,
  taskId = "deploy.shared-volume.wrangler",
  source = "wordpress.webhook",
) {
  return store.enqueueRun({
    taskId,
    source,
    input: { project: "main-site", sourcePath: "/shared-source/site" },
    capabilitySnapshot: ["wrangler"],
  }).run;
}

function finish(store: RunStore, run: RunDetail, status: TaskRunStatus) {
  store.finishRun(run.id, {
    taskId: run.taskId,
    ok: status === "succeeded" || status === "skipped",
    status,
    durationMs: 1,
    summary: "test outcome",
  });
}

async function runCli(
  args: readonly string[],
  env: Record<string, string | undefined> = {},
) {
  const child = Bun.spawn([process.execPath, "run", cliEntry, "run", ...args], {
    cwd: tempDir,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...Bun.env,
      HOOKA_ADMIN_TOKEN: "",
      HOOKA_DB_PATH: join(tempDir, "unused-local.sqlite"),
      ...env,
    },
  });
  const timeout = setTimeout(() => child.kill(), 5000);
  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { exitCode, stdout, stderr };
  } finally {
    clearTimeout(timeout);
  }
}

test.each(["local", "remote"])(
  "%s run list combines status, task, source, and limit filters",
  async (mode) => {
    const dbPath = join(tempDir, "runs.sqlite");
    const store = await createStore(mode === "local" ? dbPath : ":memory:");
    const taskId = "task/a ?&=b";
    const source = "producer/a ?&=b";
    const matching = enqueue(store, taskId, source);
    finish(store, matching, "failed");
    finish(store, enqueue(store, "other-task", source), "failed");
    finish(store, enqueue(store, taskId, "other-source"), "failed");
    enqueue(store, taskId, source);

    const connection =
      mode === "local" ? ["--db", dbPath] : ["--url", serveHooka(store)];
    const result = await runCli(
      [
        "list",
        ...connection,
        "--status",
        "failed",
        "--task-id",
        taskId,
        "--source",
        source,
        "--limit",
        "1",
        "--json",
      ],
      { HOOKA_ADMIN_TOKEN: "admin-token" },
    );

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([
      expect.objectContaining({ id: matching.id, taskId, source }),
    ]);
    expect(await Bun.file(join(tempDir, "unused-local.sqlite")).exists()).toBe(
      false,
    );
  },
);

test("remote show encodes run ids and explicit token overrides the environment", async () => {
  const store = await createStore();
  const run = enqueue(store);
  const runId = "release /?&=#☁";
  store.db.query("update runs set id = ? where id = ?").run(runId, run.id);
  store.db
    .query("update run_events set run_id = ? where run_id = ?")
    .run(runId, run.id);

  const result = await runCli(
    ["show", runId, "--url", serveHooka(store), "--token", "admin-token"],
    { HOOKA_ADMIN_TOKEN: "wrong-env-token" },
  );

  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual(store.getRun(runId));
});

test("remote retry uses the API and keeps target execution constraints", async () => {
  const store = await createStore();
  const policy = targetPolicySchema.parse({ allowedProjects: ["main-site"] });
  const original = store.enqueueRun({
    taskId: "deploy.shared-volume.wrangler",
    input: { project: "main-site", sourcePath: "/shared-source/site" },
    source: "wordpress.webhook",
    targetId: "pages-main",
    targetPolicy: policy,
    targetMaxConcurrentRuns: 1,
    maxAttempts: 5,
    capabilitySnapshot: [],
  }).run;
  finish(store, original, "failed");

  const result = await runCli(
    ["retry", original.id, "--url", serveHooka(store)],
    { HOOKA_ADMIN_TOKEN: "admin-token" },
  );

  expect(result.exitCode).toBe(0);
  const response = JSON.parse(result.stdout) as { runId: string };
  expect(response.runId).not.toBe(original.id);
  expect(store.getRun(response.runId)).toMatchObject({
    payload: original.payload,
    source: "api.retry",
    targetId: "pages-main",
    targetMaxConcurrentRuns: 1,
    maxAttempts: 5,
    capabilitySnapshot: ["wrangler"],
  });
  expect(store.claimNextQueuedRun("worker-test", 60_000)?.targetPolicy).toEqual(
    policy,
  );
});

test("remote commands report auth, not-found, and active-retry errors", async () => {
  const store = await createStore();
  const run = enqueue(store);
  const url = serveHooka(store);
  const cases = [
    { args: ["list", "--json"], token: "wrong-token", status: 401 },
    { args: ["show", "missing"], token: "admin-token", status: 404 },
    { args: ["retry", run.id], token: "admin-token", status: 409 },
  ];

  for (const { args, token, status } of cases) {
    const result = await runCli([...args, "--url", url, "--token", token]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain(`HTTP ${status}`);
    expect(result.stdout).toBe("");
  }
  expect(store.listRuns(10)).toHaveLength(1);
  expect(await Bun.file(join(tempDir, "unused-local.sqlite")).exists()).toBe(
    false,
  );
});

test.each(["succeeded", "skipped", "failed", "dead-lettered"] as const)(
  "remote watch polls status transitions and exits correctly for %s",
  async (terminalStatus) => {
    const store = await createStore();
    const run = enqueue(store);
    let requests = 0;
    const url = serve(() => {
      requests += 1;
      const status =
        requests === 1 ? "queued" : requests === 2 ? "running" : terminalStatus;
      return Response.json({ ...run, status });
    });

    const result = await runCli([
      "watch",
      run.id,
      "--url",
      url,
      "--interval",
      "10",
    ]);

    const success =
      terminalStatus === "succeeded" || terminalStatus === "skipped";
    expect(result.exitCode).toBe(success ? 0 : 1);
    expect(result.stdout).toContain(`queued ${run.taskId}`);
    expect(result.stdout).toContain(`running ${run.taskId}`);
    expect(result.stdout).toContain(`${terminalStatus} ${run.taskId}`);
    expect(result.stdout).toContain(`"status": "${terminalStatus}"`);
    expect(requests).toBe(3);
  },
);

test("remote watch stops on rate limiting instead of polling again", async () => {
  let requests = 0;
  const url = serve(() => {
    requests += 1;
    return Response.json(
      { error: "Rate limit exceeded." },
      { status: 429, headers: { "retry-after": "60" } },
    );
  });

  const result = await runCli([
    "watch",
    "run-id",
    "--url",
    url,
    "--interval",
    "10",
  ]);

  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("HTTP 429: Rate limit exceeded.");
  expect(requests).toBe(1);
});

test("a timed-out retry submits only one request and never opens the local DB", async () => {
  let requests = 0;
  const url = serve(() => {
    requests += 1;
    return new Promise<Response>(() => {});
  });
  const result = await runCli([
    "retry",
    "run-id",
    "--url",
    url,
    "--request-timeout",
    "200",
  ]);

  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("request timed out after 200ms");
  expect(requests).toBe(1);
  expect(await Bun.file(join(tempDir, "unused-local.sqlite")).exists()).toBe(
    false,
  );
});

test("a disconnected remote server never falls back to the local database", async () => {
  const url = serve(() => Response.json([]));
  servers[0]?.stop(true);

  const result = await runCli(["list", "--url", url, "--json"]);

  expect(result.exitCode).not.toBe(0);
  expect(result.stdout).toBe("");
  expect(await Bun.file(join(tempDir, "unused-local.sqlite")).exists()).toBe(
    false,
  );
});

test("request timeout also bounds reading a stalled response body", async () => {
  const url = serve(
    () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"runId":'));
          },
        }),
        { headers: { "content-type": "application/json" } },
      ),
  );
  const result = await runCli([
    "show",
    "run-id",
    "--url",
    url,
    "--request-timeout",
    "200",
  ]);

  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("request timed out after 200ms");
});

test.each([
  { body: "<!doctype html><html>Sign in</html>", contentType: "text/html" },
  { body: '{"ok":true}', contentType: "application/json" },
])(
  "remote show rejects an invalid successful API response: $contentType",
  async ({ body, contentType }) => {
    const url = serve(
      () => new Response(body, { headers: { "content-type": contentType } }),
    );

    const result = await runCli(["show", "run-id", "--url", url]);

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(
      contentType === "text/html"
        ? "Hooka API returned invalid JSON"
        : "Hooka API returned an unexpected response",
    );
  },
);

test("remote retry does not follow a redirect to another server", async () => {
  let redirectedRequests = 0;
  const destination = serve(() => {
    redirectedRequests += 1;
    return Response.json({});
  });
  const url = serve(() =>
    Response.redirect(`${destination}/api/runs/run-id/retry`, 307),
  );

  const result = await runCli([
    "retry",
    "run-id",
    "--url",
    url,
    "--token",
    "admin-token",
  ]);

  expect(result.exitCode).not.toBe(0);
  expect(redirectedRequests).toBe(0);
});

test.each([
  { args: ["list", "--status", "unknown"] },
  { args: ["list", "--url", "ftp://hooka.example.com"] },
  { args: ["list", "--token", "admin-token"] },
  { args: ["list", "--request-timeout", "0"] },
])(
  "invalid connection or filter options fail before creating a DB: $args",
  async ({ args }) => {
    const result = await runCli(args);

    expect(result.exitCode).not.toBe(0);
    expect(await Bun.file(join(tempDir, "unused-local.sqlite")).exists()).toBe(
      false,
    );
  },
);
