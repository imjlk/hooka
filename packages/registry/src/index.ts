import type { ImagePlan, RegistrySummary } from "@hooka/contracts";
import { registrySummarySchema } from "@hooka/contracts";
import { listActiveWorkerPresets } from "@hooka/preset-catalog";
import {
  collectCapabilityEnvRequirements,
  findMissingCapabilityEnvRequirements,
} from "@hooka/runtime-contracts";
import type {
  AnyTask,
  CompatibilityWebhookAdapter,
  CapabilityDefinition,
  PresetDefinition,
  TaskPackDefinition,
} from "@hooka/task-sdk";
import { discoverRegistryArtifacts } from "./discovery";

const discovery = await discoverRegistryArtifacts();
const webhookAdapters =
  discovery.webhookAdapters satisfies CompatibilityWebhookAdapter[];
const capabilities = discovery.capabilities satisfies CapabilityDefinition[];
const taskPacks = discovery.taskPacks satisfies TaskPackDefinition[];

const presets = listActiveWorkerPresets() satisfies PresetDefinition[];

const capabilityMap = new Map(
  capabilities.map((capability) => [capability.id, capability]),
);
const taskPackMap = new Map(taskPacks.map((pack) => [pack.id, pack]));
const tasks = taskPacks.flatMap((pack) => pack.tasks);
const taskMap = createAliasMap(tasks);
const presetMap = createAliasMap(presets);

export function listCapabilities(): CapabilityDefinition[] {
  return [...capabilities];
}

export function listWebhookAdapters(): CompatibilityWebhookAdapter[] {
  return [...webhookAdapters];
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

export function getCapabilityEnvRequirements(capabilityIds: string[]) {
  return collectCapabilityEnvRequirements(capabilities, capabilityIds);
}

export function findMissingCapabilityEnv(
  capabilityIds: string[],
  env: Record<string, string | undefined>,
) {
  return findMissingCapabilityEnvRequirements(capabilities, capabilityIds, env);
}

export function getTaskPack(packId: string): TaskPackDefinition | undefined {
  return taskPackMap.get(packId);
}

export function validateRegistry(): { ok: boolean; errors: string[] } {
  const result = validateRegistryState({
    capabilities,
    taskPacks,
    presets,
    tasks,
    webhookAdapters,
  });

  return {
    ok: result.ok,
    errors: [...discovery.errors, ...result.errors],
  };
}

export function validateRegistryState(input: {
  capabilities: CapabilityDefinition[];
  taskPacks: TaskPackDefinition[];
  presets: PresetDefinition[];
  tasks: AnyTask[];
  webhookAdapters: CompatibilityWebhookAdapter[];
}): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  const duplicateTaskIds = findDuplicates([
    ...input.tasks.map((task) => task.id),
    ...input.tasks.flatMap((task) => task.aliases ?? []),
  ]);
  const duplicateCapabilityIds = findDuplicates(
    input.capabilities.map((capability) => capability.id),
  );
  const duplicateWebhookAdapterIds = findDuplicates(
    input.webhookAdapters.map((adapter) => adapter.id),
  );
  const duplicateWebhookRoutePaths = findDuplicates(
    input.webhookAdapters.map((adapter) => adapter.routePath),
  );
  const duplicatePresetIds = findDuplicates([
    ...input.presets.map((preset) => preset.id),
    ...input.presets.flatMap((preset) => preset.aliases ?? []),
  ]);

  for (const taskId of duplicateTaskIds) {
    errors.push(`Duplicate task id detected: ${taskId}`);
  }

  for (const capabilityId of duplicateCapabilityIds) {
    errors.push(`Duplicate capability id detected: ${capabilityId}`);
  }

  for (const adapterId of duplicateWebhookAdapterIds) {
    errors.push(`Duplicate webhook adapter id detected: ${adapterId}`);
  }

  for (const routePath of duplicateWebhookRoutePaths) {
    errors.push(`Duplicate webhook adapter route detected: ${routePath}`);
  }

  for (const presetId of duplicatePresetIds) {
    errors.push(`Duplicate preset id detected: ${presetId}`);
  }

  const taskPackMap = new Map(input.taskPacks.map((pack) => [pack.id, pack]));

  for (const preset of input.presets) {
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
    tier: preset.tier,
    imageTag: preset.imageTag,
    publicWorkerTag: preset.publicWorkerTag,
    legacyImageTags: preset.legacyImageTags ?? [],
    capabilities: preset.capabilities,
    requiredEnv: getCapabilityEnvRequirements(preset.capabilities),
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
        return pack?.tasks.some((candidate) => candidate.id === task.id) ?? false;
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

function createAliasMap<T extends { id: string; aliases?: string[] }>(
  items: T[],
): Map<string, T> {
  const map = new Map<string, T>();

  for (const item of items) {
    map.set(item.id, item);

    for (const alias of item.aliases ?? []) {
      map.set(alias, item);
    }
  }

  return map;
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
      tier: preset.tier,
      imageTag: preset.imageTag,
      publicWorkerTag: preset.publicWorkerTag,
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
