import { expect, test } from "bun:test";
import { listPlannedWorkerPresets } from "@hooka/preset-catalog";
import {
  findMissingCapabilityEnv,
  getPreset,
  getPresetPlan,
  getTask,
  listPresets,
  listTasks,
  recommendPresetForTasks,
  validateRegistry,
} from "./index";

test("registry validates without duplicate definitions", () => {
  expect(validateRegistry()).toEqual({
    ok: true,
    errors: [],
  });
});

test("cf-pages, cf-cache, and wp-wrangler presets cover the active worker taxonomy", () => {
  const cfPagesPlan = getPresetPlan("cf-pages");
  const cfCachePlan = getPresetPlan("cf-cache");
  const wpWranglerPlan = getPresetPlan("wp-wrangler");

  expect(cfPagesPlan?.coveredTasks).toContain("deploy.shared-volume.wrangler");
  expect(cfPagesPlan?.coveredTasks).toContain("cloudflare.pages.deploy");
  expect(cfPagesPlan?.missingCapabilitiesByTask).toEqual({});
  expect(cfCachePlan?.coveredTasks).toContain("cloudflare.cache.purge.urls");
  expect(cfCachePlan?.capabilities).toEqual(["cloudflare-api"]);
  expect(
    recommendPresetForTasks(["deploy.shared-volume.wrangler"])?.id,
  ).toBe("cf-pages");
  expect(wpWranglerPlan?.coveredTasks).toContain("wordpress.wpcli.eval");
  expect(wpWranglerPlan?.coveredTasks).toContain("deploy.shared-volume.wrangler");
});

test("registry resolves task and preset aliases to canonical definitions", () => {
  expect(getTask("wordpress.deploy.simply-static")?.id).toBe(
    "deploy.shared-volume.wrangler",
  );
  expect(getPreset("cf-wrangler")?.id).toBe("cf-pages");
  expect(getPreset("webhook-wrangler")?.id).toBe("wp-wrangler");
  expect(listTasks().map((task) => task.id)).not.toContain("wordpress.deploy.simply-static");
  expect(listPresets().map((preset) => preset.id)).toEqual([
    "core",
    "cf-pages",
    "cf-cache",
    "wp-ops",
    "wp-wrangler",
  ]);
});

test("planned presets stay out of active registry output", () => {
  const activeIds = new Set(listPresets().map((preset) => preset.id));

  for (const preset of listPlannedWorkerPresets()) {
    expect(activeIds.has(preset.id)).toBe(false);
  }
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
