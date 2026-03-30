import { expect, test } from "bun:test";
import { join } from "node:path";
import { defineTask } from "@hooka/task-sdk";
import { z } from "zod";
import {
  getDefaultManifestPath,
  loadInstalledCapabilities,
  runTask,
} from "./index";

test("loadInstalledCapabilities honors HOOKA_INSTALLED_CAPABILITIES override", async () => {
  const previousCapabilities = Bun.env["HOOKA_INSTALLED_CAPABILITIES"];
  const previousRole = Bun.env["HOOKA_RUNTIME_ROLE"];

  Bun.env["HOOKA_INSTALLED_CAPABILITIES"] = "wrangler,wpcli,php-cli";
  Bun.env["HOOKA_RUNTIME_ROLE"] = "worker:wp-wrangler";

  try {
    const manifest = await loadInstalledCapabilities(
      "/definitely/missing.json",
    );

    expect(manifest.installed).toEqual(["wrangler", "wpcli", "php-cli"]);
    expect(manifest.image).toBe("worker:wp-wrangler");
  } finally {
    if (previousCapabilities === undefined) {
      delete Bun.env["HOOKA_INSTALLED_CAPABILITIES"];
    } else {
      Bun.env["HOOKA_INSTALLED_CAPABILITIES"] = previousCapabilities;
    }

    if (previousRole === undefined) {
      delete Bun.env["HOOKA_RUNTIME_ROLE"];
    } else {
      Bun.env["HOOKA_RUNTIME_ROLE"] = previousRole;
    }
  }
});

test("getDefaultManifestPath honors HOOKA_MANIFEST_PATH override", () => {
  expect(
    getDefaultManifestPath("/repo", {
      HOOKA_MANIFEST_PATH: "tmp/custom-manifest.json",
    }),
  ).toBe("/repo/tmp/custom-manifest.json");
});

test("loadInstalledCapabilities reads the repo-local generated manifest by default", async () => {
  const tempDir = join(
    Bun.env["TMPDIR"] ?? "/tmp",
    `hooka-runner-core-${Date.now()}-${crypto.randomUUID()}`,
  );
  const manifestPath = getDefaultManifestPath(tempDir, {});

  await Bun.$`mkdir -p ${join(tempDir, ".hooka")}`.quiet();
  await Bun.write(
    manifestPath,
    JSON.stringify({
      image: "hooka:test",
      generatedAt: "2026-03-29T00:00:00.000Z",
      installed: ["cloudflare-api"],
    }),
  );

  const manifest = await loadInstalledCapabilities(
    getDefaultManifestPath(tempDir, {}),
  );

  expect(manifest.image).toBe("hooka:test");
  expect(manifest.installed).toEqual(["cloudflare-api"]);
  expect(manifestPath).toBe(
    join(tempDir, ".hooka", "installed-capabilities.json"),
  );
});

test("internal executor failures return failed task results", async () => {
  const task = defineTask({
    id: "internal.fails",
    title: "Internal failure",
    input: z.object({
      value: z.string(),
    }),
    requires: [],
    executor: {
      kind: "internal",
      run: async () => {
        throw new Error("boom");
      },
    },
  });

  const result = await runTask(
    task,
    {
      value: "hello",
    },
    {
      installedCapabilities: [],
    },
  );

  expect(result.ok).toBe(false);
  expect(result.status).toBe("failed");
  expect(result.summary).toBe("boom");
  expect(result.stderr).toBe("boom");
});
