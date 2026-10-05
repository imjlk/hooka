import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, mkdir, rm, symlink, link } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTask } from "@hooka/runner-core";
import { getTask, getPresetPlan, validateRegistry } from "@hooka/registry";
import { createRunStore } from "@hooka/run-store";
import { processNextRun } from "../../../apps/worker/src/lib/worker";
import { configSchema, DAY, requestSchema } from "./contracts";
import { digest } from "./engine";
import { RecommendationStore } from "./store";
import { readPublishedDecision } from "./files";
import {
  recommendationTaskPack,
  runRecommendationTask,
  ingestTaskInput,
} from "./tasks";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "hooka-recommendation-tasks-"));
  const inbox = join(root, "inbox"),
    outbox = join(root, "outbox"),
    db = join(root, "model.sqlite"),
    configPath = join(root, "config.json");
  for (const path of [
    outbox,
    join(inbox, "cats", "manifest"),
    join(inbox, "cats", "aggregate"),
    join(inbox, "cats", "request"),
  ])
    await mkdir(path, { recursive: true });
  const config = configSchema.parse({
    schemaVersion: 1,
    entities: [],
    policies: [{ policyId: "ctr", version: 1 }],
    apps: [
      {
        appId: "cats",
        appRevision: 1,
        producerId: "cats-backend",
        contexts: [{ contextId: "low", measurementProfileId: "visible" }],
        subjects: [{ subjectId: "mug", ruleRevision: 1 }],
      },
    ],
  });
  await Bun.write(configPath, JSON.stringify(config));
  const env = {
    HOOKA_RECOMMENDATIONS_TASKS_ENABLED: "true",
    HOOKA_RECOMMENDATIONS_CONFIG_PATH: configPath,
    HOOKA_RECOMMENDATIONS_DB_PATH: db,
    HOOKA_RECOMMENDATIONS_INBOX_PATH: inbox,
    HOOKA_RECOMMENDATIONS_RESULTS_PATH: outbox,
  };
  const start = Math.floor(Date.now() / DAY) * DAY - 5 * DAY;
  const request = (now: number, requestId: string) =>
    requestSchema.parse({
      schemaVersion: 1,
      requestId,
      appId: "cats",
      appRevision: 1,
      policyId: "ctr",
      policyVersion: 1,
      contextId: "low",
      measurementProfileId: "visible",
      kind: "subject",
      generatedAt: now,
      expiresAt: now + DAY,
      seed: "known",
      candidates: [{ subjectId: "mug", ruleRevision: 1 }],
    });
  const store = await RecommendationStore.open(db);
  store.build(config, start);
  const result = store.recordDecision(config, request(start, "old"), start);
  store.close();
  const manifest = {
    schemaVersion: 1,
    manifestId: "day-1",
    producerId: "cats-backend",
    appId: "cats",
    appRevision: 1,
    generatedAt: start,
    assignments: [
      {
        assignmentId: "assignment-1",
        decisionId: result.decisionId,
        subjectId: "mug",
        ruleRevision: 1,
        mappingVersion: 1,
        contextId: "low",
        measurementProfileId: "visible",
        startsAt: start,
        endsAt: start + DAY,
        experiment: "training",
        application: "constrained",
        appliedProbability: null,
      },
    ],
  };
  const aggregate = {
    schemaVersion: 1,
    producerId: "cats-backend",
    appId: "cats",
    measurementProfileId: "visible",
    periodStart: start,
    periodEnd: start + DAY,
    revision: 1,
    generatedAt: start + DAY,
    rows: [
      {
        assignmentId: "assignment-1",
        exposures: 100,
        clicks: 20,
        dispatches: 5,
      },
    ],
  };
  async function artifact(
    kind: string,
    value: unknown,
    artifactId = "batch-1",
  ) {
    await Bun.write(
      join(inbox, "cats", kind, `${artifactId}.json`),
      JSON.stringify(value),
    );
    return {
      configDigest: digest(config),
      appId: "cats",
      artifactId,
      artifactDigest: digest(value),
    };
  }
  async function run(
    operation: string,
    input: unknown = {},
    options: {
      dryRun?: boolean;
      env?: Record<string, string | undefined>;
    } = {},
  ) {
    const task = getTask(`recommendations.${operation}`);
    if (!task) throw new Error("Missing task");
    return runTask(task, input, {
      installedCapabilities: ["recommendations"],
      env: options.env ?? env,
      dryRun: options.dryRun,
    });
  }
  return {
    root,
    inbox,
    outbox,
    db,
    configPath,
    config,
    env,
    start,
    request,
    manifest,
    aggregate,
    artifact,
    run,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

function data(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") throw new Error("Missing result");
  return value as Record<string, unknown>;
}

test("recommendation tasks are registered in the existing Sharelink preset without required optional env", () => {
  expect(validateRegistry()).toEqual({ ok: true, errors: [] });
  const plan = getPresetPlan("toss-sharelink");
  expect(plan?.capabilities).toEqual(["toss-sharelink", "recommendations"]);
  expect(plan?.missingCapabilitiesByTask).toEqual({});
  for (const task of recommendationTaskPack.tasks)
    expect(plan?.coveredTasks).toContain(task.id);
  expect(
    plan?.requiredEnv.every(
      (entry) => entry.capabilityId !== "recommendations",
    ),
  ).toBe(true);
  expect(
    ingestTaskInput.safeParse({
      configDigest: "a".repeat(64),
      appId: "cats",
      artifactId: "../../queue",
      artifactDigest: "b".repeat(64),
      kind: "aggregate",
    }).success,
  ).toBe(false);
});

test("queued pipeline ingests idempotently, builds sealed evidence, previews, publishes and prunes", async () => {
  const f = await fixture();
  try {
    const manifestInput = {
      ...(await f.artifact("manifest", f.manifest)),
      kind: "manifest",
    };
    const aggregateInput = {
      ...(await f.artifact("aggregate", f.aggregate)),
      kind: "aggregate",
    };
    expect(
      data((await f.run("validate", { configDigest: digest(f.config) })).data)[
        "apps"
      ],
    ).toBe(1);
    expect(data((await f.run("ingest", manifestInput)).data)["status"]).toBe(
      "applied",
    );
    expect(data((await f.run("ingest", manifestInput)).data)["status"]).toBe(
      "duplicate",
    );
    expect(data((await f.run("ingest", aggregateInput)).data)["status"]).toBe(
      "applied",
    );
    expect(data((await f.run("ingest", aggregateInput)).data)["status"]).toBe(
      "duplicate",
    );
    const build = await f.run("build", { configDigest: digest(f.config) });
    expect(build.ok).toBe(true);
    expect(data(build.data)["rows"]).toBe(1);
    const request = f.request(Date.now(), "today"),
      input = {
        ...(await f.artifact("request", request)),
        modelGenerationId: data(build.data)["modelGenerationId"],
      };
    const before = await f.run("status");
    expect((await f.run("plan", input)).ok).toBe(true);
    expect(data((await f.run("status")).data)["counts"]).toEqual(
      data(before.data)["counts"],
    );
    expect((await f.run("export", input, { dryRun: true }))["status"]).toBe(
      "skipped",
    );
    expect(await readPublishedDecision(f.outbox, request)).toBeNull();
    const published = await f.run("export", input);
    expect(published.ok).toBe(true);
    expect((await f.run("export", input)).data).toEqual(published.data);
    expect((await readPublishedDecision(f.outbox, request))?.appId).toBe(
      "cats",
    );
    const observer = await RecommendationStore.open(f.db, true);
    expect(observer["status"]()["counts"]["rec_decisions"]).toBe(2);
    observer.close();
    expect((await f.run("prune")).ok).toBe(true);
  } finally {
    await f.cleanup();
  }
});

test("disabled tasks and dry runs do not initialize stores or mutate evidence", async () => {
  const f = await fixture();
  try {
    const input = {
      ...(await f.artifact("manifest", f.manifest)),
      kind: "manifest",
    };
    const disabled = { ...f.env, HOOKA_RECOMMENDATIONS_TASKS_ENABLED: "false" };
    expect((await f.run("ingest", input, { env: disabled })).errorCode).toBe(
      "recommendations_tasks_disabled",
    );
    expect(
      (await f.run("ingest", input, { dryRun: true, env: disabled }))["status"],
    ).toBe("skipped");
    expect(
      data(data((await f.run("status")).data)["counts"])["rec_assignments"],
    ).toBe(0);
    const missing = join(f.root, "missing.sqlite");
    expect(
      (
        await f.run(
          "build",
          { configDigest: digest(f.config) },
          { env: { ...f.env, HOOKA_RECOMMENDATIONS_DB_PATH: missing } },
        )
      ).retryable,
    ).toBe(false);
    expect(await Bun.file(missing).exists()).toBe(false);
    const blank = join(f.root, "blank.sqlite"),
      raw = new Database(blank);
    raw.close();
    expect(
      (
        await f.run(
          "prune",
          {},
          { env: { ...f.env, HOOKA_RECOMMENDATIONS_DB_PATH: blank } },
        )
      ).ok,
    ).toBe(false);
    const check = new Database(blank, { readonly: true });
    expect(check.query("PRAGMA application_id").get()).toEqual({
      application_id: 0,
    });
    check.close();
  } finally {
    await f.cleanup();
  }
});

test("changed hashes, cross-app producers and invalid batches are terminal and sanitized", async () => {
  const f = await fixture();
  try {
    const input = {
      ...(await f.artifact("manifest", f.manifest)),
      kind: "manifest",
    };
    expect(
      (await f.run("ingest", { ...input, configDigest: "a".repeat(64) }))
        .errorCode,
    ).toBe("recommendations_config_changed");
    await Bun.write(
      join(f.inbox, "cats", "manifest", "batch-1.json"),
      JSON.stringify({ ...f.manifest, producerId: "secret-wrong-backend" }),
    );
    expect((await f.run("ingest", input)).errorCode).toBe(
      "recommendations_artifact_changed",
    );
    const wrong = {
      ...(await f.artifact("manifest", { ...f.manifest, appId: "other" })),
      kind: "manifest",
    };
    expect((await f.run("ingest", wrong)).errorCode).toBe(
      "recommendations_app_mismatch",
    );
    const invalid = {
      ...(await f.artifact("aggregate", {
        ...f.aggregate,
        rows: [
          {
            assignmentId: "secret-assignment",
            exposures: 1,
            clicks: 2,
            dispatches: 0,
          },
        ],
      })),
      kind: "aggregate",
    };
    const rejected = await f.run("ingest", invalid);
    expect(rejected.retryable).toBe(false);
    expect(JSON.stringify(rejected)).not.toContain("secret-assignment");
    expect(
      data(data((await f.run("status")).data)["counts"])["rec_assignments"],
    ).toBe(0);
  } finally {
    await f.cleanup();
  }
});

test("database aliases, public roots and symlinked app files/outboxes are rejected", async () => {
  const f = await fixture();
  try {
    const configInput = { configDigest: digest(f.config) };
    const alias = join(f.root, "queue-alias.sqlite");
    await link(f.db, alias);
    expect(
      (
        await f.run("build", configInput, {
          env: { ...f.env, HOOKA_DB_PATH: alias },
        })
      ).errorCode,
    ).toBe("recommendations_paths_invalid");
    expect(
      (
        await f.run("build", configInput, {
          env: { ...f.env, HOOKA_SHARELINK_RESULTS_PATH: f.root },
        })
      ).errorCode,
    ).toBe("recommendations_paths_invalid");
    const foreign = join(f.root, "foreign.sqlite"),
      db = new Database(foreign);
    db.exec("CREATE TABLE secrets(value TEXT)");
    db.close();
    expect(
      (
        await f.run(
          "prune",
          {},
          { env: { ...f.env, HOOKA_RECOMMENDATIONS_DB_PATH: foreign } },
        )
      ).ok,
    ).toBe(false);
    await symlink(f.configPath, join(f.inbox, "cats", "manifest", "link.json"));
    expect(
      (
        await f.run("ingest", {
          configDigest: digest(f.config),
          appId: "cats",
          artifactId: "link",
          artifactDigest: digest(f.config),
          kind: "manifest",
        })
      ).errorCode,
    ).toBe("recommendations_paths_invalid");
    const build = await f.run("build", configInput),
      request = f.request(Date.now(), "today");
    const input = {
      ...(await f.artifact("request", request)),
      modelGenerationId: data(build.data)["modelGenerationId"],
    };
    await symlink(f.root, join(f.outbox, "cats"));
    expect((await f.run("export", input)).errorCode).toBe(
      "recommendations_paths_invalid",
    );
    expect(
      await Bun.file(
        join(f.root, "requests", "today", "recommendations.json"),
      ).exists(),
    ).toBe(false);
  } finally {
    await f.cleanup();
  }
});

test("pinned model rejects stale exports without recording a new decision or publication", async () => {
  const f = await fixture();
  try {
    const build = await f.run("build", { configDigest: digest(f.config) }),
      request = f.request(Date.now(), "today");
    const input = {
      ...(await f.artifact("request", request)),
      modelGenerationId: "foreign-model",
    };
    expect((await f.run("plan", input)).errorCode).toBe(
      "recommendations_model_changed",
    );
    expect((await f.run("export", input)).ok).toBe(false);
    expect(await readPublishedDecision(f.outbox, request)).toBeNull();
    expect(
      data(data((await f.run("status")).data)["counts"])["rec_decisions"],
    ).toBe(1);
    expect(data(build.data)["modelGenerationId"]).not.toBe("foreign-model");
  } finally {
    await f.cleanup();
  }
});

test("the existing worker settles a disabled recommendation job as terminal and capability gates its claim", async () => {
  const store = await createRunStore({ dbPath: ":memory:" });
  const previous = Bun.env["HOOKA_RECOMMENDATIONS_TASKS_ENABLED"];
  Bun.env["HOOKA_RECOMMENDATIONS_TASKS_ENABLED"] = "false";
  try {
    const queued = store.enqueueRun({
      taskId: "recommendations.prune",
      input: {},
      source: "test",
      capabilitySnapshot: ["recommendations"],
    });
    const options = {
      installedCapabilities: ["toss-sharelink"],
      manifestPath: "/tmp/unused-manifest",
      runtimeRole: "worker:test",
      runStore: store,
      workerId: "worker-test",
      leaseMs: 60_000,
      retryBaseDelayMs: 1,
    };
    expect(await processNextRun(options)).toBe(false);
    expect(
      await processNextRun({
        ...options,
        installedCapabilities: ["toss-sharelink", "recommendations"],
      }),
    ).toBe(true);
    expect(store.getRun(queued.response.runId)?.["status"]).toBe("failed");
    expect(store.getRun(queued.response.runId)?.result?.errorCode).toBe(
      "recommendations_tasks_disabled",
    );
  } finally {
    if (previous === undefined)
      delete Bun.env["HOOKA_RECOMMENDATIONS_TASKS_ENABLED"];
    else Bun.env["HOOKA_RECOMMENDATIONS_TASKS_ENABLED"] = previous;
    store.close();
  }
});

test("invalid direct executor input is terminal rather than interpreting payload paths", async () => {
  await expect(
    runRecommendationTask("prune", { domain: "/secret" }, {}, true),
  ).rejects.toMatchObject({ retryable: false });
});

test("busy SQLite writes are retryable without advancing the current model", async () => {
  const f = await fixture();
  const lock = new Database(f.db);
  try {
    const before = await f.run("status");
    lock.exec("BEGIN IMMEDIATE");
    const result = await f.run("build", { configDigest: digest(f.config) });
    expect(result.retryable).toBe(true);
    expect(result.errorCode).toBe("recommendations_storage_busy");
    lock.exec("ROLLBACK");
    expect(data((await f.run("status")).data)["currentModel"]).toBe(
      data(before.data)["currentModel"],
    );
  } finally {
    if (lock.inTransaction) lock.exec("ROLLBACK");
    lock.close();
    await f.cleanup();
  }
}, 10000);

test("enabled existing worker runs digest-bound validation and persists only the summary", async () => {
  const f = await fixture();
  const runStore = await createRunStore({ dbPath: ":memory:" });
  const saved = new Map(Object.keys(f.env).map((key) => [key, Bun.env[key]]));
  for (const [key, value] of Object.entries(f.env)) Bun.env[key] = value;
  try {
    const queued = runStore.enqueueRun({
      taskId: "recommendations.validate",
      input: { configDigest: digest(f.config) },
      source: "test",
      capabilitySnapshot: ["recommendations"],
    });
    expect(
      await processNextRun({
        installedCapabilities: ["toss-sharelink", "recommendations"],
        manifestPath: "/tmp/unused",
        runtimeRole: "worker:test",
        runStore,
        workerId: "recommendation-owner",
        leaseMs: 60_000,
        retryBaseDelayMs: 1000,
      }),
    ).toBe(true);
    const result = runStore.getRun(queued.response.runId);
    expect(result?.status).toBe("succeeded");
    expect(data(result?.result?.data)["apps"]).toBe(1);
    expect(JSON.stringify(result?.result)).not.toContain("cats-backend");
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete Bun.env[key];
      else Bun.env[key] = value;
    }
    runStore.close();
    await f.cleanup();
  }
});

test("preset task CLI accepts explicit scalar flags for offline validation", async () => {
  const f = await fixture();
  try {
    const child = Bun.spawn(
      [
        process.execPath,
        "apps/cli/src/index.ts",
        "task",
        "run",
        "recommendations.validate",
        "--config-digest",
        digest(f.config),
        "--dry-run",
      ],
      { cwd: process.cwd(), env: f.env, stdout: "pipe", stderr: "pipe" },
    );
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(exitCode, stderr).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({
      status: "skipped",
      data: { apps: 1, dryRun: true },
    });
  } finally {
    await f.cleanup();
  }
});
