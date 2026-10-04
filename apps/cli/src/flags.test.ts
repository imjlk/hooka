import { expect, test } from "bun:test";
import { join } from "node:path";
import { createTempDir } from "@hooka/bun-utils";
import { createRunStore } from "@hooka/run-store";
import packageJson from "../../../package.json" with { type: "json" };

const repoRoot = process.cwd();
const cliEntry = join(repoRoot, "apps/cli/src/index.ts");

async function runCli(
  args: string[],
  envOverrides: Record<string, string | undefined> = {},
  cwd = repoRoot,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const child = Bun.spawn([process.execPath, "run", cliEntry, ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...Bun.env,
      ...envOverrides,
    },
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);

  return { exitCode, stdout, stderr };
}

async function writeTargetsFile(tempDir: string): Promise<string> {
  const targetsPath = join(tempDir, "targets.json");
  const scaffold = await runCli([
    "target",
    "scaffold",
    "--template",
    "shared-volume-pages",
  ]);
  await Bun.write(
    targetsPath,
    JSON.stringify({ targets: [JSON.parse(scaffold.stdout)] }),
  );
  return targetsPath;
}

test("target delete --yes=false refuses instead of deleting", async () => {
  const tempDir = await createTempDir("hooka-cli-flags-delete");
  const targetsPath = await writeTargetsFile(tempDir);

  const refused = await runCli([
    "target",
    "delete",
    "cf-pages-default",
    "--targets",
    targetsPath,
    "--yes=false",
  ]);
  expect(refused.exitCode).not.toBe(0);
  expect(
    ((await Bun.file(targetsPath).json()) as { targets: unknown[] }).targets,
  ).toHaveLength(1);

  const deleted = await runCli([
    "target",
    "delete",
    "cf-pages-default",
    "--targets",
    targetsPath,
    "--yes",
  ]);
  expect(deleted.exitCode).toBe(0);
  expect(
    ((await Bun.file(targetsPath).json()) as { targets: unknown[] }).targets,
  ).toHaveLength(0);
});

test("init --force=false keeps an existing .env", async () => {
  const tempDir = await createTempDir("hooka-cli-flags-init");
  const envPath = join(tempDir, ".env");
  await Bun.write(envPath, "HOOKA_ADMIN_TOKEN=keep-me\n");

  const result = await runCli(
    ["init", "--yes", "--force=false", "--preset", "cf-pages"],
    {},
    tempDir,
  );

  expect(result.exitCode).toBe(0);
  expect(await Bun.file(envPath).text()).toBe("HOOKA_ADMIN_TOKEN=keep-me\n");
});

test("boolean task inputs are forwarded when followed by other flags", async () => {
  const result = await runCli([
    "task",
    "run",
    "deploy.shared-volume.wrangler",
    "--project",
    "staging-site",
    "--source-path",
    "/shared-source/site",
    "--no-bundle",
    "--commit-dirty=false",
    "--dry-run",
  ]);

  expect(result.exitCode).toBe(0);
  const run = JSON.parse(result.stdout) as {
    status: string;
    command: string[];
  };
  expect(run.status).toBe("skipped");
  expect(run.command).toContain("--no-bundle");
  expect(run.command).toContain("--commit-dirty=false");
});

test("--dry-run=false runs the task instead of planning it", async () => {
  const result = await runCli([
    "task",
    "run",
    "wordpress.export.verify",
    "--export-dir",
    "/definitely/missing/export",
    "--dry-run=false",
  ]);
  const run = JSON.parse(result.stdout) as { status: string; stderr: string };

  expect(run.status).toBe("failed");
  expect(run.stderr).toContain("Export directory not found");
});

test("cleanup accepts kebab-case retention options", async () => {
  const tempDir = await createTempDir("hooka-cli-flags-cleanup");
  const dbPath = join(tempDir, "hooka.sqlite");
  const runStore = await createRunStore({
    dbPath,
    now: () => new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
  });
  const queued = runStore.enqueueRun({
    taskId: "deploy.shared-volume.wrangler",
    input: {},
    source: "test",
    capabilitySnapshot: [],
  });
  runStore.finishRun(queued.response.runId, {
    taskId: "deploy.shared-volume.wrangler",
    ok: true,
    status: "succeeded",
    durationMs: 1,
  });
  runStore.close();

  const result = await runCli([
    "cleanup",
    "--db",
    dbPath,
    "--run-days",
    "1",
    "--json",
  ]);

  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({ deletedRuns: 1 });
});

test("status reports an unauthorized summary instead of crashing", async () => {
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const { pathname } = new URL(request.url);
      if (pathname === "/api/health" || pathname === "/api/ready") {
        return Response.json({ ok: true, service: "hooka-server" });
      }
      return Response.json(
        { ok: false, error: "unauthorized" },
        { status: 401 },
      );
    },
  });

  try {
    const result = await runCli([
      "status",
      "--url",
      `http://127.0.0.1:${server.port}`,
      "--json",
    ]);

    expect(result.exitCode).toBe(0);
    const report = JSON.parse(result.stdout) as {
      workers: unknown[];
      summary: { ok: boolean; status: number };
    };
    expect(report.workers).toEqual([]);
    expect(report.summary).toMatchObject({ ok: false, status: 401 });
  } finally {
    server.stop(true);
  }
});

test("server-only env mistakes do not break unrelated commands", async () => {
  const result = await runCli(["task", "list", "--json"], {
    HOOKA_TRUST_PROXY: "maybe",
    HOOKA_RATE_LIMIT_API_LIMIT: "lots",
  });

  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: "deploy.shared-volume.wrangler" }),
    ]),
  );
});

test("--version prints the Hooka release version", async () => {
  const result = await runCli(["--version"]);

  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain(packageJson.version);
});

test("validation errors use stderr and leave JSON stdout empty", async () => {
  const result = await runCli(["task", "list", "--jsno"]);
  expect(result.exitCode).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain("Unknown option: --jsno");
});

test("root and nested groups display help without executing tasks", async () => {
  for (const args of [[], ["task"], ["task", "run"]]) {
    const result = await runCli(args);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("COMMANDS:");
    expect(result.stderr).toBe("");
  }
});

test("compatibility task aliases still dispatch through nested commands", async () => {
  const result = await runCli([
    "task",
    "run",
    "wordpress.deploy.simply-static",
    "--project",
    "staging-site",
    "--source-path",
    "/shared-source/site",
    "--no-bundle=false",
    "--dry-run",
  ]);
  expect(result.exitCode).toBe(0);
  const run = JSON.parse(result.stdout) as {
    status: string;
    command: string[];
  };
  expect(run.status).toBe("skipped");
  expect(run.command).not.toContain("--no-bundle");
});
