import { expect, test } from "bun:test";
import { join } from "node:path";
import { exportVerifyTask } from "./index";

test("exportVerifyTask dry run skips filesystem scanning", async () => {
  if (exportVerifyTask.executor.kind !== "internal") {
    throw new Error("exportVerifyTask should use the internal executor.");
  }

  const result = await exportVerifyTask.executor.run({
    input: {
      exportDir: "/shared-source/simply-static",
      pattern: "**/*.html",
    },
    dryRun: true,
    env: {},
  });

  expect(result).toEqual({
    exportDir: "/shared-source/simply-static",
    htmlFiles: 0,
    dryRun: true,
  });
});

test("exportVerifyTask counts matching HTML files", async () => {
  if (exportVerifyTask.executor.kind !== "internal") {
    throw new Error("exportVerifyTask should use the internal executor.");
  }

  const tempDir = join(
    Bun.env.TMPDIR ?? "/tmp",
    `hooka-export-verify-${crypto.randomUUID()}`,
  );

  await Bun.$`mkdir -p ${join(tempDir, "nested")}`.quiet();
  await Bun.write(join(tempDir, "index.html"), "<html></html>");
  await Bun.write(join(tempDir, "nested", "about.html"), "<html></html>");
  await Bun.write(join(tempDir, "nested", "notes.txt"), "ignore me");

  try {
    const result = await exportVerifyTask.executor.run({
      input: {
        exportDir: tempDir,
        pattern: "**/*.html",
      },
      dryRun: false,
      env: {},
    });

    expect(result).toEqual({
      exportDir: tempDir,
      htmlFiles: 2,
    });
  } finally {
    await Bun.$`rm -rf ${tempDir}`.quiet();
  }
});
