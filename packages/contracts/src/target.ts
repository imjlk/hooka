import { capabilityEnvRequirementSchema } from "./capability";
import { z } from "zod";

export const targetArtifactReadinessSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("none"),
  }),
  z.object({
    mode: z.literal("marker-file"),
    markerFile: z.string().min(1),
    requiredFiles: z.array(z.string().min(1)).optional(),
  }),
  z.object({
    mode: z.literal("required-files"),
    requiredFiles: z.array(z.string().min(1)).min(1),
  }),
  z.object({
    mode: z.literal("quiet-period"),
    quietPeriodMs: z.number().int().positive().default(3_000),
    recursive: z.boolean().optional(),
    requiredFiles: z.array(z.string().min(1)).optional(),
  }),
]);

export const targetPolicySchema = z.object({
  allowedProjects: z.array(z.string().min(1)).default([]),
  allowedSourceRoots: z.array(z.string().min(1)).default([]),
  allowedDestinationPrefixes: z.array(z.string().min(1)).default([]),
  allowedBranches: z.array(z.string().min(1)).default([]),
  allowedOverrideFields: z.array(z.string().min(1)).default([]),
  requiredEnv: z
    .array(capabilityEnvRequirementSchema.omit({ capabilityId: true }))
    .default([]),
  artifactReadiness: targetArtifactReadinessSchema.default({
    mode: "none",
  }),
});

export const targetSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  description: z.string().optional(),
  taskId: z.string().min(1),
  presetId: z.string().min(1).optional(),
  source: z.string().min(1).default("target"),
  defaultInput: z.record(z.string(), z.unknown()).default({}),
  maxAttempts: z.number().int().positive().default(3),
  policy: targetPolicySchema.default(() => ({
    allowedProjects: [],
    allowedSourceRoots: [],
    allowedDestinationPrefixes: [],
    allowedBranches: [],
    allowedOverrideFields: [],
    requiredEnv: [],
    artifactReadiness: { mode: "none" as const },
  })),
});

export const targetsFileSchema = z.object({
  targets: z.array(targetSchema).default([]),
});

export type TargetArtifactReadiness = z.infer<
  typeof targetArtifactReadinessSchema
>;
export type TargetPolicy = z.infer<typeof targetPolicySchema>;
export type Target = z.infer<typeof targetSchema>;
export type TargetsFile = z.infer<typeof targetsFileSchema>;
