import { z } from "zod";

export type TaskInputSchema = z.ZodTypeAny;
export type TaskCapabilityId = string;
export type TaskExecutorMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface TaskRuntimeContext<TInput> {
  input: TInput;
  dryRun: boolean;
  env: Record<string, string | undefined>;
}

export interface ProcessTaskExecutor<TInput> {
  kind: "process";
  command: string;
  args: (context: TaskRuntimeContext<TInput>) => string[];
  cwd?: (context: TaskRuntimeContext<TInput>) => string;
  env?: (
    context: TaskRuntimeContext<TInput>,
  ) => Record<string, string | undefined>;
}

export interface HttpTaskExecutor<TInput> {
  kind: "http";
  method: TaskExecutorMethod;
  url: (context: TaskRuntimeContext<TInput>) => string;
  headers?: (context: TaskRuntimeContext<TInput>) => Record<string, string>;
  body?: (context: TaskRuntimeContext<TInput>) => unknown;
}

export interface InternalTaskExecutor<TInput> {
  kind: "internal";
  run: (context: TaskRuntimeContext<TInput>) => Promise<unknown> | unknown;
  summarize?: (
    context: TaskRuntimeContext<TInput> & { data: unknown },
  ) => string;
}

export type TaskExecutor<TInput> =
  | ProcessTaskExecutor<TInput>
  | HttpTaskExecutor<TInput>
  | InternalTaskExecutor<TInput>;

export interface HookaTask<TSchema extends TaskInputSchema = TaskInputSchema> {
  id: string;
  title: string;
  description?: string;
  input: TSchema;
  requires: TaskCapabilityId[];
  executor: TaskExecutor<z.output<TSchema>>;
  tags?: string[];
}

export interface CapabilityDefinition {
  id: TaskCapabilityId;
  title: string;
  description: string;
  binaries: string[];
  healthcheck: {
    command: string;
    args?: string[];
  };
  docker?: {
    feature: string;
    installScript: string;
    packages?: string[];
  };
  tasks?: string[];
}

export interface PresetDefinition {
  id: string;
  title: string;
  description: string;
  imageTag: string;
  capabilities: TaskCapabilityId[];
  taskPacks: string[];
  notes?: string[];
}

export interface TaskPackDefinition {
  id: string;
  title: string;
  description: string;
  tasks: HookaTask[];
}

export function defineTask<TSchema extends TaskInputSchema>(
  task: HookaTask<TSchema>,
): HookaTask<TSchema> {
  return task;
}

export function defineCapability(
  capability: CapabilityDefinition,
): CapabilityDefinition {
  return capability;
}

export function definePreset(preset: PresetDefinition): PresetDefinition {
  return preset;
}

export function defineTaskPack(pack: TaskPackDefinition): TaskPackDefinition {
  return pack;
}

export type AnyTask = HookaTask<TaskInputSchema>;
