export interface RateLimitDecision {
  ok: boolean;
  key: string;
  retryAfterSeconds?: number;
}

export interface InMemoryRateLimiterOptions {
  limit: number;
  windowMs: number;
}

export class InMemoryRateLimiter {
  readonly limit: number;
  readonly windowMs: number;
  readonly requests = new Map<string, number[]>();

  constructor(options: InMemoryRateLimiterOptions) {
    this.limit = options.limit;
    this.windowMs = options.windowMs;
  }

  check(key: string, now = Date.now()): RateLimitDecision {
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
}

export function createServerRateLimitKey(request: Request): string {
  const url = new URL(request.url);
  const pathname = url.pathname;

  return `${resolveClientIp(request)}:${pathname.startsWith("/api/webhooks/") ? "webhook" : "api"}`;
}

function resolveClientIp(request: Request): string {
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
