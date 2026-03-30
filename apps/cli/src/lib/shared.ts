import { ensureParentDir, getEnvOrDefault } from "@hooka/bun-utils";
import { defaultHookaDbPath } from "@hooka/run-store";
import { getDefaultManifestPath } from "@hooka/runner-core";

export interface CliDefaults {
  dbPath: string;
  manifestPath: string;
}

export const cliDefaults: CliDefaults = {
  manifestPath: getDefaultManifestPath(),
  dbPath: getEnvOrDefault("HOOKA_DB_PATH", defaultHookaDbPath),
};

export function parseFeatureList(value: string): string[] {
  return value
    .split(",")
    .map((feature) => feature.trim())
    .filter(Boolean);
}

export async function ensureParentDirectory(path: string): Promise<void> {
  await ensureParentDir(path);
}
