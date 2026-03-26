import { join } from "node:path";

export function getTempRootDir(): string {
  return Bun.env.TMPDIR ?? Bun.env.TEMP ?? "/tmp";
}

export async function ensureDir(path: string): Promise<void> {
  await Bun.$`mkdir -p ${path}`.quiet();
}

export async function removeDir(path: string): Promise<void> {
  await Bun.$`rm -rf ${path}`.quiet();
}

export async function createTempDir(
  prefix: string,
  baseDir = getTempRootDir(),
): Promise<string> {
  const path = join(
    baseDir,
    `${prefix}-${Date.now()}-${crypto.randomUUID()}`,
  );
  await ensureDir(path);
  return path;
}

export async function readTextFile(path: string): Promise<string> {
  return Bun.file(path).text();
}
