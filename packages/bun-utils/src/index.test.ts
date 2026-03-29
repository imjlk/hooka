import { expect, test } from "bun:test";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import {
  createTempDir,
  ensureDir,
  ensureParentDir,
  getTempRootDir,
  removeDir,
} from "./index";

test("ensureParentDir creates the parent directory", async () => {
  const tempDir = await createTempDir("hooka-bun-utils");
  const nestedFile = join(tempDir, "nested", "path", "file.txt");

  try {
    await ensureParentDir(nestedFile);

    expect((await stat(join(tempDir, "nested", "path"))).isDirectory()).toBe(
      true,
    );
  } finally {
    await removeDir(tempDir);
  }
});

test("removeDir rejects dangerous paths", async () => {
  await expect(removeDir("/")).rejects.toThrow("Refusing to remove dangerous path");
  await expect(removeDir(".")).rejects.toThrow("Refusing to remove dangerous path");
});

test("removeDir removes safe directories", async () => {
  const tempDir = await createTempDir("hooka-remove-dir", getTempRootDir());
  const childDir = join(tempDir, "child");

  await ensureDir(childDir);
  expect((await stat(childDir)).isDirectory()).toBe(true);

  await removeDir(tempDir);
  expect(await Bun.file(tempDir).exists()).toBe(false);
});
