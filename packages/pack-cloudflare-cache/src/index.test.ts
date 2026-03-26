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
