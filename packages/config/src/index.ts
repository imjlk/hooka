import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";

export type EnvRecord = Record<string, string | undefined>;
export type ManifestSourceKind =
  | "env-inline"
  | "manifest-explicit"
  | "manifest-default";
export type WorkerFreshness = "healthy" | "stale";

export const defaultManifestRelativePath = ".hooka/installed-capabilities.json";
export const defaultTargetsRelativePath = ".hooka/targets.json";
export const defaultLocalDbRelativePath = ".hooka/hooka.sqlite";
export const defaultServerPort = 3000;
export const defaultWorkerPollIntervalMs = 2_000;
export const defaultRunLeaseMs = 900_000;
export const defaultRunMaxAttempts = 3;
export const defaultRetryBaseDelayMs = 5_000;
export const defaultWorkerHeartbeatIntervalMs = 10_000;
export const defaultRateLimitWindowMs = 60_000;
export const defaultApiRateLimit = 120;
export const defaultWebhookRateLimit = 60;
export const defaultGlobalApiRateLimit = 1_200;
export const defaultGlobalWebhookRateLimit = 600;
export const defaultRetentionRunDays = 30;
export const defaultRetentionAuditDays = 90;
export const defaultRetentionSweepIntervalHours = 24;
export const defaultUiPort = 4310;
export const defaultUiApiOrigin = "http://127.0.0.1:3000";
export const defaultMaxBodyBytes = 1_048_576;

const serverConfigSchema = z.object({
  port: z.number().int().positive(),
  dbPath: z.string().min(1),
  runtimeRole: z.string().min(1),
  webhookSecret: z.string().min(1).optional(),
  adminToken: z.string().min(1).optional(),
  maxAttempts: z.number().int().positive(),
  trustProxy: z.boolean(),
  rateLimitWindowMs: z.number().int().positive(),
  apiRateLimit: z.number().int().positive(),
  webhookRateLimit: z.number().int().positive(),
  globalApiRateLimit: z.number().int().positive(),
  globalWebhookRateLimit: z.number().int().positive(),
  corsOrigins: z.array(z.string()),
  maxBodyBytes: z.number().int().positive(),
  capabilityManifestPath: z.string().min(1),
  targetsPath: z.string().min(1),
  uiDistDir: z.string().min(1),
});

const workerConfigSchema = z.object({
  dbPath: z.string().min(1),
  runtimeRole: z.string().min(1),
  manifestPath: z.string().min(1),
  targetsPath: z.string().min(1),
  workerId: z.string().min(1),
  pollIntervalMs: z.number().int().positive(),
  leaseMs: z.number().int().positive(),
  maxAttempts: z.number().int().positive(),
  retryBaseDelayMs: z.number().int().positive(),
  heartbeatIntervalMs: z.number().int().positive(),
  retentionRunDays: z.number().int().positive(),
  retentionAuditDays: z.number().int().positive(),
  retentionSweepIntervalHours: z.number().int().positive(),
});

const cliConfigSchema = z.object({
  dbPath: z.string().min(1),
  manifestPath: z.string().min(1),
  targetsPath: z.string().min(1),
  retentionRunDays: z.number().int().positive(),
  retentionAuditDays: z.number().int().positive(),
});

const adminUiDevConfigSchema = z.object({
  uiPort: z.number().int().positive(),
  apiOrigin: z.string().url(),
});

export type ServerConfig = z.infer<typeof serverConfigSchema>;
export type WorkerConfig = z.infer<typeof workerConfigSchema>;
export type CliConfig = z.infer<typeof cliConfigSchema>;
export type AdminUiDevConfig = z.infer<typeof adminUiDevConfigSchema>;
export interface ManifestSourceResolution {
  kind: ManifestSourceKind;
  manifestPath: string;
}

export function resolveHookaProjectRoot(startDir = process.cwd()): string {
  let current = resolve(startDir);

  while (true) {
    if (
      existsSync(join(current, "package.json")) &&
      existsSync(join(current, "packages"))
    ) {
      return current;
    }

    const parent = dirname(current);

    if (parent === current) {
      return startDir;
    }

    current = parent;
  }
}

export function getDefaultLocalDbPath(cwd = process.cwd()): string {
  return resolve(cwd, defaultLocalDbRelativePath);
}

export function getDefaultManifestPath(
  cwd = process.cwd(),
  env: EnvRecord = Bun.env as EnvRecord,
): string {
  return resolve(
    cwd,
    env["HOOKA_MANIFEST_PATH"] ?? defaultManifestRelativePath,
  );
}

export function getDefaultTargetsPath(
  cwd = process.cwd(),
  env: EnvRecord = Bun.env as EnvRecord,
): string {
  return resolve(cwd, env["HOOKA_TARGETS_PATH"] ?? defaultTargetsRelativePath);
}

export function resolveManifestSource(
  input: { cwd?: string; env?: EnvRecord } = {},
): ManifestSourceResolution {
  const cwd = input.cwd ?? process.cwd();
  const env = input.env ?? (Bun.env as EnvRecord);

  if (env["HOOKA_INSTALLED_CAPABILITIES"]?.trim()) {
    return {
      kind: "env-inline",
      manifestPath: getDefaultManifestPath(cwd, env),
    };
  }

  if (env["HOOKA_MANIFEST_PATH"]) {
    return {
      kind: "manifest-explicit",
      manifestPath: getDefaultManifestPath(cwd, env),
    };
  }

  return {
    kind: "manifest-default",
    manifestPath: getDefaultManifestPath(cwd, env),
  };
}

export function getDefaultWorkerId(
  env: EnvRecord = Bun.env as EnvRecord,
): string {
  return env["HOOKA_WORKER_ID"] ?? env["HOSTNAME"] ?? "hooka-worker";
}

export function getWorkerFreshnessThresholdMs(
  heartbeatIntervalMs = defaultWorkerHeartbeatIntervalMs,
): number {
  return heartbeatIntervalMs * 2;
}

export function getWorkerLastSeenAgeMs(
  lastSeenAt: string,
  nowMs = Date.now(),
): number {
  const parsed = Date.parse(lastSeenAt);

  if (Number.isNaN(parsed)) {
    return Number.POSITIVE_INFINITY;
  }

  return Math.max(0, nowMs - parsed);
}

export function getWorkerFreshness(
  lastSeenAt: string,
  heartbeatIntervalMs = defaultWorkerHeartbeatIntervalMs,
  nowMs = Date.now(),
): WorkerFreshness {
  return getWorkerLastSeenAgeMs(lastSeenAt, nowMs) <=
    getWorkerFreshnessThresholdMs(heartbeatIntervalMs)
    ? "healthy"
    : "stale";
}

export function createServerConfig(
  input: { cwd?: string; env?: EnvRecord } = {},
): ServerConfig {
  const cwd = input.cwd ?? process.cwd();
  const env = input.env ?? (Bun.env as EnvRecord);

  return serverConfigSchema.parse({
    port: parseNumberEnv(env["HOOKA_PORT"], defaultServerPort, "HOOKA_PORT"),
    dbPath: env["HOOKA_DB_PATH"] ?? getDefaultLocalDbPath(cwd),
    runtimeRole: env["HOOKA_RUNTIME_ROLE"] ?? "hooka-server",
    webhookSecret: env["HOOKA_WEBHOOK_SECRET"] || undefined,
    adminToken: env["HOOKA_ADMIN_TOKEN"] || undefined,
    maxAttempts: parseNumberEnv(
      env["HOOKA_RUN_MAX_ATTEMPTS"],
      defaultRunMaxAttempts,
      "HOOKA_RUN_MAX_ATTEMPTS",
    ),
    trustProxy: parseBooleanEnv(
      env["HOOKA_TRUST_PROXY"],
      false,
      "HOOKA_TRUST_PROXY",
    ),
    rateLimitWindowMs: parseNumberEnv(
      env["HOOKA_RATE_LIMIT_WINDOW_MS"],
      defaultRateLimitWindowMs,
      "HOOKA_RATE_LIMIT_WINDOW_MS",
    ),
    apiRateLimit: parseNumberEnv(
      env["HOOKA_RATE_LIMIT_API_LIMIT"],
      defaultApiRateLimit,
      "HOOKA_RATE_LIMIT_API_LIMIT",
    ),
    webhookRateLimit: parseNumberEnv(
      env["HOOKA_RATE_LIMIT_WEBHOOK_LIMIT"],
      defaultWebhookRateLimit,
      "HOOKA_RATE_LIMIT_WEBHOOK_LIMIT",
    ),
    globalApiRateLimit: parseNumberEnv(
      env["HOOKA_RATE_LIMIT_GLOBAL_API_LIMIT"],
      defaultGlobalApiRateLimit,
      "HOOKA_RATE_LIMIT_GLOBAL_API_LIMIT",
    ),
    globalWebhookRateLimit: parseNumberEnv(
      env["HOOKA_RATE_LIMIT_GLOBAL_WEBHOOK_LIMIT"],
      defaultGlobalWebhookRateLimit,
      "HOOKA_RATE_LIMIT_GLOBAL_WEBHOOK_LIMIT",
    ),
    corsOrigins: parseCsvEnv(env["HOOKA_CORS_ORIGINS"]),
    maxBodyBytes: parseNumberEnv(
      env["HOOKA_MAX_BODY_BYTES"],
      defaultMaxBodyBytes,
      "HOOKA_MAX_BODY_BYTES",
    ),
    capabilityManifestPath: getDefaultManifestPath(cwd, env),
    targetsPath: getDefaultTargetsPath(cwd, env),
    uiDistDir: resolve(cwd, "packages/admin-ui/dist"),
  });
}

export function createWorkerConfig(
  input: { cwd?: string; env?: EnvRecord } = {},
): WorkerConfig {
  const cwd = input.cwd ?? process.cwd();
  const env = input.env ?? (Bun.env as EnvRecord);

  return workerConfigSchema.parse({
    dbPath: env["HOOKA_DB_PATH"] ?? getDefaultLocalDbPath(cwd),
    runtimeRole: env["HOOKA_RUNTIME_ROLE"] ?? "hooka-worker",
    manifestPath: getDefaultManifestPath(cwd, env),
    targetsPath: getDefaultTargetsPath(cwd, env),
    workerId: getDefaultWorkerId(env),
    pollIntervalMs: parseNumberEnv(
      env["HOOKA_POLL_INTERVAL_MS"],
      defaultWorkerPollIntervalMs,
      "HOOKA_POLL_INTERVAL_MS",
    ),
    leaseMs: parseNumberEnv(
      env["HOOKA_RUN_LEASE_MS"],
      defaultRunLeaseMs,
      "HOOKA_RUN_LEASE_MS",
    ),
    maxAttempts: parseNumberEnv(
      env["HOOKA_RUN_MAX_ATTEMPTS"],
      defaultRunMaxAttempts,
      "HOOKA_RUN_MAX_ATTEMPTS",
    ),
    retryBaseDelayMs: parseNumberEnv(
      env["HOOKA_RETRY_BASE_DELAY_MS"],
      defaultRetryBaseDelayMs,
      "HOOKA_RETRY_BASE_DELAY_MS",
    ),
    heartbeatIntervalMs: parseNumberEnv(
      env["HOOKA_WORKER_HEARTBEAT_MS"],
      defaultWorkerHeartbeatIntervalMs,
      "HOOKA_WORKER_HEARTBEAT_MS",
    ),
    retentionRunDays: parseNumberEnv(
      env["HOOKA_RETENTION_RUN_DAYS"],
      defaultRetentionRunDays,
      "HOOKA_RETENTION_RUN_DAYS",
    ),
    retentionAuditDays: parseNumberEnv(
      env["HOOKA_RETENTION_AUDIT_DAYS"],
      defaultRetentionAuditDays,
      "HOOKA_RETENTION_AUDIT_DAYS",
    ),
    retentionSweepIntervalHours: parseNumberEnv(
      env["HOOKA_RETENTION_SWEEP_INTERVAL_HOURS"],
      defaultRetentionSweepIntervalHours,
      "HOOKA_RETENTION_SWEEP_INTERVAL_HOURS",
    ),
  });
}

export function createCliConfig(
  input: { cwd?: string; env?: EnvRecord } = {},
): CliConfig {
  const cwd = input.cwd ?? process.cwd();
  const env = input.env ?? (Bun.env as EnvRecord);

  return cliConfigSchema.parse({
    dbPath: env["HOOKA_DB_PATH"] ?? getDefaultLocalDbPath(cwd),
    manifestPath: getDefaultManifestPath(cwd, env),
    targetsPath: getDefaultTargetsPath(cwd, env),
    retentionRunDays: parseNumberEnv(
      env["HOOKA_RETENTION_RUN_DAYS"],
      defaultRetentionRunDays,
      "HOOKA_RETENTION_RUN_DAYS",
    ),
    retentionAuditDays: parseNumberEnv(
      env["HOOKA_RETENTION_AUDIT_DAYS"],
      defaultRetentionAuditDays,
      "HOOKA_RETENTION_AUDIT_DAYS",
    ),
  });
}

export function createAdminUiDevConfig(
  input: { env?: EnvRecord } = {},
): AdminUiDevConfig {
  const env = input.env ?? (Bun.env as EnvRecord);

  return adminUiDevConfigSchema.parse({
    uiPort: parseNumberEnv(
      env["HOOKA_UI_PORT"],
      defaultUiPort,
      "HOOKA_UI_PORT",
    ),
    apiOrigin: env["HOOKA_UI_API_ORIGIN"] ?? defaultUiApiOrigin,
  });
}

function parseNumberEnv(
  raw: string | undefined,
  fallback: number,
  envName: string,
): number {
  if (!raw || raw.trim().length === 0) {
    return fallback;
  }

  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid numeric value for ${envName}: ${raw}`);
  }

  return parsed;
}

function parseBooleanEnv(
  raw: string | undefined,
  fallback: boolean,
  envName: string,
): boolean {
  if (!raw || raw.trim().length === 0) {
    return fallback;
  }

  const normalized = raw.trim().toLowerCase();
  if (normalized === "true" || normalized === "1") {
    return true;
  }

  if (normalized === "false" || normalized === "0") {
    return false;
  }

  throw new Error(
    `Invalid boolean value for ${envName}: ${raw}. Use true/false or 1/0.`,
  );
}

function parseCsvEnv(raw: string | undefined): string[] {
  if (!raw || raw.trim().length === 0) {
    return [];
  }

  return raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

export function getServerStartupIssues(config: ServerConfig): string[] {
  const issues: string[] = [];

  if (!config.webhookSecret) {
    issues.push("HOOKA_WEBHOOK_SECRET is required.");
  }

  if (!config.adminToken) {
    issues.push("HOOKA_ADMIN_TOKEN is required.");
  }

  return issues;
}

export function assertServerStartupConfig(config: ServerConfig): void {
  const issues = getServerStartupIssues(config);

  if (issues.length > 0) {
    throw new Error(issues.join(" "));
  }
}
