import { expect, test } from "bun:test";
import { createTempDir } from "@hooka/bun-utils";
import { join } from "node:path";
import {
  createTarget,
  createTargetScaffold,
  deleteTarget,
  listTargetScaffoldTemplates,
  loadTargets,
  validateTargetPolicyInput,
  updateTarget,
} from "./index";

test("target scaffolds produce valid built-in templates", () => {
  expect(listTargetScaffoldTemplates().map((template) => template.id)).toEqual([
    "shared-volume-pages",
    "cache-purge-urls",
    "rclone-copy-remote",
    "export-verify",
    "generic",
  ]);

  expect(createTargetScaffold("shared-volume-pages")).toMatchObject({
    id: "cf-pages-default",
    taskId: "deploy.shared-volume.wrangler",
    presetId: "cf-pages",
    policy: {
      artifactReadiness: {
        mode: "quiet-period",
      },
    },
  });
  expect(createTargetScaffold("cache-purge-urls")).toMatchObject({
    id: "cf-cache-default",
    taskId: "cloudflare.cache.purge.urls",
    presetId: "cf-cache",
  });
  expect(createTargetScaffold("rclone-copy-remote")).toMatchObject({
    id: "rclone-copy-default",
    taskId: "rclone.copy.directory",
    presetId: "rclone-sync",
    policy: {
      allowedDestinationPrefixes: ["change-me:bucket/path"],
    },
  });
  expect(createTargetScaffold("export-verify")).toMatchObject({
    id: "wp-export-verify",
    taskId: "wordpress.export.verify",
    presetId: "wp-ops",
  });
  expect(
    createTargetScaffold("generic", {
      id: "custom-target",
      title: "Custom Target",
      presetId: "cf-pages",
      source: "target.custom",
    }),
  ).toMatchObject({
    id: "custom-target",
    title: "Custom Target",
    presetId: "cf-pages",
    source: "target.custom",
  });
});

test("target CRUD writes atomically and reloads from disk", async () => {
  const tempDir = await createTempDir("hooka-targets");
  const targetsPath = join(tempDir, ".hooka", "targets.json");

  await createTarget(targetsPath, {
    id: "pages-main",
    title: "Pages Main",
    taskId: "deploy.shared-volume.wrangler",
    source: "target.cloudflare-pages",
    maxAttempts: 3,
    defaultInput: {
      kind: "pages-deploy",
      project: "main-site",
      sourcePath: "/shared-source/main-site",
    },
    policy: {
      allowedProjects: ["main-site"],
      allowedSourceRoots: ["/shared-source"],
      allowedDestinationPrefixes: [],
      allowedBranches: ["main"],
      allowedOverrideFields: [],
      requiredEnv: [],
      artifactReadiness: {
        mode: "none",
      },
    },
  });

  await updateTarget(targetsPath, "pages-main", {
    id: "pages-main",
    title: "Pages Main",
    taskId: "deploy.shared-volume.wrangler",
    source: "target.cloudflare-pages",
    maxAttempts: 4,
    defaultInput: {
      kind: "pages-deploy",
      project: "main-site",
      sourcePath: "/shared-source/main-site",
      branch: "main",
    },
    policy: {
      allowedProjects: ["main-site"],
      allowedSourceRoots: ["/shared-source"],
      allowedDestinationPrefixes: [],
      allowedBranches: ["main"],
      allowedOverrideFields: ["branch"],
      requiredEnv: [],
      artifactReadiness: {
        mode: "none",
      },
    },
  });

  let targets = await loadTargets(targetsPath);
  expect(targets).toHaveLength(1);
  expect(targets[0]).toMatchObject({
    id: "pages-main",
    maxAttempts: 4,
  });

  await deleteTarget(targetsPath, "pages-main");
  targets = await loadTargets(targetsPath);
  expect(targets).toEqual([]);
});

test("target CRUD rejects duplicate ids and missing targets", async () => {
  const tempDir = await createTempDir("hooka-targets-errors");
  const targetsPath = join(tempDir, ".hooka", "targets.json");

  const target = {
    id: "pages-main",
    title: "Pages Main",
    taskId: "deploy.shared-volume.wrangler",
    source: "target.cloudflare-pages",
    maxAttempts: 3,
    defaultInput: {},
    policy: {
      allowedProjects: [],
      allowedSourceRoots: [],
      allowedDestinationPrefixes: [],
      allowedBranches: [],
      allowedOverrideFields: [],
      requiredEnv: [],
      artifactReadiness: {
        mode: "none" as const,
      },
    },
  };

  await createTarget(targetsPath, target);

  await expect(createTarget(targetsPath, target)).rejects.toThrow(
    "Target already exists: pages-main",
  );
  await expect(deleteTarget(targetsPath, "missing")).rejects.toThrow(
    "Target not found: missing",
  );
  await expect(
    updateTarget(targetsPath, "missing", {
      ...target,
      id: "missing",
    }),
  ).rejects.toThrow("Target not found: missing");
});

test("target policy validation accepts allowed destination prefixes and rejects others", () => {
  const target = createTargetScaffold("rclone-copy-remote");

  expect(
    validateTargetPolicyInput(target, {
      sourcePath: "/shared-source/build",
      destination: "change-me:bucket/path/site",
    }),
  ).toEqual([]);

  expect(
    validateTargetPolicyInput(target, {
      sourcePath: "/shared-source/build",
      destination: "other-remote:bucket/site",
    }),
  ).toEqual([
    expect.objectContaining({
      code: "target_destination_disallowed",
    }),
  ]);
});
