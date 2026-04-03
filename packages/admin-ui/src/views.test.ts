import { expect, test } from "bun:test";
import { renderPresetDetail } from "./views/presets";
import { renderRunDetail } from "./views/runs";
import { renderSummaryCards } from "./views/summary";
import type { PresetWithPlan, RunDetail, Summary } from "./helpers";

test("renderSummaryCards includes the core metric labels", () => {
  const html = renderSummaryCards({
    generatedAt: "2026-03-29T00:00:00.000Z",
    counts: {
      tasks: 4,
      capabilities: 3,
      presets: 2,
    },
    installedCapabilities: [],
    workers: [],
    tasks: [],
    presets: [],
  } satisfies Summary);

  expect(html).toContain("Tasks");
  expect(html).toContain("Capabilities");
  expect(html).toContain("Presets");
});

test("renderPresetDetail includes required env and covered task chips", () => {
  const preset: PresetWithPlan = {
    id: "cf-pages",
    title: "CF Pages",
    description: "Deploy shared-volume pages artifacts.",
    tier: "lean",
    imageTag: "hooka:cf-pages",
    publicWorkerTag: "cf-pages",
    capabilities: ["wrangler"],
    plan: {
      presetId: "cf-pages",
      tier: "lean",
      imageTag: "hooka:cf-pages",
      publicWorkerTag: "cf-pages",
      legacyImageTags: [],
      capabilities: ["wrangler"],
      requiredEnv: [
        {
          capabilityId: "wrangler",
          match: "allOf",
          names: ["CLOUDFLARE_API_TOKEN"],
          description: "Needed for wrangler auth.",
        },
      ],
      taskPacks: ["@hooka/pack-wordpress-cloudflare"],
      coveredTasks: ["deploy.shared-volume.wrangler"],
      missingCapabilitiesByTask: {},
    },
  };

  const result = renderPresetDetail([preset], null);
  expect(result.selectedPresetId).toBe("cf-pages");
  expect(result.html).toContain("CLOUDFLARE_API_TOKEN");
  expect(result.html).toContain("deploy.shared-volume.wrangler");
});

test("renderRunDetail includes stdout, stderr, and timeline data", () => {
  const html = renderRunDetail({
    id: "run_1",
    taskId: "deploy.shared-volume.wrangler",
    source: "cli.webhook-test",
    sourceEventId: null,
    targetId: "target-a",
    status: "failed",
    summary: "failed summary",
    errorText: "stderr output",
    attemptCount: 1,
    maxAttempts: 3,
    nextRetryAt: null,
    lastErrorCode: "process_exit_1",
    createdAt: "2026-03-29T00:00:00.000Z",
    queuedAt: "2026-03-29T00:00:01.000Z",
    startedAt: "2026-03-29T00:00:02.000Z",
    finishedAt: "2026-03-29T00:00:03.000Z",
    payload: {
      project: "site",
    },
    result: {
      status: "failed",
      stdout: "stdout output",
      stderr: "stderr output",
      summary: "failed summary",
    },
    capabilitySnapshot: ["wrangler"],
    workerId: "worker-a",
    leaseExpiresAt: null,
    events: [
      {
        id: "evt_1",
        type: "failed",
        message: "task failed",
        createdAt: "2026-03-29T00:00:03.000Z",
        data: {
          code: 1,
        },
      },
    ],
  } satisfies RunDetail);

  expect(html).toContain("stdout output");
  expect(html).toContain("stderr output");
  expect(html).toContain("task failed");
  expect(html).toContain("Retry Run");
});
