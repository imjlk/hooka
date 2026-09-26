import { expect, test } from "bun:test";
import {
  buildRunQuery,
  createCoalescedTask,
  createTargetScaffold,
  describeTargetEditorValidation,
  describeWorkerHealth,
  deriveRunFilterOptions,
  formatCapabilityEnvRows,
  isHeartbeatOnlyUpdate,
  parseEventStreamUpdate,
  parseTargetEditorValue,
  readAuditSequence,
  resolveTargetEditorSync,
  selectActiveRunId,
  selectPreset,
  selectTarget,
  serializeTargetEditorValue,
  summarizeAuditContext,
  type Capability,
  type PresetWithPlan,
  type RunSummary,
  type Summary,
  type Target,
} from "./helpers";

test("buildRunQuery includes only active filters", () => {
  expect(
    buildRunQuery({
      limit: 8,
      status: "failed",
      taskId: "deploy.shared-volume.wrangler",
    }),
  ).toBe("?limit=8&status=failed&taskId=deploy.shared-volume.wrangler");
});

test("selectActiveRunId keeps current run when present and falls back to first", () => {
  const runs: RunSummary[] = [
    {
      id: "run-1",
      taskId: "task-1",
      targetId: null,
      source: "webhook",
      status: "queued",
      summary: null,
      createdAt: "2026-03-29T00:00:00.000Z",
      attemptCount: 0,
      maxAttempts: 3,
      nextRetryAt: null,
      lastErrorCode: null,
    },
    {
      id: "run-2",
      taskId: "task-2",
      targetId: null,
      source: "cli",
      status: "failed",
      summary: null,
      createdAt: "2026-03-29T00:00:01.000Z",
      attemptCount: 1,
      maxAttempts: 3,
      nextRetryAt: null,
      lastErrorCode: "failed",
    },
  ];

  expect(selectActiveRunId(runs, "run-2")).toBe("run-2");
  expect(selectActiveRunId(runs, "missing")).toBe("run-1");
  expect(selectActiveRunId([], "run-2")).toBe(null);
});

test("deriveRunFilterOptions builds stable task and source option lists", () => {
  const summary: Summary = {
    generatedAt: "2026-03-29T00:00:00.000Z",
    counts: {
      tasks: 2,
      capabilities: 1,
      presets: 1,
    },
    installedCapabilities: [],
    workers: [],
    tasks: [
      {
        id: "task-b",
        title: "Task B",
        requires: [],
        available: true,
      },
      {
        id: "task-a",
        title: "Task A",
        requires: [],
        available: true,
      },
    ],
    presets: [],
  };
  const runs: RunSummary[] = [
    {
      id: "run-1",
      taskId: "task-a",
      targetId: null,
      source: "wordpress.webhook",
      status: "queued",
      summary: null,
      createdAt: "2026-03-29T00:00:00.000Z",
      attemptCount: 0,
      maxAttempts: 3,
      nextRetryAt: null,
      lastErrorCode: null,
    },
    {
      id: "run-2",
      taskId: "task-b",
      targetId: null,
      source: "cli",
      status: "failed",
      summary: null,
      createdAt: "2026-03-29T00:00:01.000Z",
      attemptCount: 1,
      maxAttempts: 3,
      nextRetryAt: null,
      lastErrorCode: "failed",
    },
  ];

  expect(deriveRunFilterOptions(summary, runs)).toEqual({
    taskIds: ["task-a", "task-b"],
    sources: ["cli", "wordpress.webhook"],
  });
});

test("formatCapabilityEnvRows surfaces installed capability env contracts", () => {
  const capabilities: Capability[] = [
    {
      id: "wrangler",
      title: "Wrangler",
      description: "Deploys Pages.",
      binaries: ["wrangler"],
      requiredEnv: [
        {
          match: "allOf",
          names: ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"],
          description: "Cloudflare auth",
          secret: true,
        },
      ],
    },
    {
      id: "wpcli",
      title: "WP-CLI",
      description: "WordPress ops",
      binaries: ["wp"],
    },
  ];

  expect(formatCapabilityEnvRows(capabilities, ["wrangler"])).toEqual([
    {
      capabilityId: "wrangler",
      description: "Cloudflare auth",
      mode: "all",
      names: ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"],
      secret: true,
    },
  ]);
});

test("selectPreset falls back to the first preset when current is invalid", () => {
  const presets: PresetWithPlan[] = [
    {
      id: "cf-pages",
      title: "Cloudflare Pages",
      description: "Deploy preset",
      imageTag: "cf-pages",
      capabilities: ["wrangler"],
    },
    {
      id: "wp-wrangler",
      title: "WordPress Wrangler",
      description: "Combo preset",
      imageTag: "wp-wrangler",
      capabilities: ["wrangler", "wpcli"],
    },
  ];

  expect(selectPreset(presets, "wp-wrangler")?.id).toBe("wp-wrangler");
  expect(selectPreset(presets, "missing")?.id).toBe("cf-pages");
  expect(selectPreset([], "missing")).toBe(null);
});

test("selectTarget falls back to the first target when current is invalid", () => {
  const targets: Target[] = [
    {
      id: "pages-main",
      title: "Pages Main",
      taskId: "deploy.shared-volume.wrangler",
      source: "target",
      maxAttempts: 3,
      defaultInput: {},
      policy: {
        allowedProjects: [],
        allowedSourceRoots: [],
        allowedDestinationPrefixes: [],
        allowedBranches: [],
        allowedOverrideFields: [],
        artifactReadiness: { mode: "none" },
      },
    },
    {
      id: "pages-preview",
      title: "Pages Preview",
      taskId: "deploy.shared-volume.wrangler",
      source: "target",
      maxAttempts: 2,
      defaultInput: {},
      policy: {
        allowedProjects: [],
        allowedSourceRoots: [],
        allowedDestinationPrefixes: [],
        allowedBranches: [],
        allowedOverrideFields: [],
        artifactReadiness: { mode: "none" },
      },
    },
  ];

  expect(selectTarget(targets, "pages-preview")?.id).toBe("pages-preview");
  expect(selectTarget(targets, "missing")?.id).toBe("pages-main");
  expect(selectTarget([], "missing")).toBe(null);
});

test("target editor helpers scaffold, serialize, and validate target JSON", () => {
  const scaffold = createTargetScaffold("shared-volume-pages");
  const serialized = serializeTargetEditorValue(scaffold);
  const parsed = parseTargetEditorValue(serialized);
  const validation = describeTargetEditorValidation(serialized);

  expect(scaffold.id).toBe("cf-pages-default");
  expect(serialized).toContain('"presetId": "cf-pages"');
  expect(parsed).toEqual({
    ok: true,
    target: expect.objectContaining({
      id: "cf-pages-default",
      taskId: "deploy.shared-volume.wrangler",
    }),
  });
  expect(validation).toEqual({
    ok: true,
    message: "Valid target cf-pages-default for deploy.shared-volume.wrangler.",
  });
  expect(parseTargetEditorValue("{")).toEqual({
    ok: false,
    error: expect.any(String),
  });
});

test("worker and audit helpers summarize freshness and context", () => {
  const workerHealth = describeWorkerHealth(
    {
      workerId: "worker-a",
      runtimeRole: "worker:cf-pages",
      installedCapabilities: ["wrangler"],
      lastSeenAt: new Date(Date.now() - 1_000).toISOString(),
      currentRunId: null,
    },
    5_000,
  );

  expect(workerHealth.freshness).toBe("healthy");
  expect(workerHealth.lastSeenLabel).toContain("ago");
  expect(
    summarizeAuditContext({
      event: "target_created",
      targetId: "pages-main",
    }),
  ).toContain("target_created");
});

test("live updates keep a draft scaffold unbound from existing targets", () => {
  const existing = createTargetScaffold("shared-volume-pages");

  // The draft scaffold shares the id `cf-pages-default` with the existing
  // target. Rebinding it would turn Save into a PUT over that target.
  expect(
    resolveTargetEditorSync([existing], {
      activeTargetId: null,
      creating: true,
      dirty: false,
    }),
  ).toEqual({
    activeTargetId: null,
    target: null,
    refillEditor: false,
  });
});

test("live updates keep unsaved edits until the operator picks a target", () => {
  const first = createTargetScaffold("shared-volume-pages");
  const second = createTargetScaffold("cache-purge-urls");
  const editing = {
    activeTargetId: second.id,
    creating: false,
    dirty: true,
  };

  expect(resolveTargetEditorSync([first, second], editing)).toMatchObject({
    activeTargetId: second.id,
    refillEditor: false,
  });
  expect(
    resolveTargetEditorSync([first, second], editing, { explicit: true }),
  ).toMatchObject({
    activeTargetId: second.id,
    refillEditor: true,
  });
  // The edited target was deleted elsewhere: fall back and refill.
  expect(resolveTargetEditorSync([first], editing)).toMatchObject({
    activeTargetId: first.id,
    refillEditor: true,
  });
  expect(
    resolveTargetEditorSync([first, second], { ...editing, dirty: false }),
  ).toMatchObject({
    refillEditor: true,
  });
});

test("createCoalescedTask runs bursts once and never overlaps", async () => {
  let runs = 0;
  let active = 0;
  let maxActive = 0;
  const schedule = createCoalescedTask(async () => {
    runs += 1;
    active += 1;
    maxActive = Math.max(maxActive, active);
    await Bun.sleep(40);
    active -= 1;
  }, 10);

  for (let index = 0; index < 20; index += 1) {
    schedule();
  }
  await Bun.sleep(30);
  // Requested while the first run is in flight: exactly one follow-up.
  schedule();
  schedule();
  await Bun.sleep(150);

  expect(runs).toBe(2);
  expect(maxActive).toBe(1);
});

test("an edited scaffold shown with no targets stays an unbound draft", () => {
  const appeared = createTargetScaffold("shared-volume-pages");

  expect(
    resolveTargetEditorSync([appeared], {
      activeTargetId: null,
      creating: false,
      dirty: true,
    }),
  ).toEqual({
    activeTargetId: null,
    target: null,
    refillEditor: false,
  });
});

test("createCoalescedTask starts the first run right away, then spaces runs out", async () => {
  const startedAt: number[] = [];
  const schedule = createCoalescedTask(async () => {
    startedAt.push(Date.now());
  }, 60);

  const firstRequestAt = Date.now();
  schedule();
  await Bun.sleep(10);
  schedule();
  schedule();
  await Bun.sleep(120);

  expect(startedAt).toHaveLength(2);
  expect((startedAt[0] ?? 0) - firstRequestAt).toBeLessThan(30);
  expect((startedAt[1] ?? 0) - (startedAt[0] ?? 0)).toBeGreaterThanOrEqual(55);
});

test("heartbeat-only live updates are recognized from the event payload", () => {
  const heartbeat = parseEventStreamUpdate(
    JSON.stringify({
      events: [],
      auditSequence: 7,
      workers: [
        {
          workerId: "worker-a",
          runtimeRole: "cf-pages",
          installedCapabilities: ["wrangler"],
          lastSeenAt: "2026-09-26T00:00:00.000Z",
          currentRunId: null,
        },
      ],
    }),
  );

  expect(heartbeat).not.toBeNull();
  expect(readAuditSequence(JSON.stringify({ auditSequence: 7 }))).toBe(7);
  expect(heartbeat && isHeartbeatOnlyUpdate(heartbeat, 7)).toBe(true);
  expect(heartbeat && isHeartbeatOnlyUpdate(heartbeat, 6)).toBe(false);
  expect(parseEventStreamUpdate("not json")).toBeNull();
  expect(parseEventStreamUpdate(JSON.stringify({ events: [] }))).toBeNull();
});
