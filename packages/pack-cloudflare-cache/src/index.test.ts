import { expect, test } from "bun:test";
import { runTask } from "@hooka/runner-core";
import { purgeCacheUrlsTask } from "./index";

test("cache purge task builds a Cloudflare files payload on dry run", async () => {
  const result = await runTask(
    purgeCacheUrlsTask,
    {
      zoneId: "zone-123",
      urls: "https://example.com/, https://example.com/about\nhttps://example.com/blog",
    },
    {
      dryRun: true,
      installedCapabilities: ["cloudflare-api"],
      env: {
        CLOUDFLARE_API_TOKEN: "token",
      },
    },
  );

  expect(result.status).toBe("skipped");
  expect(result.data).toEqual({
    files: [
      "https://example.com/",
      "https://example.com/about",
      "https://example.com/blog",
    ],
  });
});

test("cache purge task only accepts zone ids that stay one URL path segment", async () => {
  if (purgeCacheUrlsTask.executor.kind !== "http") {
    throw new Error("purgeCacheUrlsTask should use the HTTP executor.");
  }

  expect(
    purgeCacheUrlsTask.executor.url({
      input: purgeCacheUrlsTask.input.parse({
        zoneId: "023e105f4ecef8ad9ca31a8372d0c353",
        urls: "https://example.com/",
      }),
      dryRun: true,
      env: {},
    }),
  ).toBe(
    "https://api.cloudflare.com/client/v4/zones/023e105f4ecef8ad9ca31a8372d0c353/purge_cache",
  );

  const result = await runTask(
    purgeCacheUrlsTask,
    {
      zoneId: "../../accounts/abc/tokens?x=",
      urls: "https://example.com/",
    },
    {
      dryRun: true,
      installedCapabilities: ["cloudflare-api"],
    },
  );

  expect(result).toMatchObject({
    ok: false,
    retryable: false,
    errorCode: "input_invalid",
  });
});
