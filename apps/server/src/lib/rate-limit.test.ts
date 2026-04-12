import { expect, test } from "bun:test";
import {
  createServerRateLimitContext,
  InMemoryRateLimiter,
  resolveClientIp,
} from "./rate-limit";

test("resolveClientIp ignores x-forwarded-for unless trust proxy is enabled", () => {
  const request = new Request("http://hooka.local/api/runs", {
    headers: {
      "x-forwarded-for": "203.0.113.10, 10.0.0.5",
      "cf-connecting-ip": "198.51.100.2",
      "x-real-ip": "198.51.100.3",
    },
  });

  expect(
    resolveClientIp(request, {
      trustProxy: false,
    }),
  ).toBe("198.51.100.2");
  expect(
    resolveClientIp(request, {
      trustProxy: true,
    }),
  ).toBe("203.0.113.10");
});

test("createServerRateLimitContext uses separate webhook and api buckets", () => {
  const webhook = createServerRateLimitContext(
    new Request("http://hooka.local/api/webhooks/task", {
      headers: {
        "x-real-ip": "198.51.100.3",
      },
    }),
    {
      trustProxy: false,
    },
  );
  const api = createServerRateLimitContext(
    new Request("http://hooka.local/api/summary", {
      headers: {
        "x-real-ip": "198.51.100.3",
      },
    }),
    {
      trustProxy: false,
    },
  );

  expect(webhook.bucket).toBe("webhook");
  expect(api.bucket).toBe("api");
  expect(webhook.clientKey).not.toBe(api.clientKey);
  expect(webhook.globalKey).toBe("webhook:global");
  expect(api.globalKey).toBe("api:global");
});

test("in-memory rate limiter enforces its configured limit", () => {
  const limiter = new InMemoryRateLimiter({
    limit: 2,
    windowMs: 60_000,
  });

  expect(limiter.check("client:api", 0).ok).toBe(true);
  expect(limiter.check("client:api", 1).ok).toBe(true);
  const rejected = limiter.check("client:api", 2);

  expect(rejected.ok).toBe(false);
  expect(rejected.retryAfterSeconds).toBeGreaterThan(0);
});

test("in-memory rate limiter sweeps expired keys during checks", () => {
  const limiter = new InMemoryRateLimiter({
    limit: 2,
    windowMs: 10,
  });

  expect(limiter.check("client-a", 0).ok).toBe(true);
  expect(limiter.requests.has("client-a")).toBe(true);

  expect(limiter.check("client-b", 11).ok).toBe(true);
  expect(limiter.requests.has("client-a")).toBe(false);
});
