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
}

export interface ClientIpOptions {
  trustProxy: boolean;
  /** Trusted reverse proxies in front of Hooka; defaults to 1 when trusted. */
  trustedProxyHops?: number;
  /** Address of the peer that opened the connection, when known. */
  socketIp?: string;
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
  input: ClientIpOptions,
): ServerRateLimitContext {
  const url = new URL(request.url);
  const pathname = url.pathname;
  const bucket = pathname.startsWith("/api/webhooks/") ? "webhook" : "api";
  const clientIp = resolveClientIp(request, input);

  // Keyed by client address only. The caller picks its User-Agent, so a key
  // that included it let one client rotate agents past its own limit and
  // spend the global budget that every other caller shares.
  return {
    bucket,
    clientIp,
    clientKey: `${bucket}:${clientIp}`,
    globalKey: `${bucket}:global`,
    pathname,
  };
}

export function resolveClientIp(
  request: Request,
  input: ClientIpOptions,
): string {
  const socketIp = input.socketIp || "unknown";

  if (!input.trustProxy) {
    return socketIp;
  }

  // Proxies append the address they received the request from, so only the
  // right-most `hops` entries were written by trusted proxies. Anything to
  // their left came from the client and can be forged (Cloudflare, for
  // example, appends to a client-supplied X-Forwarded-For).
  const forwardedFor = request.headers
    .get("x-forwarded-for")
    ?.split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (forwardedFor && forwardedFor.length > 0) {
    const hops = Math.max(1, input.trustedProxyHops ?? 1);
    return forwardedFor[Math.max(0, forwardedFor.length - hops)] ?? socketIp;
  }

  return (
    request.headers.get("cf-connecting-ip") ??
    request.headers.get("x-real-ip") ??
    socketIp
  );
}

/**
 * Collapses repeated security rejections from one client into one audit row
 * per window. Every rejected request used to write a synchronous SQLite row
 * (kept for 90 days) and push an SSE update, so an unauthenticated flood
 * filled the disk and made open admin tabs rate-limit themselves.
 */
export class AuditThrottle {
  readonly windowMs: number;
  private readonly entries = new Map<
    string,
    { windowStartedAt: number; suppressed: number }
  >();
  private lastSweepAt = 0;

  constructor(windowMs: number) {
    this.windowMs = windowMs;
  }

  /** Returns how many rows were suppressed since the last one, or null to skip. */
  admit(key: string, now = Date.now()): number | null {
    const entry = this.entries.get(key);

    if (entry && now - entry.windowStartedAt < this.windowMs) {
      entry.suppressed += 1;
      return null;
    }

    // Read the expired entry before sweeping so its count is still reported.
    this.sweep(now);
    this.entries.set(key, { windowStartedAt: now, suppressed: 0 });
    return entry?.suppressed ?? 0;
  }

  private sweep(now: number): void {
    if (now - this.lastSweepAt < this.windowMs) {
      return;
    }

    for (const [key, entry] of this.entries) {
      if (now - entry.windowStartedAt >= this.windowMs) {
        this.entries.delete(key);
      }
    }
    this.lastSweepAt = now;
  }
}
