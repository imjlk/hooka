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
  targetId: z.string().min(1).optional(),
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

export const trailbaseAssetsDrainedWebhookSchema = z.object({
  targetId: z.string().min(1).optional(),
  taskId: z.string().min(1).default("deploy.trailbase-pages.full"),
  idempotencyKey: z.string().min(1),
  source: z
    .string()
    .min(1)
    .default("zero-three-three.asset_generation_drained"),
  sourcePath: z.string().min(1).default("/shared-source/trailbase/uploads"),
  project: z.string().min(1),
  branch: z.string().min(1).default("production"),
  staticRevision: z.string().min(1).optional(),
  readyCount: z.number().int().nonnegative().default(0),
  failedCount: z.number().int().nonnegative().default(0),
  queuedCount: z.number().int().nonnegative().default(0),
  pendingProblemAssetsCount: z.number().int().nonnegative().default(0),
  latestAssetUpdatedAt: z.number().int().nonnegative().optional(),
  warning: z.string().nullable().optional(),
  triggeredAt: z.string().datetime().optional(),
});

export type SharedVolumeWranglerInput = z.infer<
  typeof sharedVolumeWranglerInputSchema
>;
export type WordpressSimplyStaticWebhook = z.infer<
  typeof wordpressSimplyStaticWebhookSchema
>;
export type TrailBaseAssetsDrainedWebhook = z.infer<
  typeof trailbaseAssetsDrainedWebhookSchema
>;
