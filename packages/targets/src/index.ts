import type {
  Target,
  TargetPolicy,
  TargetedTaskWebhook,
  TargetsFile,
  TaskPolicyInputFields,
} from "@hooka/contracts";
import {
  targetSchema,
  targetsFileSchema,
  type TargetArtifactReadiness,
} from "@hooka/contracts";
import { ensureParentDir } from "@hooka/bun-utils";
import { readdir, rename, stat } from "node:fs/promises";
import { join, normalize } from "node:path/posix";
import { lstat, realpath } from "node:fs/promises";

const targetWriteLocks = new Map<string, Promise<void>>();

export class TargetNotFoundError extends Error {}
export class TargetConflictError extends Error {}
export class TargetValidationError extends Error {}

export const targetScaffoldTemplateIds = [
  "shared-volume-pages",
  "cache-purge-urls",
  "rclone-copy-remote",
  "export-verify",
  "generic",
] as const;

export type TargetScaffoldTemplateId =
  (typeof targetScaffoldTemplateIds)[number];

export interface TargetScaffoldTemplate {
  id: TargetScaffoldTemplateId;
  title: string;
  description: string;
}

export interface TargetScaffoldOverrides {
  id?: string;
  title?: string;
  presetId?: string;
  source?: string;
}

export interface TargetOverrideViolation {
  field: string;
  message: string;
}

export interface ResolvedTargetWebhook {
  target: Target;
  taskId: string;
  input: Record<string, unknown>;
  source: string;
  sourceEventId: string;
}

export interface TargetPreflightIssue {
  code: string;
  message: string;
  retryable: boolean;
}

function resolvePolicyInputFields(
  fields: TaskPolicyInputFields = {},
): Required<TaskPolicyInputFields> {
  return {
    sourcePath: fields.sourcePath ?? "sourcePath",
    destination: fields.destination ?? "destination",
    project: fields.project ?? "project",
    branch: fields.branch ?? "branch",
  };
}

export function listTargetScaffoldTemplates(): TargetScaffoldTemplate[] {
  return [
    {
      id: "shared-volume-pages",
      title: "Shared-volume Pages",
      description:
        "Cloudflare Pages deploys from /shared-source with branch-only style overrides.",
    },
    {
      id: "cache-purge-urls",
      title: "Cache Purge URLs",
      description:
        "Safe Cloudflare cache purge target with a fixed zone and webhook-provided URLs.",
    },
    {
      id: "rclone-copy-remote",
      title: "rclone Copy Remote",
      description:
        "Copy a worker-visible local directory to a configured rclone remote destination.",
    },
    {
      id: "export-verify",
      title: "Export Verify",
      description:
        "Verify Simply Static export output inside the shared source volume before deploy.",
    },
    {
      id: "generic",
      title: "Generic",
      description: "Blank target skeleton with current schema defaults.",
    },
  ];
}

export function createTargetScaffold(
  templateId: TargetScaffoldTemplateId = "generic",
  overrides: TargetScaffoldOverrides = {},
): Target {
  const baseTarget = getBaseTargetScaffold(templateId);

  return targetSchema.parse({
    ...baseTarget,
    id: overrides.id ?? baseTarget.id,
    title: overrides.title ?? baseTarget.title,
    presetId:
      overrides.presetId === undefined
        ? baseTarget.presetId
        : overrides.presetId,
    source: overrides.source ?? baseTarget.source,
  });
}

export async function loadTargets(targetsPath: string): Promise<Target[]> {
  return (await loadTargetsFile(targetsPath)).targets;
}

export async function loadTargetsFile(
  targetsPath: string,
): Promise<TargetsFile> {
  const file = Bun.file(targetsPath);

  if (!(await file.exists())) {
    return targetsFileSchema.parse({
      targets: [],
    });
  }

  const raw = (await file.json()) as TargetsFile | Target[];

  if (Array.isArray(raw)) {
    return targetsFileSchema.parse({
      targets: raw.map((target) => targetSchema.parse(target)),
    });
  }

  return targetsFileSchema.parse(raw);
}

export async function createTarget(
  targetsPath: string,
  target: Target,
): Promise<Target[]> {
  return withTargetFileWriteLock(targetsPath, async () => {
    const file = await loadTargetsFile(targetsPath);
    const parsed = targetSchema.parse(target);

    if (file.targets.some((candidate) => candidate.id === parsed.id)) {
      throw new TargetConflictError(`Target already exists: ${parsed.id}`);
    }

    const nextTargets = [...file.targets, parsed];
    await writeTargetsFile(targetsPath, nextTargets);
    return nextTargets;
  });
}

export async function updateTarget(
  targetsPath: string,
  targetId: string,
  target: Target,
): Promise<Target[]> {
  return withTargetFileWriteLock(targetsPath, async () => {
    const file = await loadTargetsFile(targetsPath);
    const parsed = targetSchema.parse(target);

    if (parsed.id !== targetId) {
      throw new TargetValidationError(
        `Target id mismatch: path id ${targetId} does not match body id ${parsed.id}.`,
      );
    }

    const index = file.targets.findIndex(
      (candidate) => candidate.id === targetId,
    );

    if (index < 0) {
      throw new TargetNotFoundError(`Target not found: ${targetId}`);
    }

    const nextTargets = [...file.targets];
    nextTargets[index] = parsed;
    await writeTargetsFile(targetsPath, nextTargets);
    return nextTargets;
  });
}

export async function deleteTarget(
  targetsPath: string,
  targetId: string,
): Promise<Target[]> {
  return withTargetFileWriteLock(targetsPath, async () => {
    const file = await loadTargetsFile(targetsPath);
    const nextTargets = file.targets.filter((target) => target.id !== targetId);

    if (nextTargets.length === file.targets.length) {
      throw new TargetNotFoundError(`Target not found: ${targetId}`);
    }

    await writeTargetsFile(targetsPath, nextTargets);
    return nextTargets;
  });
}

export function getTarget(
  targets: Target[],
  targetId: string,
): Target | undefined {
  return targets.find((target) => target.id === targetId);
}

export function resolveTargetWebhook(
  targets: Target[],
  payload: TargetedTaskWebhook,
): ResolvedTargetWebhook {
  const target = getTarget(targets, payload.targetId);

  if (!target) {
    throw new Error(`Target not found: ${payload.targetId}`);
  }

  const overrides = normalizeOverrides(payload.overrides);
  const violations = getOverrideViolations(target, overrides);

  if (violations.length > 0) {
    throw new Error(
      `Target override rejected: ${violations
        .map((violation) => `${violation.field} (${violation.message})`)
        .join(", ")}`,
    );
  }

  return {
    target,
    taskId: target.taskId,
    input: {
      ...target.defaultInput,
      ...overrides,
    },
    source: payload.source || target.source,
    sourceEventId: payload.eventId,
  };
}

export function getOverrideViolations(
  target: Target,
  overrides: Record<string, unknown>,
): TargetOverrideViolation[] {
  const keys = Object.keys(overrides);

  if (keys.length === 0) {
    return [];
  }

  const allowed = new Set(target.policy.allowedOverrideFields);
  return keys.flatMap((key) => {
    if (allowed.has(key)) {
      return [];
    }

    return [
      {
        field: key,
        message: "Override field is not allowed by target policy.",
      },
    ];
  });
}

export function validateTargetPolicyInput(
  target: Target,
  input: Record<string, unknown>,
  fields?: TaskPolicyInputFields,
): TargetPreflightIssue[] {
  const issues: TargetPreflightIssue[] = [];
  const fieldNames = resolvePolicyInputFields(fields);
  const project = asTrimmedString(input[fieldNames.project]);
  const sourcePath = asTrimmedString(input[fieldNames.sourcePath]);
  const branch = asTrimmedString(input[fieldNames.branch]);
  const destination = asTrimmedString(input[fieldNames.destination]);

  if (
    target.policy.allowedProjects.length > 0 &&
    (!project || !target.policy.allowedProjects.includes(project))
  ) {
    issues.push({
      code: "target_project_disallowed",
      message: `Target ${target.id} does not allow project ${project ?? "(missing)"}.`,
      retryable: false,
    });
  }

  if (
    target.policy.allowedBranches.length > 0 &&
    branch &&
    !target.policy.allowedBranches.includes(branch)
  ) {
    issues.push({
      code: "target_branch_disallowed",
      message: `Target ${target.id} does not allow branch ${branch}.`,
      retryable: false,
    });
  }

  if (target.policy.allowedSourceRoots.length > 0) {
    if (!sourcePath) {
      issues.push({
        code: "target_source_missing",
        message: `Target ${target.id} requires a sourcePath inside an allowed root.`,
        retryable: false,
      });
    } else {
      const normalizedPath = normalize(sourcePath);
      const allowed = target.policy.allowedSourceRoots.some((root) =>
        isPathWithin(normalizedPath, normalizeRoot(root)),
      );

      if (!allowed) {
        issues.push({
          code: "target_source_disallowed",
          message: `Target ${target.id} does not allow sourcePath ${sourcePath}.`,
          retryable: false,
        });
      }
    }
  }

  if (target.policy.allowedDestinationPrefixes.length > 0) {
    if (!destination) {
      issues.push({
        code: "target_destination_missing",
        message: `Target ${target.id} requires a destination inside an allowed prefix.`,
        retryable: false,
      });
    } else if (
      hasParentSegment(destination) ||
      !target.policy.allowedDestinationPrefixes.some((prefix) =>
        isDestinationWithin(destination, prefix),
      )
    ) {
      issues.push({
        code: "target_destination_disallowed",
        message: `Target ${target.id} does not allow destination ${destination}.`,
        retryable: false,
      });
    }
  }

  issues.push(
    ...validateRequiredEnv(
      target.policy,
      Bun.env as Record<string, string | undefined>,
    ),
  );

  return issues;
}

/**
 * Runs every target preflight check for a claimed run: the input policy, then
 * whether an existing source path really resolves inside an allowed root (a
 * symlink inside the shared volume can point anywhere on the worker), then
 * artifact readiness.
 *
 * Returns the input the task should run with: the source path is replaced by
 * the canonical path that was checked, so re-pointing a symlink after the
 * check cannot redirect the task. Links inside the artifact tree are not
 * followed by this check.
 */
export async function validateTargetPreflight(
  target: Target,
  input: Record<string, unknown>,
  fields?: TaskPolicyInputFields,
): Promise<{
  issues: TargetPreflightIssue[];
  input: Record<string, unknown>;
}> {
  const policyIssues = validateTargetPolicyInput(target, input, fields);
  if (policyIssues.length > 0) {
    return { issues: policyIssues, input };
  }

  const containment = await validateSourcePathContainment(
    target,
    input,
    fields,
  );
  if (containment.issues.length > 0) {
    return { issues: containment.issues, input };
  }

  const checkedInput = containment.realSourcePath
    ? {
        ...input,
        [resolvePolicyInputFields(fields).sourcePath]:
          containment.realSourcePath,
      }
    : input;

  return {
    issues: await validateArtifactReadiness(
      checkedInput,
      target.policy.artifactReadiness,
      fields,
    ),
    input: checkedInput,
  };
}

async function validateSourcePathContainment(
  target: Target,
  input: Record<string, unknown>,
  fields?: TaskPolicyInputFields,
): Promise<{ issues: TargetPreflightIssue[]; realSourcePath?: string }> {
  const sourcePath = asTrimmedString(
    input[resolvePolicyInputFields(fields).sourcePath],
  );

  if (target.policy.allowedSourceRoots.length === 0 || !sourcePath) {
    return { issues: [] };
  }

  let realSourcePath: string | null;
  try {
    realSourcePath = await resolveExistingRealPath(sourcePath);
  } catch (error) {
    return {
      issues: [
        {
          code: "target_source_unresolvable",
          message: `Target ${target.id} could not resolve sourcePath ${sourcePath}: ${describeError(error)}`,
          retryable: false,
        },
      ],
    };
  }

  if (!realSourcePath) {
    // Not produced yet; artifact readiness reports a missing source.
    return { issues: [] };
  }

  const realRoots = await Promise.all(
    target.policy.allowedSourceRoots.map(async (root) => {
      try {
        return normalizeRoot(
          (await resolveExistingRealPath(root)) ?? normalize(root),
        );
      } catch {
        return normalizeRoot(root);
      }
    }),
  );

  if (realRoots.some((root) => isPathWithin(realSourcePath, root))) {
    return { issues: [], realSourcePath };
  }

  return {
    issues: [
      {
        code: "target_source_disallowed",
        message: `Target ${target.id} does not allow sourcePath ${sourcePath}: it resolves to ${realSourcePath}, outside the allowed source roots.`,
        retryable: false,
      },
    ],
  };
}

export async function validateArtifactReadiness(
  input: Record<string, unknown>,
  readiness: TargetArtifactReadiness,
  fields?: TaskPolicyInputFields,
): Promise<TargetPreflightIssue[]> {
  if (readiness.mode === "none") {
    return [];
  }

  const sourcePathField = resolvePolicyInputFields(fields).sourcePath;
  const sourcePath = asTrimmedString(input[sourcePathField]);

  if (!sourcePath) {
    return [
      {
        code: "artifact_source_missing",
        message: `Artifact readiness checks require input.${sourcePathField}.`,
        retryable: false,
      },
    ];
  }

  try {
    return await checkArtifactReadiness(sourcePath, readiness);
  } catch (error) {
    // The export changed underneath the check (a directory was replaced
    // mid-scan), or part of it is unreadable. Report it as a preflight issue
    // instead of throwing out of the worker with the run still claimed.
    const code = getErrorCode(error);
    return [
      code === "ENOENT" || code === "ENOTDIR"
        ? {
            code: "artifact_source_changed",
            message: `Artifact source ${sourcePath} changed while it was being checked.`,
            retryable: true,
          }
        : {
            code: "artifact_source_unreadable",
            message: `Artifact source ${sourcePath} could not be read: ${describeError(error)}`,
            retryable: false,
          },
    ];
  }
}

async function checkArtifactReadiness(
  sourcePath: string,
  readiness: Exclude<TargetArtifactReadiness, { mode: "none" }>,
): Promise<TargetPreflightIssue[]> {
  if (readiness.mode === "marker-file" || readiness.mode === "required-files") {
    const sourceStat = await getPathStat(sourcePath);

    if (sourceStat && !sourceStat.isDirectory()) {
      return [
        {
          code: "artifact_source_not_directory",
          message: `Artifact source ${sourcePath} must be a directory for ${readiness.mode} readiness checks.`,
          retryable: false,
        },
      ];
    }
  }

  if (readiness.mode === "marker-file") {
    const requiredFileIssues = await validateRequiredFiles(
      sourcePath,
      readiness.requiredFiles ?? [],
    );
    if (requiredFileIssues.length > 0) {
      return requiredFileIssues;
    }

    const markerPath = join(sourcePath, readiness.markerFile);

    if (!(await getPathStat(markerPath))) {
      return [
        {
          code: "artifact_marker_missing",
          message: `Artifact marker file not found: ${markerPath}`,
          retryable: true,
        },
      ];
    }

    return [];
  }

  if (readiness.mode === "required-files") {
    return validateRequiredFiles(sourcePath, readiness.requiredFiles);
  }

  const requiredFileIssues = await validateRequiredFiles(
    sourcePath,
    readiness.requiredFiles ?? [],
  );
  if (requiredFileIssues.length > 0) {
    return requiredFileIssues;
  }

  const sourceStat = await getPathStat(sourcePath);

  if (!sourceStat) {
    return [
      {
        code: "artifact_source_missing",
        message: `Artifact source path not found: ${sourcePath}`,
        retryable: true,
      },
    ];
  }

  const latestMtimeMs = await getLatestArtifactMtimeMs(
    sourcePath,
    readiness.recursive ?? false,
    sourceStat,
  );
  const ageMs = Date.now() - latestMtimeMs;

  if (ageMs < readiness.quietPeriodMs) {
    return [
      {
        code: "artifact_quiet_period_pending",
        message: `Artifact source ${sourcePath} changed too recently (${ageMs}ms ago).`,
        retryable: true,
      },
    ];
  }

  return [];
}

async function validateRequiredFiles(
  sourcePath: string,
  requiredFiles: string[],
): Promise<TargetPreflightIssue[]> {
  for (const requiredFile of requiredFiles) {
    const requiredPath = join(sourcePath, requiredFile);

    if (!(await getPathStat(requiredPath))) {
      return [
        {
          code: "artifact_required_file_missing",
          message: `Required artifact file not found: ${requiredPath}`,
          retryable: true,
        },
      ];
    }
  }

  return [];
}

async function getLatestArtifactMtimeMs(
  sourcePath: string,
  recursive: boolean,
  sourceStat: Awaited<ReturnType<typeof stat>>,
): Promise<number> {
  let latestMtimeMs = Number(sourceStat.mtimeMs);

  if (!recursive || !sourceStat.isDirectory()) {
    return latestMtimeMs;
  }

  for (const entry of await readdir(sourcePath, { withFileTypes: true })) {
    const entryPath = join(sourcePath, entry.name);
    // An entry that vanished or changed type since readdir means the export
    // is still being written: let the error reach validateArtifactReadiness,
    // which reports it as a retryable change instead of skipping the entry.
    const entryStat = await stat(entryPath).catch(async (error: unknown) => {
      const linkStat = await lstat(entryPath).catch(() => null);
      if (linkStat?.isSymbolicLink()) {
        // A dangling symlink is part of the export as written.
        return null;
      }
      throw error;
    });

    if (!entryStat) {
      continue;
    }

    const entryLatestMtimeMs = entryStat.isDirectory()
      ? await getLatestArtifactMtimeMs(entryPath, true, entryStat)
      : Number(entryStat.mtimeMs);
    latestMtimeMs = Math.max(latestMtimeMs, entryLatestMtimeMs);
  }

  return latestMtimeMs;
}

async function getPathStat(
  path: string,
): Promise<Awaited<ReturnType<typeof stat>> | null> {
  try {
    return await stat(path);
  } catch (error) {
    if (isNotFoundError(error)) {
      return null;
    }

    throw error;
  }
}

function isNotFoundError(error: unknown): boolean {
  // ENOTDIR: a path component is a file, so the path cannot exist.
  const code = getErrorCode(error);
  return code === "ENOENT" || code === "ENOTDIR";
}

function getBaseTargetScaffold(templateId: TargetScaffoldTemplateId): Target {
  switch (templateId) {
    case "shared-volume-pages":
      return targetSchema.parse({
        id: "cf-pages-default",
        title: "Cloudflare Pages Deploy",
        description: "Deploy a shared-volume Pages bundle through wrangler.",
        taskId: "deploy.shared-volume.wrangler",
        presetId: "cf-pages",
        source: "target.cloudflare-pages",
        maxAttempts: 3,
        maxConcurrentRuns: 1,
        defaultInput: {
          kind: "pages-deploy",
          project: "change-me",
          sourcePath: "/shared-source/simply-static",
          branch: "main",
        },
        policy: {
          allowedProjects: ["change-me"],
          allowedSourceRoots: ["/shared-source"],
          allowedBranches: ["main"],
          allowedOverrideFields: [
            "branch",
            "commitSha",
            "commitMessage",
            "commitDirty",
            "skipCaching",
            "noBundle",
            "uploadSourceMaps",
          ],
          requiredEnv: [],
          artifactReadiness: {
            mode: "quiet-period",
            quietPeriodMs: 3_000,
            recursive: true,
          },
        },
      });
    case "cache-purge-urls":
      return targetSchema.parse({
        id: "cf-cache-default",
        title: "Cloudflare Cache Purge",
        description: "Purge one or more URLs in a fixed Cloudflare zone.",
        taskId: "cloudflare.cache.purge.urls",
        presetId: "cf-cache",
        source: "target.cloudflare-cache",
        maxAttempts: 3,
        maxConcurrentRuns: 1,
        defaultInput: {
          zoneId: "change-me",
          urls: "https://example.com/",
        },
        policy: {
          allowedProjects: [],
          allowedSourceRoots: [],
          allowedBranches: [],
          allowedOverrideFields: ["urls"],
          requiredEnv: [],
          artifactReadiness: {
            mode: "none",
          },
        },
      });
    case "rclone-copy-remote":
      return targetSchema.parse({
        id: "rclone-copy-default",
        title: "rclone Remote Copy",
        description:
          "Copy a worker-visible local artifact directory to a configured rclone remote destination.",
        taskId: "rclone.copy.directory",
        presetId: "rclone-sync",
        source: "target.rclone-copy",
        maxAttempts: 3,
        maxConcurrentRuns: 1,
        defaultInput: {
          sourcePath: "/shared-source/simply-static",
          destination: "change-me:bucket/path",
        },
        policy: {
          allowedProjects: [],
          allowedSourceRoots: ["/shared-source"],
          allowedDestinationPrefixes: ["change-me:bucket/path"],
          allowedBranches: [],
          allowedOverrideFields: [],
          requiredEnv: [],
          artifactReadiness: {
            mode: "quiet-period",
            quietPeriodMs: 3_000,
            recursive: true,
          },
        },
      });
    case "export-verify":
      return targetSchema.parse({
        id: "wp-export-verify",
        title: "Verify Export Output",
        description:
          "Verify generated export output inside the shared source volume.",
        taskId: "wordpress.export.verify",
        presetId: "wp-ops",
        source: "target.wordpress-export",
        maxAttempts: 3,
        maxConcurrentRuns: 1,
        defaultInput: {
          exportDir: "/shared-source/simply-static",
          pattern: "**/*.html",
        },
        policy: {
          allowedProjects: [],
          allowedSourceRoots: ["/shared-source"],
          allowedDestinationPrefixes: [],
          allowedBranches: [],
          allowedOverrideFields: ["pattern"],
          requiredEnv: [],
          artifactReadiness: {
            mode: "none",
          },
        },
      });
    default:
      return targetSchema.parse({
        id: "new-target",
        title: "New Target",
        description: "Describe the deployment policy for this target.",
        taskId: "deploy.shared-volume.wrangler",
        source: "target.local",
        maxAttempts: 3,
        maxConcurrentRuns: 1,
        defaultInput: {
          kind: "pages-deploy",
          project: "change-me",
          sourcePath: "/shared-source/change-me",
          branch: "main",
        },
        policy: {
          allowedProjects: ["change-me"],
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
  }
}

function validateRequiredEnv(
  policy: TargetPolicy,
  env: Record<string, string | undefined>,
): TargetPreflightIssue[] {
  return policy.requiredEnv.flatMap((requirement) => {
    const presentNames = requirement.names.filter((name) =>
      hasEnvValue(env, name),
    );
    const missingNames = requirement.names.filter(
      (name) => !hasEnvValue(env, name),
    );

    if (requirement.match === "allOf" && missingNames.length > 0) {
      return [
        {
          code: "target_env_missing",
          message: `${requirement.description} Missing: ${missingNames.join(", ")}.`,
          retryable: false,
        },
      ];
    }

    if (requirement.match === "anyOf" && presentNames.length === 0) {
      return [
        {
          code: "target_env_missing",
          message: `${requirement.description} Provide one of: ${requirement.names.join(", ")}.`,
          retryable: false,
        },
      ];
    }

    return [];
  });
}

function normalizeOverrides(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {};
  }

  return raw as Record<string, unknown>;
}

function asTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function isPathWithin(candidate: string, root: string): boolean {
  return (
    candidate === root ||
    candidate.startsWith(root.endsWith("/") ? root : `${root}/`)
  );
}

/** `normalize` keeps a trailing slash, which made `/shared-source/` match nothing. */
function normalizeRoot(root: string): string {
  const normalized = normalize(root);
  return normalized.length > 1 ? normalized.replace(/\/+$/, "") : normalized;
}

/**
 * Prefix match on a path boundary: `remote:bucket/site` allows
 * `remote:bucket/site` and `remote:bucket/site/x`, but not
 * `remote:bucket/site-other`. Prefixes ending in `/` or `:` (a whole remote)
 * already end on a boundary.
 */
function isDestinationWithin(destination: string, prefix: string): boolean {
  if (destination === prefix) {
    return true;
  }

  const boundary =
    prefix.endsWith("/") || prefix.endsWith(":") ? prefix : `${prefix}/`;
  return destination.startsWith(boundary);
}

function hasParentSegment(value: string): boolean {
  return value.split(/[\\/:]/).includes("..");
}

async function resolveExistingRealPath(path: string): Promise<string | null> {
  try {
    return await realpath(path);
  } catch (error) {
    if (isNotFoundError(error)) {
      return null;
    }

    throw error;
  }
}

function getErrorCode(error: unknown): string | undefined {
  return typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof (error as { code?: unknown }).code === "string"
    ? (error as { code: string }).code
    : undefined;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function hasEnvValue(
  env: Record<string, string | undefined>,
  name: string,
): boolean {
  const value = env[name];
  return value !== undefined && value.trim().length > 0;
}

async function writeTargetsFile(
  targetsPath: string,
  targets: Target[],
): Promise<void> {
  const payload = JSON.stringify(
    targetsFileSchema.parse({
      targets,
    }),
    null,
    2,
  );
  const tempPath = `${targetsPath}.${crypto.randomUUID()}.tmp`;

  await ensureParentDir(targetsPath);
  await Bun.write(tempPath, `${payload}\n`);
  await rename(tempPath, targetsPath);
}

async function withTargetFileWriteLock<T>(
  targetsPath: string,
  callback: () => Promise<T>,
): Promise<T> {
  const previous = targetWriteLocks.get(targetsPath) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => current);
  targetWriteLocks.set(targetsPath, tail);

  await previous;

  try {
    return await callback();
  } finally {
    release();
    if (targetWriteLocks.get(targetsPath) === tail) {
      targetWriteLocks.delete(targetsPath);
    }
  }
}
