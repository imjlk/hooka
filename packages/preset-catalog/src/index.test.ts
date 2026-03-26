import { expect, test } from "bun:test";
import { resolve } from "node:path";
import {
  activeWorkerPresets,
  listPlannedWorkerPresets,
  renderDockerBakeHcl,
} from "./index";

test("active worker presets only include registry-backed entries", () => {
  expect(activeWorkerPresets.map((preset) => preset.id)).toEqual([
    "core",
    "cf-pages",
    "cf-cache",
    "wp-ops",
    "wp-wrangler",
  ]);
  expect(listPlannedWorkerPresets().some((preset) => preset.id === "rclone-sync")).toBe(
    true,
  );
});

test("catalog bake output stays in sync with the checked-in bake file", async () => {
  const bakeFile = Bun.file(
    resolve(process.cwd(), "docker/docker-bake.hcl"),
  );
  const checkedIn = (await bakeFile.text()).trim();

  expect(checkedIn).toBe(renderDockerBakeHcl().trim());
});

test("catalog exposes legacy image tags for migration", () => {
  const cfPages = activeWorkerPresets.find((preset) => preset.id === "cf-pages");
  const wpWrangler = activeWorkerPresets.find(
    (preset) => preset.id === "wp-wrangler",
  );

  expect(cfPages?.legacyImageTags).toEqual(["cf-wrangler", "wrangler-worker"]);
  expect(wpWrangler?.legacyImageTags).toEqual(["webhook-wrangler"]);
});
