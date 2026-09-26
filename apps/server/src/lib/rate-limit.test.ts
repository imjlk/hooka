import { expect, test } from "bun:test";
import {
  AuditThrottle,
  createServerRateLimitContext,
  InMemoryRateLimiter,
  resolveClientIp,
} from "./rate-limit";

test("resolveClientIp uses the socket address unless trust proxy is enabled", () => {
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
  ).toBe("unknown");
  expect(
    resolveClientIp(request, {
      trustProxy: false,
      socketIp: "192.0.2.7",
    }),
  ).toBe("192.0.2.7");
});

test("resolveClientIp only trusts the proxy-written end of x-forwarded-for", () => {
  const request = new Request("http://hooka.local/api/runs", {
    headers: {
      // The client forged the first entry; the edge proxy appended the real
      // client, and the proxy next to Hooka appended the edge's address.
      "x-forwarded-for": "6.6.6.6, 203.0.113.10, 10.0.0.5",
    },
  });

  expect(resolveClientIp(request, { trustProxy: true })).toBe("10.0.0.5");
  expect(
    resolveClientIp(request, { trustProxy: true, trustedProxyHops: 2 }),
  ).toBe("203.0.113.10");
  expect(
    resolveClientIp(request, { trustProxy: true, trustedProxyHops: 9 }),
  ).toBe("6.6.6.6");
  expect(
    resolveClientIp(
      new Request("http://hooka.local/api/runs", {
        headers: { "cf-connecting-ip": "198.51.100.2" },
      }),
      { trustProxy: true, socketIp: "192.0.2.7" },
    ),
  ).toBe("198.51.100.2");
  expect(
    resolveClientIp(new Request("http://hooka.local/api/runs"), {
      trustProxy: true,
      socketIp: "192.0.2.7",
    }),
  ).toBe("192.0.2.7");
});

test("rate limit keys ignore the caller-controlled user agent", () => {
  const contextFor = (userAgent: string) =>
    createServerRateLimitContext(
      new Request("http://hooka.local/api/summary", {
        headers: { "user-agent": userAgent },
      }),
      { trustProxy: false, socketIp: "192.0.2.7" },
    );

  expect(contextFor("agent-a").clientKey).toBe(contextFor("agent-b").clientKey);
});

test("audit throttle admits one row per key per window and counts the rest", () => {
  const throttle = new AuditThrottle(1_000);

  expect(throttle.admit("admin_auth_rejected:192.0.2.7", 0)).toBe(0);
  expect(throttle.admit("admin_auth_rejected:192.0.2.7", 10)).toBeNull();
  expect(throttle.admit("admin_auth_rejected:192.0.2.7", 20)).toBeNull();
  expect(throttle.admit("admin_auth_rejected:192.0.2.8", 30)).toBe(0);
  expect(throttle.admit("admin_auth_rejected:192.0.2.7", 1_000)).toBe(2);
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
