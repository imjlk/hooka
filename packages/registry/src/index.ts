import type { ImagePlan, RegistrySummary } from "@hooka/contracts";
import { registrySummarySchema } from "@hooka/contracts";
import { gitCapability } from "@hooka/cap-git";
import { phpCliCapability } from "@hooka/cap-php-cli";
import { rcloneCapability } from "@hooka/cap-rclone";
import { rsyncCapability } from "@hooka/cap-rsync";
import { wpcliCapability } from "@hooka/cap-wpcli";
import { wranglerCapability } from "@hooka/cap-wrangler";
import { cloudflareTaskPack } from "@hooka/pack-cloudflare";
import { wordpressTaskPack } from "@hooka/pack-wordpress";
import { wordpressCloudflareTaskPack } from "@hooka/pack-wordpress-cloudflare";
import type {
  AnyTask,
  CapabilityDefinition,
  PresetDefinition,
  TaskPackDefinition,
} from "@hooka/task-sdk";
import { cfWranglerPreset } from "../../../presets/cf-wrangler.ts";
import { corePreset } from "../../../presets/core.ts";
import { wpWranglerPreset } from "../../../presets/wp-wrangler.ts";
import { wpWranglerRclonePreset } from "../../../presets/wp-wrangler-rclone.ts";

const capabilities = [
  wranglerCapability,
  wpcliCapability,
  phpCliCapability,
  rsyncCapability,
  gitCapability,
  rcloneCapability,
] satisfies CapabilityDefinition[];

const taskPacks = [
  cloudflareTaskPack,
  wordpressTaskPack,
  wordpressCloudflareTaskPack,
] satisfies TaskPackDefinition[];

const presets = [
  corePreset,
  cfWranglerPreset,
  wpWranglerPreset,
  wpWranglerRclonePreset,
] satisfies PresetDefinition[];

const capabilityMap = new Map(
  capabilities.map((capability) => [capability.id, capability]),
);
const taskPackMap = new Map(taskPacks.map((pack) => [pack.id, pack]));
const tasks = taskPacks.flatMap((pack) => pack.tasks);
const taskMap = new Map(tasks.map((task) => [task.id, task]));
const presetMap = new Map(presets.map((preset) => [preset.id, preset]));

export function listCapabilities(): CapabilityDefinition[] {
  return [...capabilities];
}

export function listTaskPacks(): TaskPackDefinition[] {
  return [...taskPacks];
}

export function listTasks(): AnyTask[] {
  return [...tasks];
}

export function listPresets(): PresetDefinition[] {
  return [...presets];
}

export function getTask(taskId: string): AnyTask | undefined {
  return taskMap.get(taskId);
}

export function getPreset(presetId: string): PresetDefinition | undefined {
  return presetMap.get(presetId);
}

export function getCapability(
  capabilityId: string,
): CapabilityDefinition | undefined {
  return capabilityMap.get(capabilityId);
}

export function getTaskPack(packId: string): TaskPackDefinition | undefined {
  return taskPackMap.get(packId);
}

export function validateRegistry(): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  const duplicateTaskIds = findDuplicates(tasks.map((task) => task.id));
  const duplicateCapabilityIds = findDuplicates(
    capabilities.map((capability) => capability.id),
  );
  const duplicatePresetIds = findDuplicates(presets.map((preset) => preset.id));

  for (const taskId of duplicateTaskIds) {
    errors.push(`Duplicate task id detected: ${taskId}`);
  }

  for (const capabilityId of duplicateCapabilityIds) {
    errors.push(`Duplicate capability id detected: ${capabilityId}`);
  }

  for (const presetId of duplicatePresetIds) {
    errors.push(`Duplicate preset id detected: ${presetId}`);
  }

  for (const preset of presets) {
    for (const packId of preset.taskPacks) {
      if (!taskPackMap.has(packId)) {
        errors.push(`Preset ${preset.id} references missing task pack ${packId}`);
      }
    }
  }

  return {
    ok: errors.length === 0,
    errors,
  };
}

export function getPresetPlan(presetId: string): ImagePlan | undefined {
  const preset = getPreset(presetId);

  if (!preset) {
    return undefined;
  }

  const coveredTasks = preset.taskPacks.flatMap((packId) => {
    return getTaskPack(packId)?.tasks.map((task) => task.id) ?? [];
  });
  const missingCapabilitiesByTask = Object.fromEntries(
    preset.taskPacks.flatMap((packId: string) => {
      const pack = getTaskPack(packId);
      if (!pack) {
        return [];
      }

      return pack.tasks.flatMap((task) => {
        const missing = task.requires.filter((requirement) => {
          return !preset.capabilities.includes(requirement);
        });

        return missing.length > 0 ? [[task.id, missing]] : [];
      });
    }),
  );

  return {
    presetId: preset.id,
    imageTag: preset.imageTag,
    capabilities: preset.capabilities,
    taskPacks: preset.taskPacks,
    coveredTasks,
    missingCapabilitiesByTask,
  };
}

export function recommendPresetForTasks(taskIds: string[]): PresetDefinition | undefined {
  const candidates = presets.filter((preset) => {
    return taskIds.every((taskId) => {
      const task = getTask(taskId);
      if (!task) {
        return false;
      }

      const isIncluded = preset.taskPacks.some((packId) => {
        const pack = getTaskPack(packId);
        return pack?.tasks.some((candidate) => candidate.id === taskId) ?? false;
      });

      return (
        isIncluded &&
        task.requires.every((requirement) => preset.capabilities.includes(requirement))
      );
    });
  });

  return candidates.sort((left, right) => {
    return left.capabilities.length - right.capabilities.length;
  })[0];
}

export function createRegistrySummary(
  installedCapabilities: string[] = [],
): RegistrySummary {
  return registrySummarySchema.parse({
    generatedAt: new Date().toISOString(),
    counts: {
      tasks: tasks.length,
      capabilities: capabilities.length,
      presets: presets.length,
    },
    installedCapabilities,
    tasks: tasks.map((task) => ({
      id: task.id,
      title: task.title,
      requires: task.requires,
      available: task.requires.every((requirement) => {
        return installedCapabilities.includes(requirement);
      }),
    })),
    presets: presets.map((preset) => ({
      id: preset.id,
      imageTag: preset.imageTag,
      coveredTasks: getPresetPlan(preset.id)?.coveredTasks.length ?? 0,
      capabilities: preset.capabilities,
    })),
  });
}

function findDuplicates(values: string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();

  for (const value of values) {
    if (seen.has(value)) {
      duplicates.add(value);
    }
    seen.add(value);
  }

  return [...duplicates];
}
