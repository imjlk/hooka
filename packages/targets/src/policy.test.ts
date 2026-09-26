import { expect, test } from "bun:test";
import { createTempDir, removeDir } from "@hooka/bun-utils";
import { chmod, mkdir, realpath, symlink, utimes } from "node:fs/promises";
import { join } from "node:path";
import {
  createTargetScaffold,
  validateArtifactReadiness,
  validateTargetPolicyInput,
  validateTargetPreflight,
} from "./index";

test("destination prefixes only match on a path boundary", () => {
  const target = createTargetScaffold("rclone-copy-remote");
  const check = (destination: string) =>
    validateTargetPolicyInput(target, {
      sourcePath: "/shared-source/build",
      destination,
    }).map((issue) => issue.code);

  expect(check("change-me:bucket/path")).toEqual([]);
  expect(check("change-me:bucket/path/site")).toEqual([]);
  expect(check("change-me:bucket/path-other")).toEqual([
    "target_destination_disallowed",
  ]);
  expect(check("change-me:bucket/path/../other")).toEqual([
    "target_destination_disallowed",
  ]);

  const wholeRemote = {
    ...target,
    policy: {
      ...target.policy,
      allowedDestinationPrefixes: ["backup:"],
    },
  };
  expect(
    validateTargetPolicyInput(wholeRemote, {
      sourcePath: "/shared-source/build",
      destination: "backup:any/bucket",
    }),
  ).toEqual([]);
});

test("source roots with a trailing slash still allow paths inside them", () => {
  const target = createTargetScaffold("shared-volume-pages");
  const withTrailingSlash = {
    ...target,
    policy: {
      ...target.policy,
      allowedSourceRoots: ["/shared-source/"],
    },
  };

  expect(
    validateTargetPolicyInput(withTrailingSlash, {
      project: "change-me",
      sourcePath: "/shared-source/simply-static",
      branch: "main",
    }),
  ).toEqual([]);
  expect(
    validateTargetPolicyInput(withTrailingSlash, {
      project: "change-me",
      sourcePath: "/shared-source-other/site",
      branch: "main",
    }).map((issue) => issue.code),
  ).toEqual(["target_source_disallowed"]);
});

test("policies read the source path from the field the task declares", () => {
  const target = createTargetScaffold("export-verify");

  // The export-verify scaffold constrains `exportDir`, which it used to
  // reject on every run because the check only looked at `sourcePath`.
  expect(
    validateTargetPolicyInput(target, target.defaultInput, {
      sourcePath: "exportDir",
    }),
  ).toEqual([]);
  expect(
    validateTargetPolicyInput(
      target,
      { exportDir: "/etc" },
      { sourcePath: "exportDir" },
    ).map((issue) => issue.code),
  ).toEqual(["target_source_disallowed"]);
});

test("preflight rejects source paths that escape the root through a symlink", async () => {
  const tempDir = await createTempDir("hooka-target-symlink");
  const root = join(tempDir, "shared-source");
  const outside = join(tempDir, "outside");

  try {
    await mkdir(join(root, "site"), { recursive: true });
    await mkdir(outside, { recursive: true });
    await symlink(outside, join(root, "escape"));

    const target = createTargetScaffold("shared-volume-pages");
    const policyTarget = {
      ...target,
      policy: {
        ...target.policy,
        allowedSourceRoots: [root],
        artifactReadiness: { mode: "none" as const },
      },
    };
    const inputFor = (sourcePath: string) => ({
      project: "change-me",
      sourcePath,
      branch: "main",
    });

    expect(
      (
        await validateTargetPreflight(
          policyTarget,
          inputFor(join(root, "site")),
        )
      ).issues,
    ).toEqual([]);
    expect(
      (
        await validateTargetPreflight(
          policyTarget,
          inputFor(join(root, "not-yet-exported")),
        )
      ).issues,
    ).toEqual([]);
    expect(
      (
        await validateTargetPreflight(
          policyTarget,
          inputFor(join(root, "escape")),
        )
      ).issues.map((issue) => issue.code),
    ).toEqual(["target_source_disallowed"]);
  } finally {
    await removeDir(tempDir);
  }
});

test("readiness checks report unusable sources instead of throwing", async () => {
  const tempDir = await createTempDir("hooka-target-readiness-errors");
  const exportZip = join(tempDir, "export.zip");
  const exportDir = join(tempDir, "export");
  const lockedDir = join(exportDir, "locked");

  try {
    await Bun.write(exportZip, "zip");
    await mkdir(lockedDir, { recursive: true });

    expect(
      await validateArtifactReadiness(
        { sourcePath: exportZip },
        { mode: "required-files", requiredFiles: ["index.html"] },
      ),
    ).toEqual([
      expect.objectContaining({
        code: "artifact_source_not_directory",
        retryable: false,
      }),
    ]);

    await chmod(lockedDir, 0o000);
    const issues = await validateArtifactReadiness(
      { sourcePath: exportDir },
      { mode: "quiet-period", quietPeriodMs: 0, recursive: true },
    );
    // Root can still read the directory, so only assert the non-throwing contract there.
    if (process.getuid?.() !== 0) {
      expect(issues).toEqual([
        expect.objectContaining({
          code: "artifact_source_unreadable",
          retryable: false,
        }),
      ]);
    }
  } finally {
    await chmod(lockedDir, 0o755).catch(() => {});
    await removeDir(tempDir);
  }
});

test("preflight hands the task the canonical path it checked", async () => {
  const tempDir = await createTempDir("hooka-target-canonical");
  const root = join(tempDir, "shared-source");
  const releaseDir = join(root, "releases", "42");

  try {
    await mkdir(releaseDir, { recursive: true });
    await symlink(releaseDir, join(root, "current"));

    const target = createTargetScaffold("shared-volume-pages");
    const result = await validateTargetPreflight(
      {
        ...target,
        policy: {
          ...target.policy,
          allowedSourceRoots: [root],
          artifactReadiness: { mode: "none" as const },
        },
      },
      {
        project: "change-me",
        sourcePath: join(root, "current"),
        branch: "main",
      },
    );

    // Re-pointing `current` after the check can no longer redirect the task.
    expect(result.issues).toEqual([]);
    expect(result.input["sourcePath"]).toBe(await realpath(releaseDir));
    expect(result.input["project"]).toBe("change-me");
  } finally {
    await removeDir(tempDir);
  }
});

test("quiet-period scans skip dangling symlinks in the export", async () => {
  const tempDir = await createTempDir("hooka-target-dangling");
  const exportDir = join(tempDir, "export");

  try {
    await mkdir(exportDir, { recursive: true });
    await Bun.write(join(exportDir, "index.html"), "<html></html>");
    await symlink(join(tempDir, "missing"), join(exportDir, "dangling"));
    const anHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    await utimes(join(exportDir, "index.html"), anHourAgo, anHourAgo);
    await utimes(exportDir, anHourAgo, anHourAgo);

    expect(
      await validateArtifactReadiness(
        { sourcePath: exportDir },
        { mode: "quiet-period", quietPeriodMs: 0, recursive: true },
      ),
    ).toEqual([]);
  } finally {
    await removeDir(tempDir);
  }
});
