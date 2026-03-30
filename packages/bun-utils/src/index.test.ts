import { expect, test } from "bun:test";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import {
  createTempDir,
  ensureDir,
  ensureParentDir,
  getEnv,
  getEnvOrDefault,
  getNumberEnv,
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
  await expect(removeDir("/")).rejects.toThrow(
    "Refusing to remove dangerous path",
  );
  await expect(removeDir(".")).rejects.toThrow(
    "Refusing to remove dangerous path",
  );
});

test("removeDir removes safe directories", async () => {
  const tempDir = await createTempDir("hooka-remove-dir", getTempRootDir());
  const childDir = join(tempDir, "child");

  await ensureDir(childDir);
  expect((await stat(childDir)).isDirectory()).toBe(true);

  await removeDir(tempDir);
  expect(await Bun.file(tempDir).exists()).toBe(false);
});

test("env helpers read strings and numeric defaults from Bun-style env records", () => {
  const env = {
    HOOKA_NAME: "hooka",
    HOOKA_PORT: "4310",
    EMPTY: "",
  };

  expect(getEnv("HOOKA_NAME", env)).toBe("hooka");
  expect(getEnv("MISSING", env)).toBeUndefined();
  expect(getEnvOrDefault("MISSING", "fallback", env)).toBe("fallback");
  expect(getNumberEnv("HOOKA_PORT", 3000, env)).toBe(4310);
  expect(getNumberEnv("EMPTY", 3000, env)).toBe(3000);
});
