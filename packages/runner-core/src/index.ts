import type {
  InstalledCapabilitiesManifest,
  TaskRunResult,
} from "@hooka/contracts";
import { installedCapabilitiesManifestSchema } from "@hooka/contracts";
import { runHttpTask } from "@hooka/executor-http";
import type { CommandRunner } from "@hooka/executor-process";
import { runProcessTask } from "@hooka/executor-process";
import type { HookaTask, TaskInputSchema } from "@hooka/task-sdk";
import { resolve } from "node:path";
import { z } from "zod";

export interface RunTaskOptions {
  dryRun?: boolean;
  installedCapabilities?: string[];
  manifestPath?: string;
  commandRunner?: CommandRunner;
  env?: Record<string, string | undefined>;
}

export const defaultManifestRelativePath = ".hooka/installed-capabilities.json";

export function getDefaultManifestPath(
  cwd = process.cwd(),
  env: Record<string, string | undefined> = Bun.env as Record<
    string,
    string | undefined
  >,
): string {
  return resolve(cwd, env.HOOKA_MANIFEST_PATH ?? defaultManifestRelativePath);
}

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

function parseInstalledCapabilitiesOverride():
  | InstalledCapabilitiesManifest
  | null {
  const raw = Bun.env.HOOKA_INSTALLED_CAPABILITIES?.trim();

  if (!raw) {
    return null;
  }

  const installed = raw
    .split(",")
    .map((capability) => capability.trim())
    .filter(Boolean);

  return installedCapabilitiesManifestSchema.parse({
    image: Bun.env.HOOKA_RUNTIME_ROLE ?? "hooka:env-override",
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
  const input = task.input.parse(rawInput ?? {});
  const env = options.env ?? (Bun.env as Record<string, string | undefined>);
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
