import { ensureParentDir } from "@hooka/bun-utils";
import { resolveHookaProjectRoot } from "@hooka/config";
import type { InstalledCapabilitiesManifest } from "@hooka/contracts";
import { createCliConfig } from "@hooka/config";
import { createRunStore, type RunStore } from "@hooka/run-store";
import { join } from "node:path";
import { z } from "zod";

export interface CliDefaults {
  dbPath: string;
  manifestPath: string;
  targetsPath: string;
}

export const cliDefaults: CliDefaults = createCliConfig();
export const booleanFlagSchema = z
  .preprocess((value) => (value === "" ? true : value), z.coerce.boolean())
  .default(false);

export function resolveBooleanFlag(
  parsedValue: boolean,
  flagName: string,
): boolean {
  return (
    parsedValue ||
    Bun.argv.includes(flagName) ||
    Bun.argv.some((argument) => argument.startsWith(`${flagName}=`))
  );
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
