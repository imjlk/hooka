import { z } from "zod";

export const genericTaskWebhookSchema = z.object({
  taskId: z.string().min(1),
  input: z.unknown().default({}),
  eventId: z.string().min(1),
  source: z.string().default("webhook"),
  triggeredAt: z.string().datetime().optional(),
});

export type GenericTaskWebhook = z.infer<typeof genericTaskWebhookSchema>;
