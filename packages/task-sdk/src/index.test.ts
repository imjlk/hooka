import { expect, test } from "bun:test";
import { z } from "zod";
import { defineCapability, definePreset, defineTask } from "./index";

test("defineTask preserves task shape while deduplicating aliases", () => {
  const input = z.object({
    project: z.string(),
  });
  const task = defineTask({
    id: "task.example",
    aliases: ["task.alias", "task.alias"],
    title: "Example task",
    input,
    requires: [],
    executor: {
      kind: "internal",
      run: ({ input }) => input.project,
    },
  });

  expect(task.input).toBe(input);
  expect(task.aliases).toEqual(["task.alias"]);
});

test("defineCapability preserves contracts and normalizes missing env arrays", () => {
  const capability = defineCapability({
    id: "wrangler",
    title: "Wrangler",
    description: "Cloudflare CLI",
    binaries: ["wrangler"],
    healthcheck: {
      command: "wrangler",
      args: ["--version"],
    },
  });

  expect(capability.requiredEnv).toEqual([]);
  expect(capability.healthcheck.args).toEqual(["--version"]);
});

test("definePreset deduplicates aliases and legacy image tags", () => {
  const preset = definePreset({
    id: "cf-pages",
    aliases: ["cf-wrangler", "cf-wrangler"],
    title: "CF Pages",
    description: "Pages preset",
    imageTag: "hooka:cf-pages",
    publicWorkerTag: "cf-pages",
    legacyImageTags: ["wrangler-worker", "wrangler-worker"],
    capabilities: ["wrangler"],
    taskPacks: ["@hooka/pack-cloudflare"],
  });

  expect(preset.aliases).toEqual(["cf-wrangler"]);
  expect(preset.legacyImageTags).toEqual(["wrangler-worker"]);
});
