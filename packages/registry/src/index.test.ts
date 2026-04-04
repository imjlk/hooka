import { expect, test } from "bun:test";
import { listPlannedWorkerPresets } from "@hooka/preset-catalog";
import {
  findMissingCapabilityEnv,
  getPreset,
  getPresetPlan,
  getTask,
  listPresets,
  listTasks,
  listWebhookAdapters,
  recommendPresetForTasks,
  validateRegistry,
  validateRegistryState,
} from "./index";

test("registry validates without duplicate definitions", () => {
  expect(validateRegistry()).toEqual({
    ok: true,
    errors: [],
  });
});

test("active presets cover cloudflare, rclone, and wordpress worker taxonomy", () => {
  const cfPagesPlan = getPresetPlan("cf-pages");
  const cfCachePlan = getPresetPlan("cf-cache");
  const rcloneSyncPlan = getPresetPlan("rclone-sync");
  const wpWranglerPlan = getPresetPlan("wp-wrangler");

  expect(cfPagesPlan?.coveredTasks).toContain("deploy.shared-volume.wrangler");
  expect(cfPagesPlan?.coveredTasks).toContain("cloudflare.pages.deploy");
  expect(cfPagesPlan?.missingCapabilitiesByTask).toEqual({});
  expect(cfCachePlan?.coveredTasks).toContain("cloudflare.cache.purge.urls");
  expect(cfCachePlan?.capabilities).toEqual(["cloudflare-api"]);
  expect(rcloneSyncPlan?.coveredTasks).toContain("rclone.copy.directory");
  expect(rcloneSyncPlan?.capabilities).toEqual(["rclone"]);
  expect(recommendPresetForTasks(["rclone.copy.directory"])?.id).toBe(
    "rclone-sync",
  );
  expect(recommendPresetForTasks(["deploy.shared-volume.wrangler"])?.id).toBe(
    "cf-pages",
  );
  expect(wpWranglerPlan?.coveredTasks).toContain("wordpress.wpcli.eval");
  expect(wpWranglerPlan?.coveredTasks).toContain(
    "deploy.shared-volume.wrangler",
  );
});

test("registry resolves task and preset aliases to canonical definitions", () => {
  expect(getTask("wordpress.deploy.simply-static")?.id).toBe(
    "deploy.shared-volume.wrangler",
  );
  expect(getPreset("cf-wrangler")?.id).toBe("cf-pages");
  expect(getPreset("webhook-wrangler")?.id).toBe("wp-wrangler");
  expect(listTasks().map((task) => task.id)).not.toContain(
    "wordpress.deploy.simply-static",
  );
  expect(listPresets().map((preset) => preset.id)).toEqual([
    "core",
    "cf-pages",
    "cf-cache",
    "wp-ops",
    "rclone-sync",
    "wp-wrangler",
  ]);
  expect(listWebhookAdapters().map((adapter) => adapter.id)).toEqual([
    "wordpress.simply-static",
  ]);
});

test("planned presets stay out of active registry output", () => {
  const activeIds = new Set(listPresets().map((preset) => preset.id));

  for (const preset of listPlannedWorkerPresets()) {
    expect(activeIds.has(preset.id)).toBe(false);
  }

  expect(activeIds.has("rclone-sync")).toBe(true);
});

test("registry reports missing env for installed wrangler capability", () => {
  const missing = findMissingCapabilityEnv(["wrangler"], {
    CLOUDFLARE_API_TOKEN: "",
  });

  expect(missing).toEqual([
    expect.objectContaining({
      capabilityId: "wrangler",
      match: "allOf",
      missingNames: ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"],
    }),
  ]);
});

test("registry reports missing env for installed rclone capability", () => {
  const missing = findMissingCapabilityEnv(["rclone"], {});

  expect(missing).toEqual([
    expect.objectContaining({
      capabilityId: "rclone",
      match: "anyOf",
      missingNames: ["RCLONE_CONFIG", "RCLONE_CONFIG_FILE"],
    }),
  ]);
});

test("registry validation rejects duplicate webhook adapter ids and routes", () => {
  const result = validateRegistryState({
    capabilities: [],
    taskPacks: [],
    presets: [],
    tasks: [],
    webhookAdapters: [
      {
        id: "adapter-a",
        routePath: "/api/webhooks/compat",
        normalize: () => ({
          taskId: "deploy.shared-volume.wrangler",
          input: {},
          eventId: "evt_1",
          source: "test",
        }),
      },
      {
        id: "adapter-a",
        routePath: "/api/webhooks/compat",
        normalize: () => ({
          taskId: "deploy.shared-volume.wrangler",
          input: {},
          eventId: "evt_2",
          source: "test",
        }),
      },
    ],
  });

  expect(result.ok).toBe(false);
  expect(result.errors).toEqual(
    expect.arrayContaining([
      "Duplicate webhook adapter id detected: adapter-a",
      "Duplicate webhook adapter route detected: /api/webhooks/compat",
    ]),
  );
});
