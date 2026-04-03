import { z } from "zod";

export const taskRunStatusSchema = z.enum([
  "queued",
  "running",
  "succeeded",
  "failed",
  "dead-lettered",
  "skipped",
]);

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

export const taskRunResultSchema = z.object({
  taskId: z.string(),
  ok: z.boolean(),
  status: taskRunStatusSchema,
  retryable: z.boolean().optional(),
  errorCode: z.string().min(1).optional(),
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

export type TaskRunRequest = z.infer<typeof taskRunRequestSchema>;
export type EnqueueRunRequest = z.infer<typeof enqueueRunRequestSchema>;
export type TaskRunStatus = z.infer<typeof taskRunStatusSchema>;
export type TaskRunResult = z.infer<typeof taskRunResultSchema>;
export type EnqueueRunResponse = z.infer<typeof enqueueRunResponseSchema>;
