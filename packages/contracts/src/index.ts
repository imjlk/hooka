import { z } from "zod";

export const taskRunRequestSchema = z.object({
  taskId: z.string().min(1),
  input: z.unknown().default({}),
  dryRun: z.boolean().default(false),
});

export const enqueueRunRequestSchema = z.object({
  taskId: z.string().min(1),
  input: z.unknown().default({}),
  source: z.string().default("api"),
  sourceEventId: z.string().min(1).optional(),
});

export const genericTaskWebhookSchema = z.object({
  taskId: z.string().min(1),
  input: z.unknown().default({}),
  eventId: z.string().min(1),
  source: z.string().default("webhook"),
  triggeredAt: z.string().datetime().optional(),
});

export const sharedVolumeWranglerInputSchema = z.object({
  kind: z.literal("pages-deploy").default("pages-deploy"),
  sourcePath: z.string().min(1).default("/shared-source/simply-static"),
  project: z.string().min(1),
  branch: z.string().min(1).optional(),
  commitSha: z.string().min(1).optional(),
});

export const taskRunStatusSchema = z.enum([
  "queued",
  "running",
  "succeeded",
  "failed",
  "skipped",
]);

export const taskRunResultSchema = z.object({
  taskId: z.string(),
  ok: z.boolean(),
  status: taskRunStatusSchema,
  command: z.array(z.string()).optional(),
  stdout: z.string().optional(),
  stderr: z.string().optional(),
  summary: z.string().optional(),
  durationMs: z.number().nonnegative(),
  data: z.unknown().optional(),
});

export const enqueueRunResponseSchema = z.object({
  runId: z.string(),
  taskId: z.string(),
  status: taskRunStatusSchema,
  createdAt: z.string(),
  existing: z.boolean().default(false),
});

export const runEventSchema = z.object({
  id: z.string(),
  runId: z.string(),
  type: z.string(),
  message: z.string(),
  data: z.unknown().optional(),
  createdAt: z.string(),
});

export const runSummarySchema = z.object({
  id: z.string(),
  taskId: z.string(),
  source: z.string(),
  sourceEventId: z.string().nullable(),
  status: taskRunStatusSchema,
  summary: z.string().nullable(),
  errorText: z.string().nullable(),
  attemptCount: z.number().int().nonnegative(),
  createdAt: z.string(),
  queuedAt: z.string().nullable(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
});

export const runDetailSchema = runSummarySchema.extend({
  payload: z.unknown(),
  result: taskRunResultSchema.nullable(),
  capabilitySnapshot: z.array(z.string()),
  workerId: z.string().nullable(),
  leaseExpiresAt: z.string().nullable(),
  events: z.array(runEventSchema),
});

export const wordpressSimplyStaticWebhookSchema = z.object({
  eventId: z.string().min(1),
  project: z.string().min(1),
  exportDir: z.string().min(1),
  branch: z.string().min(1).optional(),
  commitSha: z.string().min(1).optional(),
  triggeredAt: z.string().datetime().optional(),
});

export const installedCapabilitiesManifestSchema = z.object({
  image: z.string().default("hooka:dev"),
  generatedAt: z.string().default(() => new Date().toISOString()),
  installed: z.array(z.string()).default([]),
});

export const capabilityEnvRequirementSchema = z.object({
  capabilityId: z.string(),
  match: z.enum(["allOf", "anyOf"]),
  names: z.array(z.string()).min(1),
  description: z.string(),
  secret: z.boolean().default(false),
});

export const imagePlanSchema = z.object({
  presetId: z.string(),
  tier: z.enum(["lean", "combo"]).optional(),
  imageTag: z.string(),
  publicWorkerTag: z.string().optional(),
  legacyImageTags: z.array(z.string()).default([]),
  capabilities: z.array(z.string()),
  requiredEnv: z.array(capabilityEnvRequirementSchema).default([]),
  taskPacks: z.array(z.string()),
  coveredTasks: z.array(z.string()),
  missingCapabilitiesByTask: z
    .record(z.string(), z.array(z.string()))
    .default({}),
});

export const registrySummarySchema = z.object({
  generatedAt: z.string(),
  counts: z.object({
    tasks: z.number().int().nonnegative(),
    capabilities: z.number().int().nonnegative(),
    presets: z.number().int().nonnegative(),
  }),
  installedCapabilities: z.array(z.string()),
  tasks: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      requires: z.array(z.string()),
      available: z.boolean(),
    }),
  ),
  presets: z.array(
    z.object({
      id: z.string(),
      tier: z.enum(["lean", "combo"]).optional(),
      imageTag: z.string(),
      publicWorkerTag: z.string().optional(),
      coveredTasks: z.number().int().nonnegative(),
      capabilities: z.array(z.string()),
    }),
  ),
});

export type TaskRunRequest = z.infer<typeof taskRunRequestSchema>;
export type EnqueueRunRequest = z.infer<typeof enqueueRunRequestSchema>;
export type EnqueueRunResponse = z.infer<typeof enqueueRunResponseSchema>;
export type GenericTaskWebhook = z.infer<typeof genericTaskWebhookSchema>;
export type SharedVolumeWranglerInput = z.infer<
  typeof sharedVolumeWranglerInputSchema
>;
export type TaskRunResult = z.infer<typeof taskRunResultSchema>;
export type TaskRunStatus = z.infer<typeof taskRunStatusSchema>;
export type RunEvent = z.infer<typeof runEventSchema>;
export type RunSummary = z.infer<typeof runSummarySchema>;
export type RunDetail = z.infer<typeof runDetailSchema>;
export type InstalledCapabilitiesManifest = z.infer<
  typeof installedCapabilitiesManifestSchema
>;
export type ImagePlan = z.infer<typeof imagePlanSchema>;
export type RegistrySummary = z.infer<typeof registrySummarySchema>;
export type WordpressSimplyStaticWebhook = z.infer<
  typeof wordpressSimplyStaticWebhookSchema
>;
