import { defineTask } from "@hooka/task-sdk";
import { z } from "zod";

export const purgeCacheUrlsInput = z.object({
  // The zone id becomes a URL path segment of an authenticated request, so it
  // must not be able to add path segments or a query string.
  zoneId: z
    .string()
    .regex(/^[A-Za-z0-9_-]+$/, "zoneId must be a Cloudflare zone id."),
  urls: z.string().min(1),
});

function parseUrls(raw: string): string[] {
  return raw
    .split(/[\n,]/g)
    .map((value) => value.trim())
    .filter(Boolean);
}

export const purgeCacheUrlsTask = defineTask({
  id: "cloudflare.cache.purge.urls",
  title: "Purge Cloudflare cache by URL",
  description:
    "Safely purge one or more cached URLs through the Cloudflare cache purge API.",
  input: purgeCacheUrlsInput,
  requires: ["cloudflare-api"],
  executor: {
    kind: "http",
    method: "POST",
    url: ({ input }) =>
      `https://api.cloudflare.com/client/v4/zones/${encodeURIComponent(input.zoneId)}/purge_cache`,
    headers: ({ env }) => ({
      Authorization: `Bearer ${env["CLOUDFLARE_API_TOKEN"] ?? ""}`,
    }),
    body: ({ input }) => ({
      files: parseUrls(input.urls),
    }),
  },
  tags: ["cloudflare", "cache", "purge", "safe"],
});
