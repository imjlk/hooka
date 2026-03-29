import { ensureDir } from "@hooka/bun-utils";
import { defaultHookaDbPath } from "@hooka/run-store";
import { dirname, resolve } from "node:path";

export interface CliDefaults {
  dbPath: string;
  manifestPath: string;
}

export const cliDefaults: CliDefaults = {
  manifestPath: resolve(
    process.cwd(),
    "docker/manifests/installed-capabilities.json",
  ),
  dbPath: Bun.env.HOOKA_DB_PATH ?? defaultHookaDbPath,
};

export function parseFeatureList(value: string): string[] {
  return value
    .split(",")
    .map((feature) => feature.trim())
    .filter(Boolean);
}

export async function ensureParentDirectory(path: string): Promise<void> {
  await ensureDir(dirname(path));
}
