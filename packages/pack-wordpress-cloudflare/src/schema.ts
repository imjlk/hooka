import { z } from "zod";

export const sharedVolumeWranglerInputSchema = z.object({
  kind: z.literal("pages-deploy").default("pages-deploy"),
  sourcePath: z.string().min(1).default("/shared-source/simply-static"),
  project: z.string().min(1),
  branch: z.string().min(1).optional(),
  commitSha: z.string().min(1).optional(),
  commitMessage: z.string().min(1).optional(),
  commitDirty: z.boolean().optional(),
  skipCaching: z.boolean().optional(),
  noBundle: z.boolean().optional(),
  uploadSourceMaps: z.boolean().optional(),
});

export const wordpressSimplyStaticWebhookSchema = z.object({
  eventId: z.string().min(1),
  project: z.string().min(1),
  exportDir: z.string().min(1),
  branch: z.string().min(1).optional(),
  commitSha: z.string().min(1).optional(),
  commitMessage: z.string().min(1).optional(),
  commitDirty: z.boolean().optional(),
  skipCaching: z.boolean().optional(),
  noBundle: z.boolean().optional(),
  uploadSourceMaps: z.boolean().optional(),
  triggeredAt: z.string().datetime().optional(),
});

export type SharedVolumeWranglerInput = z.infer<
  typeof sharedVolumeWranglerInputSchema
>;
export type WordpressSimplyStaticWebhook = z.infer<
  typeof wordpressSimplyStaticWebhookSchema
>;
