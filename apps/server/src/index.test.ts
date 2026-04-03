import { expect, test } from "bun:test";
import { createTempDir } from "@hooka/bun-utils";
import { join } from "node:path";

const bunBinary = process.execPath;
const repoRoot = process.cwd();
const serverEntry = join(repoRoot, "apps/server/src/index.ts");

test("server exits non-zero when HOOKA_WEBHOOK_SECRET is missing", async () => {
  const tempDir = await createTempDir("hooka-server-startup");
  const dbPath = join(tempDir, "hooka.sqlite");
  const processResult = Bun.spawn([bunBinary, "run", serverEntry], {
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...Bun.env,
      HOOKA_DB_PATH: dbPath,
      HOOKA_WEBHOOK_SECRET: "",
    },
  });

  const [exitCode, stderr] = await Promise.all([
    processResult.exited,
    new Response(processResult.stderr).text(),
  ]);

  expect(exitCode).not.toBe(0);
  expect(stderr).toContain("HOOKA_WEBHOOK_SECRET is required.");
});
