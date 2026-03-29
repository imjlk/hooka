import { z } from "zod";
import { capabilityEnvRequirementSchema } from "./capability";

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

export type ImagePlan = z.infer<typeof imagePlanSchema>;
export type RegistrySummary = z.infer<typeof registrySummarySchema>;
