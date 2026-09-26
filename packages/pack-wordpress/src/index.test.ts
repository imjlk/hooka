import { expect, test } from "bun:test";
import { join } from "node:path";
import { runTask } from "@hooka/runner-core";
import { exportVerifyTask, wpcliEvalTask } from "./index";

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
    Bun.env["TMPDIR"] ?? "/tmp",
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

test("wpcliEvalTask passes WP-CLI global parameters in --key=value form", async () => {
  const result = await runTask(
    wpcliEvalTask,
    {
      path: "/var/www/html",
      user: "admin",
      code: "echo home_url();",
    },
    {
      dryRun: true,
    },
  );

  expect(result.command).toEqual([
    "wp",
    "--path=/var/www/html",
    "--user=admin",
    "eval",
    "echo home_url();",
  ]);
});

test("exportVerifyTask rejects patterns that escape exportDir", async () => {
  for (const pattern of ["../*/*.html", "/etc/**/*", "nested/../../*"]) {
    const result = await runTask(
      exportVerifyTask,
      {
        exportDir: "/shared-source/simply-static",
        pattern,
      },
      {
        dryRun: true,
      },
    );

    expect(result).toMatchObject({
      ok: false,
      retryable: false,
      errorCode: "input_invalid",
    });
  }
});

test("exportVerifyTask never counts files outside exportDir", async () => {
  if (exportVerifyTask.executor.kind !== "internal") {
    throw new Error("exportVerifyTask should use the internal executor.");
  }

  const tempDir = join(
    Bun.env["TMPDIR"] ?? "/tmp",
    `hooka-export-contain-${crypto.randomUUID()}`,
  );
  await Bun.$`mkdir -p ${join(tempDir, "export")} ${join(tempDir, "secret")}`.quiet();
  await Bun.write(join(tempDir, "export", "index.html"), "<html></html>");
  await Bun.write(join(tempDir, "secret", "leak.html"), "<html></html>");

  try {
    // Calls the executor directly, bypassing the input schema that already
    // rejects `..`, to pin the containment check itself.
    const result = await exportVerifyTask.executor.run({
      input: {
        exportDir: join(tempDir, "export"),
        pattern: "../secret/*.html",
      },
      dryRun: false,
      env: {},
    });

    expect(result).toEqual({
      exportDir: join(tempDir, "export"),
      htmlFiles: 0,
    });
  } finally {
    await Bun.$`rm -rf ${tempDir}`.quiet();
  }
});
