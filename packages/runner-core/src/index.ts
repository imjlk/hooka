import type {
  InstalledCapabilitiesManifest,
  TaskRunResult,
} from "@hooka/contracts";
import { installedCapabilitiesManifestSchema } from "@hooka/contracts";
import { runHttpTask } from "@hooka/executor-http";
import type { CommandRunner } from "@hooka/executor-process";
import { runProcessTask } from "@hooka/executor-process";
import type { HookaTask, TaskInputSchema } from "@hooka/task-sdk";
import { performance } from "node:perf_hooks";
import { join } from "node:path";
import { z } from "zod";

export interface RunTaskOptions {
  dryRun?: boolean;
  installedCapabilities?: string[];
  manifestPath?: string;
  commandRunner?: CommandRunner;
  env?: Record<string, string | undefined>;
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
  manifestPath = join(process.cwd(), "docker/manifests/installed-capabilities.json"),
): Promise<InstalledCapabilitiesManifest> {
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
    return capabilityWarning
      ? {
          ...result,
          summary: [result.summary, capabilityWarning].filter(Boolean).join(" "),
        }
      : result;
  }

  if (task.executor.kind === "http") {
    const result = await runHttpTask(task, input as z.output<TSchema>, dryRun);
    return capabilityWarning
      ? {
          ...result,
          summary: [result.summary, capabilityWarning].filter(Boolean).join(" "),
        }
      : result;
  }

  const startedAt = performance.now();
  const data = await task.executor.run({
    input: input as z.output<TSchema>,
    dryRun,
    env,
  });

  return {
    taskId: task.id,
    ok: true,
    status: dryRun ? "skipped" : "succeeded",
    summary: [
      task.executor.summarize?.({
        input: input as z.output<TSchema>,
        dryRun,
        env,
        data,
      }) ?? `${task.id} finished.`,
      capabilityWarning,
    ]
      .filter(Boolean)
      .join(" "),
    durationMs: performance.now() - startedAt,
    data,
  };
}
