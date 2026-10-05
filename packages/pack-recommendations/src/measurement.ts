import { z } from "zod";
import { DAY, id, integer, revision } from "./contracts";

export const assignmentSchema = z
  .object({
    assignmentId: id,
    decisionId: id,
    subjectId: id,
    ruleRevision: revision,
    mappingVersion: revision,
    entityRef: id.optional(),
    contextId: id,
    measurementProfileId: id,
    startsAt: integer,
    endsAt: integer,
    experiment: z.enum(["training", "holdout"]),
    application: z.enum(["sampler", "constrained", "fallback"]),
    appliedProbability: z.number().finite().positive().max(1).nullable(),
  })
  .strict()
  .refine(
    (v) =>
      v.endsAt > v.startsAt &&
      v.endsAt - v.startsAt <= DAY &&
      (v.application !== "sampler" || v.appliedProbability !== null),
  );
export const manifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    manifestId: id,
    producerId: id,
    appId: id,
    appRevision: revision,
    generatedAt: integer,
    assignments: z.array(assignmentSchema).max(10000),
  })
  .strict()
  .refine(
    (v) =>
      new Set(v.assignments.map((a) => a.assignmentId)).size ===
      v.assignments.length,
  );
export const aggregateRowSchema = z
  .object({
    assignmentId: id,
    exposures: integer,
    clicks: integer,
    dispatches: integer,
  })
  .strict()
  .refine((v) => v.dispatches <= v.clicks && v.clicks <= v.exposures);
export const aggregateSchema = z
  .object({
    schemaVersion: z.literal(1),
    producerId: id,
    appId: id,
    measurementProfileId: id,
    periodStart: integer,
    periodEnd: integer,
    revision,
    generatedAt: integer,
    rows: z.array(aggregateRowSchema).max(10000),
  })
  .strict()
  .refine(
    (v) =>
      v.periodStart % DAY === 0 &&
      v.periodEnd === v.periodStart + DAY &&
      v.generatedAt >= v.periodEnd &&
      new Set(v.rows.map((r) => r.assignmentId)).size === v.rows.length,
  );
export type Assignment = z.infer<typeof assignmentSchema>;
export type Manifest = z.infer<typeof manifestSchema>;
export type Aggregate = z.infer<typeof aggregateSchema>;
export const pointerSchema = z
  .object({
    schemaVersion: z.literal(1),
    appId: id,
    requestId: id,
    decisionId: id,
    modelGenerationId: id,
    inputDigest: z.string().regex(/^[a-f0-9]{64}$/),
    generatedAt: integer,
    expiresAt: integer,
    file: z.string().max(100),
  })
  .strict()
  .refine(
    (v) =>
      v.expiresAt > v.generatedAt &&
      v.file === `decisions/${v.decisionId}.json`,
  );
