import { z } from "zod";

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

export type InstalledCapabilitiesManifest = z.infer<
  typeof installedCapabilitiesManifestSchema
>;
