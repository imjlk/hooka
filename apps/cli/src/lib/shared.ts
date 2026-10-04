import { join } from "node:path";
import { ensureParentDir } from "@hooka/bun-utils";
import {
  createCliConfig,
  defaultServerPort,
  defaultWorkerHeartbeatIntervalMs,
  resolveHookaProjectRoot,
} from "@hooka/config";
import type { InstalledCapabilitiesManifest } from "@hooka/contracts";
import { createRunStore, type RunStore } from "@hooka/run-store";
import { z } from "zod";
import { option } from "./command";

export interface CliDefaults {
  dbPath: string;
  manifestPath: string;
  targetsPath: string;
  retentionRunDays: number;
  retentionAuditDays: number;
}

export const cliDefaults: CliDefaults = createCliConfig();

/**
 * A boolean switch: `--json`, `--json=true`, or `--json=false`. Declaring it as
 * a flag makes Gunshi treat the bare form as `true` without consuming the next
 * argument. The previous argv scan turned `--yes=false` into `true`.
 */
export function booleanFlag(metadata: { description: string; short?: string }) {
  return option(z.boolean().default(false), {
    ...metadata,
    argumentKind: "flag",
  });
}

/**
 * Default server URL for client commands. Only reads `HOOKA_PORT`, so an
 * invalid server-only setting cannot break unrelated CLI commands.
 */
export function resolveDefaultServerUrl(
  env: Record<string, string | undefined> = Bun.env,
): string {
  const port = Number(env["HOOKA_PORT"]);
  return `http://127.0.0.1:${Number.isInteger(port) && port > 0 ? port : defaultServerPort}`;
}

export function resolveDefaultHeartbeatIntervalMs(
  env: Record<string, string | undefined> = Bun.env,
): number {
  const intervalMs = Number(env["HOOKA_WORKER_HEARTBEAT_MS"]);
  return Number.isInteger(intervalMs) && intervalMs > 0
    ? intervalMs
    : defaultWorkerHeartbeatIntervalMs;
}

export function parseFeatureList(value: string): string[] {
  return value
    .split(",")
    .map((feature) => feature.trim())
    .filter(Boolean);
}

export async function ensureParentDirectory(path: string): Promise<void> {
  await ensureParentDir(path);
}

export async function withClosable<T, TResource extends { close(): void }>(
  resource: Promise<TResource> | TResource,
  handler: (resource: TResource) => Promise<T> | T,
): Promise<T> {
  const closable = await resource;

  try {
    return await handler(closable);
  } finally {
    closable.close();
  }
}

export async function withRunStore<T>(
  dbPath: string,
  handler: (runStore: RunStore) => Promise<T> | T,
): Promise<T> {
  return withClosable(
    createRunStore({
      dbPath,
    }),
    handler,
  );
}

export function resolveCliSourceRoot(): string {
  return resolveHookaProjectRoot(import.meta.dir);
}

export function createInstalledCapabilitiesManifest(input: {
  image: string;
  installed: string[];
}): InstalledCapabilitiesManifest {
  return {
    image: input.image,
    generatedAt: new Date().toISOString(),
    installed: [...new Set(input.installed)],
  };
}

export async function writeInstalledCapabilitiesManifest(
  manifestPath: string,
  manifest: InstalledCapabilitiesManifest,
): Promise<void> {
  await ensureParentDirectory(manifestPath);
  await Bun.write(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

export function getDefaultSharedSourcePath(cwd = process.cwd()): string {
  return join(cwd, ".hooka/shared-source/simply-static");
}
