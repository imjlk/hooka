import { expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { createTempDir } from "@hooka/bun-utils";

// Exercise the shipped artifact, not just the TypeScript development entry.
test("bundled CLI runs without terminal UI native dependencies", async () => {
  const outdir = await createTempDir("hooka-cli-bundle");
  try {
    const build = await Bun.build({
      entrypoints: [join(import.meta.dir, "index.ts")],
      outdir,
      target: "bun",
    });
    expect(build.success).toBe(true);
    const child = Bun.spawn(
      [
        process.execPath,
        join(outdir, "index.js"),
        "image",
        "plan",
        "--preset",
        "cf-pages",
      ],
      {
        cwd: process.cwd(),
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({ presetId: "cf-pages" });
  } finally {
    await rm(outdir, { recursive: true, force: true });
  }
});
