import { expect, test } from "bun:test";
import { createTempDir, ensureDir, ensureParentDir } from "@hooka/bun-utils";
import { createRunStore } from "@hooka/run-store";
import { join } from "node:path";

const bunBinary = process.execPath;
const repoRoot = process.cwd();
const cliEntry = join(repoRoot, "apps/cli/src/index.ts");

test("image plan exposes the active cf-pages preset contract", async () => {
  const result = await runCli(["image", "plan", "--preset", "cf-pages"]);

  expect(result.exitCode).toBe(0);
  const plan = JSON.parse(result.stdout) as {
    presetId: string;
    tier?: string;
    publicWorkerTag?: string;
    capabilities: string[];
    requiredEnv: Array<{ capabilityId: string; match: string }>;
  };

  expect(plan.presetId).toBe("cf-pages");
  expect(plan.tier).toBe("lean");
  expect(plan.publicWorkerTag).toBe("cf-pages");
  expect(plan.capabilities).toEqual(["wrangler"]);
  expect(plan.requiredEnv).toEqual([
    expect.objectContaining({
      capabilityId: "wrangler",
      match: "allOf",
    }),
  ]);
});

test("image plan exposes the active cf-cache preset contract", async () => {
  const result = await runCli(["image", "plan", "--preset", "cf-cache"]);

  expect(result.exitCode).toBe(0);
  const plan = JSON.parse(result.stdout) as {
    presetId: string;
    tier?: string;
    publicWorkerTag?: string;
    capabilities: string[];
    requiredEnv: Array<{ capabilityId: string; match: string }>;
  };

  expect(plan.presetId).toBe("cf-cache");
  expect(plan.tier).toBe("lean");
  expect(plan.publicWorkerTag).toBe("cf-cache");
  expect(plan.capabilities).toEqual(["cloudflare-api"]);
  expect(plan.requiredEnv).toEqual([
    expect.objectContaining({
      capabilityId: "cloudflare-api",
      match: "allOf",
    }),
  ]);
});

test("doctor reports missing env for installed wrangler capability", async () => {
  const result = await runCli(["doctor", "--json"], {
    HOOKA_INSTALLED_CAPABILITIES: "wrangler",
    CLOUDFLARE_API_TOKEN: "",
    CLOUDFLARE_ACCOUNT_ID: "",
  });

  expect(result.exitCode).toBe(0);

  const report = JSON.parse(result.stdout) as {
    installed: string[];
    missingEnv: Array<{
      capabilityId: string;
      match: string;
      missingNames: string[];
    }>;
  };

  expect(report.installed).toEqual(["wrangler"]);
  expect(report.missingEnv).toEqual([
    expect.objectContaining({
      capabilityId: "wrangler",
      match: "allOf",
      missingNames: ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"],
    }),
  ]);
});

test("install-features records env-only capabilities without a docker installer", async () => {
  const result = await runCli([
    "image",
    "install-features",
    "--features",
    "cloudflare-api",
    "--dry-run",
  ]);

  expect(result.exitCode).toBe(0);

  const manifest = JSON.parse(result.stdout) as {
    installed: string[];
  };

  expect(manifest.installed).toEqual(["cloudflare-api"]);
});

test("doctor honors HOOKA_MANIFEST_PATH for the default manifest lookup", async () => {
  const tempDir = await createTempDir("hooka-cli-manifest");
  const manifestPath = join(tempDir, "custom", "installed-capabilities.json");

  await ensureParentDir(manifestPath);
  await Bun.write(
    manifestPath,
    JSON.stringify({
      image: "hooka:test",
      generatedAt: "2026-03-29T00:00:00.000Z",
      installed: ["cloudflare-api"],
    }),
  );

  const result = await runCli(["doctor", "--json"], {
    HOOKA_MANIFEST_PATH: manifestPath,
    HOOKA_INSTALLED_CAPABILITIES: undefined,
    CLOUDFLARE_API_TOKEN: "",
    CLOUDFLARE_ACCOUNT_ID: "",
  });

  expect(result.exitCode).toBe(0);

  const report = JSON.parse(result.stdout) as {
    installed: string[];
    missingEnv: Array<{ capabilityId: string }>;
  };

  expect(report.installed).toEqual(["cloudflare-api"]);
  expect(report.missingEnv).toEqual([
    expect.objectContaining({
      capabilityId: "cloudflare-api",
    }),
  ]);
});

test("status aggregates health, readiness, summary, and recent runs", async () => {
  const workerSeenAt = new Date(Date.now() - 1_000).toISOString();
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url);

      if (url.pathname === "/api/health") {
        return Response.json({
          ok: true,
          service: "hooka-server",
        });
      }

      if (url.pathname === "/api/ready") {
        return Response.json({
          ok: true,
          service: "hooka-server",
        });
      }

      if (url.pathname === "/api/summary") {
        return Response.json({
          generatedAt: "2026-04-03T00:00:00.000Z",
          counts: {
            tasks: 4,
            capabilities: 3,
            presets: 2,
          },
          installedCapabilities: ["wrangler"],
          workers: [
            {
              workerId: "worker-a",
              runtimeRole: "worker:cf-pages",
              installedCapabilities: ["wrangler"],
              lastSeenAt: workerSeenAt,
              currentRunId: null,
            },
          ],
          tasks: [],
          capabilities: [],
          presets: [],
        });
      }

      if (url.pathname === "/api/runs") {
        return Response.json([
          {
            id: "run_1",
            taskId: "deploy.shared-volume.wrangler",
            source: "webhook",
            sourceEventId: null,
            targetId: null,
            status: "succeeded",
            summary: "done",
            errorText: null,
            attemptCount: 0,
            maxAttempts: 3,
            nextRetryAt: null,
            lastErrorCode: null,
            createdAt: "2026-04-03T00:00:00.000Z",
            queuedAt: "2026-04-03T00:00:00.000Z",
            startedAt: "2026-04-03T00:00:01.000Z",
            finishedAt: "2026-04-03T00:00:02.000Z",
          },
        ]);
      }

      return new Response("not found", {
        status: 404,
      });
    },
  });

  try {
    const result = await runCli([
      "status",
      "--url",
      `http://127.0.0.1:${server.port}`,
      "--token",
      "admin-token",
      "--json",
    ]);

    expect(result.exitCode).toBe(0);

    const report = JSON.parse(result.stdout) as {
      workers: Array<{
        workerId: string;
        freshness: string;
      }>;
      ready: {
        ok: boolean;
      };
      summary: {
        body: {
          installedCapabilities: string[];
          workers: Array<{ workerId: string }>;
        };
      };
      recentRuns: {
        body: Array<{ id: string }>;
      };
    };

    expect(report.ready.ok).toBe(true);
    expect(report.workers[0]?.freshness).toBe("healthy");
    expect(report.summary.body.installedCapabilities).toEqual(["wrangler"]);
    expect(report.summary.body.workers[0]?.workerId).toBe("worker-a");
    expect(report.recentRuns.body[0]?.id).toBe("run_1");
  } finally {
    server.stop(true);
  }
});

test("config reports resolved manifest precedence and installed capabilities", async () => {
  const tempDir = await createTempDir("hooka-cli-config");
  const manifestPath = join(tempDir, "custom", "installed-capabilities.json");

  await ensureParentDir(manifestPath);
  await Bun.write(
    manifestPath,
    JSON.stringify({
      image: "hooka:test",
      generatedAt: "2026-04-03T00:00:00.000Z",
      installed: ["wrangler", "wpcli"],
    }),
  );

  const result = await runCli(
    ["config", "--json"],
    {
      HOOKA_DB_PATH: join(tempDir, "hooka.sqlite"),
      HOOKA_MANIFEST_PATH: manifestPath,
      HOOKA_INSTALLED_CAPABILITIES: undefined,
      HOOKA_WEBHOOK_SECRET: "local-secret",
      HOOKA_ADMIN_TOKEN: "admin-token",
      HOOKA_UI_PORT: "4400",
      HOOKA_UI_API_ORIGIN: "http://127.0.0.1:3300",
    },
    tempDir,
  );

  expect(result.exitCode).toBe(0);

  const report = JSON.parse(result.stdout) as {
    dbPath: string;
    manifestSourceKind: string;
    manifestPath: string;
    installedCapabilities: string[];
    webhookSecretConfigured: boolean;
    adminTokenConfigured: boolean;
    targets: string[];
    targetsPath: string;
    trustProxy: boolean;
    rateLimitWindowMs: number;
    apiRateLimit: number;
    webhookRateLimit: number;
    uiPort: number;
    uiApiOrigin: string;
  };

  expect(report.dbPath).toBe(join(tempDir, "hooka.sqlite"));
  expect(report.manifestSourceKind).toBe("manifest-explicit");
  expect(report.manifestPath).toBe(manifestPath);
  expect(report.installedCapabilities).toEqual(["wrangler", "wpcli"]);
  expect(report.webhookSecretConfigured).toBe(true);
  expect(report.adminTokenConfigured).toBe(true);
  expect(report.targets).toEqual([]);
  expect(report.trustProxy).toBe(false);
  expect(report.rateLimitWindowMs).toBe(60000);
  expect(report.apiRateLimit).toBe(120);
  expect(report.webhookRateLimit).toBe(60);
  expect(report.uiPort).toBe(4400);
  expect(report.uiApiOrigin).toBe("http://127.0.0.1:3300");
});

test("target list and show read the configured targets file", async () => {
  const tempDir = await createTempDir("hooka-cli-targets");
  const targetsPath = join(tempDir, ".hooka", "targets.json");
  await ensureParentDir(targetsPath);
  await Bun.write(
    targetsPath,
    JSON.stringify({
      targets: [
        {
          id: "pages-main",
          title: "Pages Main",
          taskId: "deploy.shared-volume.wrangler",
          source: "target.local",
          maxAttempts: 3,
          defaultInput: {
            kind: "pages-deploy",
          },
          policy: {
            allowedProjects: ["main-site"],
            allowedSourceRoots: ["/shared-source"],
            allowedBranches: ["main"],
            allowedOverrideFields: [],
            requiredEnv: [],
            artifactReadiness: {
              mode: "none",
            },
          },
        },
      ],
    }),
  );

  const listResult = await runCli(
    ["target", "list", "--targets", targetsPath, "--json"],
    {},
    tempDir,
  );
  const showResult = await runCli(
    ["target", "show", "--targets", targetsPath, "pages-main"],
    {},
    tempDir,
  );

  expect(listResult.exitCode).toBe(0);
  expect(showResult.exitCode).toBe(0);
  expect(JSON.parse(listResult.stdout)).toEqual([
    expect.objectContaining({
      id: "pages-main",
    }),
  ]);
  expect(JSON.parse(showResult.stdout)).toMatchObject({
    id: "pages-main",
  });
});

test("target scaffold emits built-in template JSON with overrides", async () => {
  const result = await runCli([
    "target",
    "scaffold",
    "--template",
    "shared-volume-pages",
    "--id",
    "pages-preview",
    "--title",
    "Pages Preview",
    "--source",
    "target.preview",
  ]);

  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({
    id: "pages-preview",
    title: "Pages Preview",
    source: "target.preview",
    taskId: "deploy.shared-volume.wrangler",
    presetId: "cf-pages",
  });
});

test("target create, update, and delete mutate the configured targets file", async () => {
  const tempDir = await createTempDir("hooka-cli-target-crud");
  const targetsPath = join(tempDir, ".hooka", "targets.json");
  const createPayloadPath = join(tempDir, "target-create.json");
  const updatePayloadPath = join(tempDir, "target-update.json");

  await ensureParentDir(createPayloadPath);
  await Bun.write(
    createPayloadPath,
    JSON.stringify({
      id: "pages-main",
      title: "Pages Main",
      taskId: "deploy.shared-volume.wrangler",
      source: "target.cloudflare-pages",
      maxAttempts: 3,
      defaultInput: {
        kind: "pages-deploy",
      },
      policy: {
        allowedProjects: ["main-site"],
        allowedSourceRoots: ["/shared-source"],
        allowedBranches: ["main"],
        allowedOverrideFields: [],
        requiredEnv: [],
        artifactReadiness: {
          mode: "none",
        },
      },
    }),
  );
  await Bun.write(
    updatePayloadPath,
    JSON.stringify({
      id: "pages-main",
      title: "Pages Main",
      taskId: "deploy.shared-volume.wrangler",
      source: "target.cloudflare-pages",
      maxAttempts: 4,
      defaultInput: {
        kind: "pages-deploy",
        branch: "main",
      },
      policy: {
        allowedProjects: ["main-site"],
        allowedSourceRoots: ["/shared-source"],
        allowedBranches: ["main"],
        allowedOverrideFields: ["branch"],
        requiredEnv: [],
        artifactReadiness: {
          mode: "none",
        },
      },
    }),
  );

  const createResult = await runCli(
    ["target", "create", "--targets", targetsPath, "--file", createPayloadPath],
    {},
    tempDir,
  );
  const updateResult = await runCli(
    [
      "target",
      "update",
      "--targets",
      targetsPath,
      "--file",
      updatePayloadPath,
      "pages-main",
    ],
    {},
    tempDir,
  );
  const deleteResult = await runCli(
    ["target", "delete", "--targets", targetsPath, "pages-main", "--yes"],
    {},
    tempDir,
  );

  expect(createResult.exitCode).toBe(0);
  expect(updateResult.exitCode).toBe(0);
  expect(deleteResult.exitCode).toBe(0);
  expect(JSON.parse(updateResult.stdout)).toMatchObject({
    id: "pages-main",
    maxAttempts: 4,
  });
  expect(JSON.parse(deleteResult.stdout)).toEqual({
    ok: true,
    targetId: "pages-main",
  });
  expect(await Bun.file(targetsPath).json()).toEqual({
    targets: [],
  });
});

test("init scaffolds .env, manifest, and shared source for the selected preset", async () => {
  const tempDir = await createTempDir("hooka-cli-init");

  const result = await runCli(
    ["init", "--yes", "--preset", "cf-pages"],
    {},
    tempDir,
  );

  expect(result.exitCode).toBe(0);
  expect(await Bun.file(join(tempDir, ".env")).text()).toContain(
    "HOOKA_INSTALLED_CAPABILITIES=wrangler",
  );

  const manifest = (await Bun.file(
    join(tempDir, ".hooka/installed-capabilities.json"),
  ).json()) as {
    installed: string[];
  };
  expect(manifest.installed).toEqual(["wrangler"]);
  const targets = (await Bun.file(
    join(tempDir, ".hooka/targets.json"),
  ).json()) as {
    targets: Array<{ id: string }>;
  };
  expect(targets.targets[0]?.id).toBe("cf-pages-default");
  expect(
    await directoryExists(join(tempDir, ".hooka/shared-source/simply-static")),
  ).toBe(true);
});

test("audit list fetches and filters remote audit events", async () => {
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url);

      if (url.pathname === "/api/audit-events") {
        expect(request.headers.get("authorization")).toBe("Bearer admin-token");
        expect(url.searchParams.get("category")).toBe("security");
        expect(url.searchParams.get("outcome")).toBe("rejected");
        expect(url.searchParams.get("limit")).toBe("5");

        return Response.json([
          {
            sequence: 4,
            createdAt: "2026-04-04T00:00:00.000Z",
            category: "security",
            action: "admin_auth_rejected",
            outcome: "rejected",
            subjectType: "request",
            subjectId: null,
            clientIp: "203.0.113.10",
            requestPath: "/api/summary",
            message: "Missing or invalid admin token.",
            context: {
              retryAfterSeconds: 60,
            },
          },
        ]);
      }

      return new Response("not found", {
        status: 404,
      });
    },
  });

  try {
    const result = await runCli([
      "audit",
      "list",
      "--url",
      `http://127.0.0.1:${server.port}`,
      "--token",
      "admin-token",
      "--category",
      "security",
      "--outcome",
      "rejected",
      "--limit",
      "5",
      "--json",
    ]);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([
      expect.objectContaining({
        action: "admin_auth_rejected",
        category: "security",
      }),
    ]);
  } finally {
    server.stop(true);
  }
});

test("run retry re-enqueues a completed run with cli.retry as the source", async () => {
  const tempDir = await createTempDir("hooka-cli-retry");
  const dbPath = join(tempDir, "hooka.sqlite");
  const runStore = await createRunStore({
    dbPath,
  });
  const queued = runStore.enqueueRun({
    taskId: "deploy.shared-volume.wrangler",
    input: {
      kind: "pages-deploy",
      project: "retry-site",
      sourcePath: "/shared-source/retry",
    },
    source: "webhook",
    capabilitySnapshot: ["wrangler"],
  });

  runStore.finishRun(queued.response.runId, {
    taskId: "deploy.shared-volume.wrangler",
    ok: false,
    status: "failed",
    summary: "boom",
    durationMs: 1,
  });
  runStore.close();

  const result = await runCli(
    ["run", "retry", "--db", dbPath, queued.response.runId],
    {},
    tempDir,
  );

  expect(result.exitCode).toBe(0);

  const verifyStore = await createRunStore({
    dbPath,
  });
  const runs = verifyStore.listRuns(5);

  expect(runs).toHaveLength(2);
  expect(runs[0]?.source).toBe("cli.retry");
  expect(runs[0]?.taskId).toBe("deploy.shared-volume.wrangler");
  verifyStore.close();
});

test("run watch streams until a run reaches a terminal state", async () => {
  const tempDir = await createTempDir("hooka-cli-watch");
  const dbPath = join(tempDir, "hooka.sqlite");
  const runStore = await createRunStore({
    dbPath,
  });
  const queued = runStore.enqueueRun({
    taskId: "deploy.shared-volume.wrangler",
    input: {
      kind: "pages-deploy",
      project: "watch-site",
      sourcePath: "/shared-source/watch",
    },
    source: "webhook",
    capabilitySnapshot: ["wrangler"],
  });

  setTimeout(async () => {
    const nestedStore = await createRunStore({
      dbPath,
    });
    nestedStore.finishRun(
      queued.response.runId,
      {
        taskId: "deploy.shared-volume.wrangler",
        ok: true,
        status: "succeeded",
        retryable: false,
        summary: "done",
        durationMs: 1,
      },
      {
        attemptCount: 1,
      },
    );
    nestedStore.close();
  }, 50);
  runStore.close();

  const result = await runCli(
    ["run", "watch", "--db", dbPath, "--interval", "20", queued.response.runId],
    {},
    tempDir,
  );

  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("succeeded");
  expect(result.stdout).toContain(queued.response.runId);
});

test("task discovery still works when the CLI is launched from a repo subdirectory", async () => {
  const tempDir = await createTempDir("hooka-cli-subdir");
  const nestedDir = join(tempDir, "nested", "workspace");
  await ensureDir(nestedDir);

  const result = await runCli(["task", "list", "--json"], {}, nestedDir);

  expect(result.exitCode).toBe(0);

  const tasks = JSON.parse(result.stdout) as Array<{ id: string }>;
  expect(
    tasks.some((task) => task.id === "deploy.shared-volume.wrangler"),
  ).toBe(true);
});

async function runCli(
  args: string[],
  envOverrides: Record<string, string | undefined> = {},
  cwd = repoRoot,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const processResult = Bun.spawn([bunBinary, "run", cliEntry, ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...Bun.env,
      ...envOverrides,
    },
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    processResult.exited,
    new Response(processResult.stdout).text(),
    new Response(processResult.stderr).text(),
  ]);

  return {
    exitCode,
    stdout,
    stderr,
  };
}

async function directoryExists(path: string): Promise<boolean> {
  const result = await Bun.$`test -d ${path}`.quiet().nothrow();
  return result.exitCode === 0;
}
