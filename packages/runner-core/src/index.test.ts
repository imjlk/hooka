import { expect, test } from "bun:test";
import { defineTask } from "@hooka/task-sdk";
import { z } from "zod";
import { loadInstalledCapabilities, runTask } from "./index";

test("loadInstalledCapabilities honors HOOKA_INSTALLED_CAPABILITIES override", async () => {
  const previousCapabilities = Bun.env.HOOKA_INSTALLED_CAPABILITIES;
  const previousRole = Bun.env.HOOKA_RUNTIME_ROLE;

  Bun.env.HOOKA_INSTALLED_CAPABILITIES = "wrangler,wpcli,php-cli";
  Bun.env.HOOKA_RUNTIME_ROLE = "worker:wp-wrangler";

  try {
    const manifest = await loadInstalledCapabilities("/definitely/missing.json");

    expect(manifest.installed).toEqual(["wrangler", "wpcli", "php-cli"]);
    expect(manifest.image).toBe("worker:wp-wrangler");
  } finally {
    if (previousCapabilities === undefined) {
      delete Bun.env.HOOKA_INSTALLED_CAPABILITIES;
    } else {
      Bun.env.HOOKA_INSTALLED_CAPABILITIES = previousCapabilities;
    }

    if (previousRole === undefined) {
      delete Bun.env.HOOKA_RUNTIME_ROLE;
    } else {
      Bun.env.HOOKA_RUNTIME_ROLE = previousRole;
    }
  }
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
