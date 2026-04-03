import { expect, test } from "bun:test";
import { createTempDir } from "@hooka/bun-utils";
import { join } from "node:path";
import { createTarget, deleteTarget, loadTargets, updateTarget } from "./index";

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
