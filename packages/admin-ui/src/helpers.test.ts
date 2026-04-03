import { expect, test } from "bun:test";
import {
  buildRunQuery,
  deriveRunFilterOptions,
  formatCapabilityEnvRows,
  selectActiveRunId,
  selectPreset,
  selectTarget,
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
