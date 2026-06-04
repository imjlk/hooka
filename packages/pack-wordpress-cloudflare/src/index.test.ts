import { expect, test } from "bun:test";
import { runTask } from "@hooka/runner-core";
import {
  sharedVolumeWranglerTask,
  trailbaseAssetsDrainedWebhookAdapter,
  trailbaseUploadsPagesTask,
  wordpressSimplyStaticWebhookAdapter,
} from "./index";

test("shared-volume wrangler task forwards useful Pages deploy flags", async () => {
  const result = await runTask(
    sharedVolumeWranglerTask,
    {
      kind: "pages-deploy",
      sourcePath: "/shared-source/export",
      project: "staging-site",
      branch: "main",
      commitSha: "abc123",
      commitMessage: "deploy export",
      commitDirty: true,
      skipCaching: true,
      noBundle: true,
      uploadSourceMaps: true,
    },
    {
      dryRun: true,
      installedCapabilities: ["wrangler"],
    },
  );

  expect(result.ok).toBe(true);
  expect(result.status).toBe("skipped");
  expect(result.command).toEqual([
    "wrangler",
    "pages",
    "deploy",
    "/shared-source/export",
    "--project-name",
    "staging-site",
    "--branch",
    "main",
    "--commit-hash",
    "abc123",
    "--commit-message",
    "deploy export",
    "--commit-dirty=true",
    "--skip-caching",
    "--no-bundle",
    "--upload-source-maps",
  ]);
});

test("trailbase full static task deploys the shared TrailBase Pages root", async () => {
  const result = await runTask(
    trailbaseUploadsPagesTask,
    {
      kind: "pages-deploy",
      sourcePath: "/shared-source/trailbase/uploads",
      project: "zero-three-three-assets",
      branch: "production",
      noBundle: true,
    },
    {
      dryRun: true,
      installedCapabilities: ["wrangler"],
    },
  );

  expect(result.ok).toBe(true);
  expect(result.status).toBe("skipped");
  expect(result.command).toEqual([
    "wrangler",
    "pages",
    "deploy",
    "/shared-source/trailbase/uploads",
    "--project-name",
    "zero-three-three-assets",
    "--branch",
    "production",
    "--no-bundle",
  ]);
});

test("wordpress compatibility adapter normalizes webhook payloads", () => {
  const payload = wordpressSimplyStaticWebhookAdapter.normalize(
    JSON.stringify({
      eventId: "evt_1",
      project: "customer-site",
      exportDir: "/shared-source/simply-static",
      branch: "main",
    }),
  );

  expect(payload).toEqual({
    taskId: "deploy.shared-volume.wrangler",
    input: {
      kind: "pages-deploy",
      project: "customer-site",
      sourcePath: "/shared-source/simply-static",
      branch: "main",
      commitSha: undefined,
      commitMessage: undefined,
      commitDirty: undefined,
      skipCaching: undefined,
      noBundle: undefined,
      uploadSourceMaps: undefined,
    },
    eventId: "evt_1",
    source: "wordpress.webhook",
    triggeredAt: undefined,
  });
});

test("trailbase assets adapter normalizes drained webhook payloads", () => {
  const payload = trailbaseAssetsDrainedWebhookAdapter.normalize(
    JSON.stringify({
      idempotencyKey:
        "asset-drain:v2:latest:123:ready:10:failed:2:static:456:7",
      project: "zero-three-three-assets",
      branch: "production",
      sourcePath: "/shared-source/trailbase/uploads",
      readyCount: 10,
      failedCount: 2,
      latestAssetUpdatedAt: 123,
      staticRevision: "456:7",
    }),
  );

  expect(payload).toEqual({
    taskId: "deploy.trailbase-pages.full",
    input: {
      kind: "pages-deploy",
      project: "zero-three-three-assets",
      sourcePath: "/shared-source/trailbase/uploads",
      branch: "production",
      commitMessage:
        "TrailBase full static deploy: ready=10, failed=2, latest=123, static=456:7",
      noBundle: true,
    },
    eventId: "asset-drain:v2:latest:123:ready:10:failed:2:static:456:7",
    source: "zero-three-three.asset_generation_drained",
    triggeredAt: undefined,
  });
});
