import { expect, test } from "bun:test";
import type { CapabilityDefinition } from "@hooka/task-sdk";
import {
  collectCapabilityEnvRequirements,
  findMissingCapabilityEnvRequirements,
} from "./index";

const capabilities = [
  {
    id: "wrangler",
    title: "Wrangler",
    description: "Cloudflare deploy tooling",
    binaries: ["wrangler"],
    requiredEnv: [
      {
        match: "allOf",
        names: ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"],
        description: "Wrangler deploy credentials",
        secret: true,
      },
    ],
    healthcheck: {
      command: "wrangler",
    },
  },
  {
    id: "rclone",
    title: "rclone",
    description: "Artifact sync tooling",
    binaries: ["rclone"],
    requiredEnv: [
      {
        match: "anyOf",
        names: ["RCLONE_CONFIG", "RCLONE_CONFIG_FILE"],
        description: "Any rclone configuration source",
      },
    ],
    healthcheck: {
      command: "rclone",
    },
  },
] satisfies CapabilityDefinition[];

test("collectCapabilityEnvRequirements resolves selected capability contracts", () => {
  const requirements = collectCapabilityEnvRequirements(capabilities, [
    "wrangler",
    "rclone",
  ]);

  expect(requirements).toHaveLength(2);
  expect(requirements[0]?.capabilityId).toBe("wrangler");
  expect(requirements[1]?.match).toBe("anyOf");
});

test("findMissingCapabilityEnvRequirements handles allOf and anyOf contracts", () => {
  const missing = findMissingCapabilityEnvRequirements(
    capabilities,
    ["wrangler", "rclone"],
    {
      CLOUDFLARE_API_TOKEN: "token",
    },
  );

  expect(missing).toEqual([
    expect.objectContaining({
      capabilityId: "wrangler",
      missingNames: ["CLOUDFLARE_ACCOUNT_ID"],
    }),
    expect.objectContaining({
      capabilityId: "rclone",
      missingNames: ["RCLONE_CONFIG", "RCLONE_CONFIG_FILE"],
    }),
  ]);
});
