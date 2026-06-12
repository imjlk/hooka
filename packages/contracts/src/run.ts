import { z } from "zod";
import { taskRunResultSchema, taskRunStatusSchema } from "./task";

export const runListQuerySchema = z.object({
  limit: z.coerce.number().int().positive().default(20),
  status: taskRunStatusSchema.optional(),
  taskId: z.string().min(1).optional(),
  source: z.string().min(1).optional(),
});

export const auditEventCategorySchema = z.enum([
  "security",
  "policy",
  "targets",
]);

export const auditEventOutcomeSchema = z.enum([
  "rejected",
  "created",
  "updated",
  "deleted",
]);

export const auditEventListQuerySchema = z.object({
  limit: z.coerce.number().int().positive().default(20),
  category: auditEventCategorySchema.optional(),
  outcome: auditEventOutcomeSchema.optional(),
});

export const runEventSchema = z.object({
  id: z.string(),
  runId: z.string(),
  type: z.string(),
  message: z.string(),
  data: z.unknown().optional(),
  createdAt: z.string(),
});

export const auditEventSchema = z.object({
  sequence: z.number().int().positive(),
  createdAt: z.string(),
  category: auditEventCategorySchema,
  action: z.string().min(1),
  outcome: auditEventOutcomeSchema,
  subjectType: z.string().min(1),
  subjectId: z.string().nullable(),
  clientIp: z.string().nullable(),
  requestPath: z.string().nullable(),
  message: z.string(),
  context: z.unknown().optional(),
});

export const runSummarySchema = z.object({
  id: z.string(),
  taskId: z.string(),
  targetId: z.string().nullable(),
  source: z.string(),
  sourceEventId: z.string().nullable(),
  status: taskRunStatusSchema,
  summary: z.string().nullable(),
  errorText: z.string().nullable(),
  attemptCount: z.number().int().nonnegative(),
  maxAttempts: z.number().int().positive(),
  targetMaxConcurrentRuns: z.number().int().positive().nullable(),
  nextRetryAt: z.string().nullable(),
  lastErrorCode: z.string().nullable(),
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

export type RunEvent = z.infer<typeof runEventSchema>;
export type RunSummary = z.infer<typeof runSummarySchema>;
export type RunDetail = z.infer<typeof runDetailSchema>;
export type RunListQuery = z.infer<typeof runListQuerySchema>;
export type AuditEvent = z.infer<typeof auditEventSchema>;
export type AuditEventCategory = z.infer<typeof auditEventCategorySchema>;
export type AuditEventOutcome = z.infer<typeof auditEventOutcomeSchema>;
export type AuditEventListQuery = z.infer<typeof auditEventListQuerySchema>;
