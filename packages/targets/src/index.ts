import type {
  Target,
  TargetPolicy,
  TargetedTaskWebhook,
  TargetsFile,
} from "@hooka/contracts";
import {
  targetSchema,
  targetsFileSchema,
  type TargetArtifactReadiness,
} from "@hooka/contracts";
import { ensureParentDir } from "@hooka/bun-utils";
import { rename } from "node:fs/promises";
import { join, normalize } from "node:path/posix";

const targetWriteLocks = new Map<string, Promise<void>>();

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
      throw new Error(`Target already exists: ${parsed.id}`);
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
      throw new Error(
        `Target id mismatch: path id ${targetId} does not match body id ${parsed.id}.`,
      );
    }

    const index = file.targets.findIndex(
      (candidate) => candidate.id === targetId,
    );

    if (index < 0) {
      throw new Error(`Target not found: ${targetId}`);
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
      throw new Error(`Target not found: ${targetId}`);
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
): TargetPreflightIssue[] {
  const issues: TargetPreflightIssue[] = [];
  const project = asTrimmedString(input["project"]);
  const sourcePath = asTrimmedString(input["sourcePath"]);
  const branch = asTrimmedString(input["branch"]);

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
        isPathWithin(normalizedPath, normalize(root)),
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

  issues.push(
    ...validateRequiredEnv(
      target.policy,
      Bun.env as Record<string, string | undefined>,
    ),
  );

  return issues;
}

export async function validateArtifactReadiness(
  input: Record<string, unknown>,
  readiness: TargetArtifactReadiness,
): Promise<TargetPreflightIssue[]> {
  if (readiness.mode === "none") {
    return [];
  }

  const sourcePath = asTrimmedString(input["sourcePath"]);

  if (!sourcePath) {
    return [
      {
        code: "artifact_source_missing",
        message: "Artifact readiness checks require input.sourcePath.",
        retryable: false,
      },
    ];
  }

  if (readiness.mode === "marker-file") {
    const markerPath = join(sourcePath, readiness.markerFile);
    const markerFile = Bun.file(markerPath);

    if (!(await markerFile.exists())) {
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

  const source = Bun.file(sourcePath);

  if (!(await source.exists())) {
    return [
      {
        code: "artifact_source_missing",
        message: `Artifact source path not found: ${sourcePath}`,
        retryable: true,
      },
    ];
  }

  const stat = await source.stat();
  const ageMs = Date.now() - stat.mtimeMs;

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
  return candidate === root || candidate.startsWith(`${root}/`);
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
