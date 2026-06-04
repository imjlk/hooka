import { createHash } from "node:crypto";

export interface RateLimitDecision {
  ok: boolean;
  key: string;
  retryAfterSeconds?: number;
}

export interface InMemoryRateLimiterOptions {
  limit: number;
  windowMs: number;
}

export interface ServerRateLimitContext {
  bucket: "api" | "webhook";
  clientIp: string;
  clientKey: string;
  globalKey: string;
  pathname: string;
  userAgentHash: string;
}

export class InMemoryRateLimiter {
  readonly limit: number;
  readonly windowMs: number;
  readonly requests = new Map<string, number[]>();
  private lastSweepAt = 0;

  constructor(options: InMemoryRateLimiterOptions) {
    this.limit = options.limit;
    this.windowMs = options.windowMs;
  }

  check(key: string, now = Date.now()): RateLimitDecision {
    this.sweep(now);

    const recent = (this.requests.get(key) ?? []).filter(
      (value) => value > now - this.windowMs,
    );

    if (recent.length >= this.limit) {
      const retryAfterMs = recent[0]
        ? recent[0] + this.windowMs - now
        : this.windowMs;
      this.requests.set(key, recent);
      return {
        ok: false,
        key,
        retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)),
      };
    }

    recent.push(now);
    this.requests.set(key, recent);

    return {
      ok: true,
      key,
    };
  }

  private sweep(now: number): void {
    if (now - this.lastSweepAt < this.windowMs) {
      return;
    }

    for (const [key, timestamps] of this.requests.entries()) {
      const recent = timestamps.filter((value) => value > now - this.windowMs);

      if (recent.length === 0) {
        this.requests.delete(key);
        continue;
      }

      this.requests.set(key, recent);
    }

    this.lastSweepAt = now;
  }
}

export function createServerRateLimitContext(
  request: Request,
  input: {
    trustProxy: boolean;
  },
): ServerRateLimitContext {
  const url = new URL(request.url);
  const pathname = url.pathname;
  const bucket = pathname.startsWith("/api/webhooks/") ? "webhook" : "api";
  const clientIp = resolveClientIp(request, input);
  const userAgentHash = hashUserAgent(request.headers.get("user-agent"));

  return {
    bucket,
    clientIp,
    clientKey: `${bucket}:${clientIp}:${userAgentHash}`,
    globalKey: `${bucket}:global`,
    pathname,
    userAgentHash,
  };
}

export function resolveClientIp(
  request: Request,
  input: {
    trustProxy: boolean;
  },
): string {
  if (!input.trustProxy) {
    return "unknown";
  }

  const forwardedFor = request.headers.get("x-forwarded-for");
  if (forwardedFor) {
    return forwardedFor.split(",")[0]?.trim() || "unknown";
  }

  return (
    request.headers.get("cf-connecting-ip") ??
    request.headers.get("x-real-ip") ??
    "unknown"
  );
}

function hashUserAgent(userAgent: string | null): string {
  return createHash("sha256")
    .update(userAgent ?? "")
    .digest("hex")
    .slice(0, 12);
}
