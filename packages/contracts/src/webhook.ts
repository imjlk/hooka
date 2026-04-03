import { z } from "zod";

export const genericTaskWebhookSchema = z.object({
  taskId: z.string().min(1),
  input: z.unknown().default({}),
  eventId: z.string().min(1),
  source: z.string().default("webhook"),
  triggeredAt: z.string().datetime().optional(),
});

export const targetedTaskWebhookSchema = z.object({
  targetId: z.string().min(1),
  overrides: z.unknown().default({}),
  eventId: z.string().min(1),
  source: z.string().default("webhook"),
  triggeredAt: z.string().datetime().optional(),
});

export const incomingTaskWebhookSchema = z.union([
  genericTaskWebhookSchema,
  targetedTaskWebhookSchema,
]);

export type GenericTaskWebhook = z.infer<typeof genericTaskWebhookSchema>;
export type TargetedTaskWebhook = z.infer<typeof targetedTaskWebhookSchema>;
export type IncomingTaskWebhook = z.infer<typeof incomingTaskWebhookSchema>;
