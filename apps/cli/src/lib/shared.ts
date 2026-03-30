import { ensureParentDir } from "@hooka/bun-utils";
import { createCliConfig } from "@hooka/config";
import { createRunStore, type RunStore } from "@hooka/run-store";

export interface CliDefaults {
  dbPath: string;
  manifestPath: string;
}

export const cliDefaults: CliDefaults = createCliConfig();

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
