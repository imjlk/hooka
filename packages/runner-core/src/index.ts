import { getEnv } from "@hooka/bun-utils";
import { getDefaultManifestPath } from "@hooka/config";
import type {
  InstalledCapabilitiesManifest,
  TaskRunResult,
} from "@hooka/contracts";
import { installedCapabilitiesManifestSchema } from "@hooka/contracts";
import { runHttpTask } from "@hooka/executor-http";
import type { CommandRunner } from "@hooka/executor-process";
import { runProcessTask } from "@hooka/executor-process";
import type { HookaTask, TaskInputSchema } from "@hooka/task-sdk";
import type { z } from "zod";

export {
  defaultManifestRelativePath,
  getDefaultManifestPath,
} from "@hooka/config";

export interface RunTaskOptions {
  dryRun?: boolean;
  installedCapabilities?: string[];
  manifestPath?: string;
  commandRunner?: CommandRunner;
  env?: Record<string, string | undefined>;
}

export type InstalledCapabilitiesLoader = (
  manifestPath?: string,
) => Promise<InstalledCapabilitiesManifest>;

export function getMissingCapabilities(
  task: HookaTask,
  installedCapabilities: string[],
): string[] {
  return task.requires.filter((requirement) => {
    return !installedCapabilities.includes(requirement);
  });
}

export async function loadInstalledCapabilities(
  manifestPath = getDefaultManifestPath(),
): Promise<InstalledCapabilitiesManifest> {
  const override = parseInstalledCapabilitiesOverride();

  if (override) {
    return override;
  }

  const file = Bun.file(manifestPath);

  if (!(await file.exists())) {
    return installedCapabilitiesManifestSchema.parse({
      image: "hooka:dev",
      installed: [],
    });
  }

  const raw = await file.json();
  return installedCapabilitiesManifestSchema.parse(raw);
}

export function createInstalledCapabilitiesLoader(
  cacheTtlMs = 0,
): InstalledCapabilitiesLoader {
  const cache = new Map<
    string,
    { expiresAt: number; manifest: InstalledCapabilitiesManifest }
  >();

  return async (manifestPath = getDefaultManifestPath()) => {
    if (cacheTtlMs > 0) {
      const now = Date.now();
      const cached = cache.get(manifestPath);
      if (cached && cached.expiresAt > now) {
        return cached.manifest;
      }

      const manifest = await loadInstalledCapabilities(manifestPath);
      cache.set(manifestPath, {
        expiresAt: now + cacheTtlMs,
        manifest,
      });
      return manifest;
    }

    return loadInstalledCapabilities(manifestPath);
  };
}

function parseInstalledCapabilitiesOverride(): InstalledCapabilitiesManifest | null {
  const raw = getEnv("HOOKA_INSTALLED_CAPABILITIES")?.trim();

  if (!raw) {
    return null;
  }

  const installed = raw
    .split(",")
    .map((capability) => capability.trim())
    .filter(Boolean);

  return installedCapabilitiesManifestSchema.parse({
    image: getEnv("HOOKA_RUNTIME_ROLE") ?? "hooka:env-override",
    generatedAt: new Date().toISOString(),
    installed,
  });
}

export async function runTask<TSchema extends TaskInputSchema>(
  task: HookaTask<TSchema>,
  rawInput: unknown,
  options: RunTaskOptions = {},
): Promise<TaskRunResult> {
  const dryRun = options.dryRun ?? false;
  const env = options.env ?? (Bun.env as Record<string, string | undefined>);
  let input: z.output<TSchema>;

  try {
    input = task.input.parse(rawInput ?? {});
  } catch (error) {
    return {
      taskId: task.id,
      ok: false,
      status: "failed",
      retryable: false,
      errorCode: "input_invalid",
      stderr: error instanceof Error ? error.message : String(error),
      summary: `Invalid input for ${task.id}.`,
      durationMs: 0,
    };
  }

  const installedCapabilities =
    options.installedCapabilities ??
    (await loadInstalledCapabilities(options.manifestPath)).installed;
  const missing = getMissingCapabilities(task, installedCapabilities);
  const capabilityWarning =
    dryRun && missing.length > 0
      ? `Capability check skipped for dry run. Missing at runtime: ${missing.join(", ")}.`
      : undefined;

  if (!dryRun && missing.length > 0) {
    return {
      taskId: task.id,
      ok: false,
      status: "failed",
      retryable: false,
      errorCode: "missing_capabilities",
      summary: `Missing required capabilities: ${missing.join(", ")}.`,
      durationMs: 0,
      data: {
        missing,
      },
    };
  }

  if (task.executor.kind === "process") {
    const result = await runProcessTask(
      task,
      input as z.output<TSchema>,
      dryRun,
      {
        commandRunner: options.commandRunner,
        env,
      },
    );
    return appendCapabilityWarning(result, capabilityWarning);
  }

  if (task.executor.kind === "http") {
    const result = await runHttpTask(task, input as z.output<TSchema>, dryRun, {
      env,
    });
    return appendCapabilityWarning(result, capabilityWarning);
  }

  const startedAt = performance.now();
  try {
    const data = await task.executor.run({
      input: input as z.output<TSchema>,
      dryRun,
      env,
    });

    return appendCapabilityWarning(
      {
        taskId: task.id,
        ok: true,
        status: dryRun ? "skipped" : "succeeded",
        retryable: false,
        summary:
          task.executor.summarize?.({
            input: input as z.output<TSchema>,
            dryRun,
            env,
            data,
          }) ?? `${task.id} finished.`,
        durationMs: performance.now() - startedAt,
        data,
      },
      capabilityWarning,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    return appendCapabilityWarning(
      {
        taskId: task.id,
        ok: false,
        status: "failed",
        retryable: true,
        errorCode: "internal_execution_failed",
        stderr: message,
        summary: message,
        durationMs: performance.now() - startedAt,
      },
      capabilityWarning,
    );
  }
}

function appendCapabilityWarning(
  result: TaskRunResult,
  capabilityWarning?: string,
): TaskRunResult {
  if (!capabilityWarning) {
    return result;
  }

  return {
    ...result,
    summary: [result.summary, capabilityWarning].filter(Boolean).join(" "),
  };
}
