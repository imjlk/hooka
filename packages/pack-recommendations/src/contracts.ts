import { z } from "zod";

export const DAY = 86_400_000;
export const id = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/);
export const integer = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER);
export const revision = integer.min(1);
const unique = <T>(values: T[]) => new Set(values).size === values.length;
export const ids = z
  .array(id)
  .max(1000)
  .meta({ uniqueItems: true })
  .refine(unique);
export const counts = z
  .object({ exposures: integer, clicks: integer, dispatches: integer })
  .strict()
  .refine((v) => v.dispatches <= v.clicks && v.clicks <= v.exposures);
export const policySchema = z
  .object({
    policyId: id,
    version: revision,
    alpha: z.number().finite().positive().max(1000).default(1),
    beta: z.number().finite().positive().max(1000).default(19),
    epsilon: z.number().finite().min(0).max(1).default(0.2),
    sharing: z.boolean().default(false),
    minSharedExposures: integer.min(1).default(200),
    minSharedDays: integer.min(1).max(14).default(3),
    sharedStrength: z.number().finite().positive().max(100).default(20),
    singleAppStrength: z.number().finite().positive().max(100).default(5),
    maxAppShare: z.number().finite().min(0.5).max(1).default(0.8),
  })
  .strict()
  .refine((v) => v.singleAppStrength <= v.sharedStrength);
const subjectSchema = z
  .object({
    subjectId: id,
    ruleRevision: revision,
    enabled: z.boolean().default(true),
    canonicalSubjectId: id.optional(),
    mappingVersion: revision.default(1),
    entityRefs: ids.default([]),
  })
  .strict();
const contextSchema = z
  .object({
    contextId: id,
    measurementProfileId: id,
    learningGroupId: id.optional(),
    cohortId: id.optional(),
  })
  .strict()
  .refine((v) => Boolean(v.learningGroupId) === Boolean(v.cohortId));
export const configSchema = z
  .object({
    schemaVersion: z.literal(1),
    policies: z.array(policySchema).min(1).max(100),
    entities: z
      .array(
        z
          .object({
            entityRef: id,
            provider: id,
            catalogScope: id,
            productId: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/),
          })
          .strict(),
      )
      .max(10000),
    apps: z
      .array(
        z
          .object({
            appId: id,
            appRevision: revision,
            producerId: id,
            contexts: z.array(contextSchema).min(1).max(100),
            subjects: z.array(subjectSchema).max(1000),
          })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .strict()
  .superRefine((v, ctx) => {
    const fail = (message: string) => ctx.addIssue({ code: "custom", message });
    if (
      !unique(v.policies.map((p) => p.policyId)) ||
      !unique(v.apps.map((a) => a.appId)) ||
      !unique(v.apps.map((a) => a.producerId)) ||
      !unique(v.entities.map((e) => e.entityRef)) ||
      !unique(
        v.entities.map((e) =>
          JSON.stringify([e.provider, e.catalogScope, e.productId]),
        ),
      )
    )
      fail("Duplicate registration.");
    for (const app of v.apps) {
      if (
        !unique(app.subjects.map((s) => s.subjectId)) ||
        !unique(app.contexts.map((c) => c.contextId))
      )
        fail("Duplicate app subject or context.");
      for (const s of app.subjects)
        if (
          s.entityRefs.some((e) => !v.entities.some((x) => x.entityRef === e))
        )
          fail("Unknown entity reference.");
    }
  });
export const candidateSchema = z
  .object({ subjectId: id, ruleRevision: revision, entityRef: id.optional() })
  .strict();
export const candidateKey = (v: z.infer<typeof candidateSchema>) =>
  JSON.stringify([v.subjectId, v.entityRef ?? null]);
export const requestSchema = z
  .object({
    schemaVersion: z.literal(1),
    requestId: id,
    appId: id,
    appRevision: revision,
    policyId: id,
    policyVersion: revision,
    contextId: id,
    measurementProfileId: id,
    kind: z.enum(["subject", "product"]),
    generatedAt: integer,
    expiresAt: integer,
    seed: z.string().min(1).max(128),
    candidates: z.array(candidateSchema).max(1000),
  })
  .strict()
  .superRefine((v, ctx) => {
    const fail = (message: string) => ctx.addIssue({ code: "custom", message });
    if (v.expiresAt <= v.generatedAt || v.expiresAt - v.generatedAt > DAY)
      fail("Invalid request lifetime.");
    if (!unique(v.candidates.map(candidateKey))) fail("Duplicate candidate.");
    if (v.kind === "subject" && !unique(v.candidates.map((c) => c.subjectId)))
      fail("Subject candidates must be unique.");
    if (
      v.kind === "product" &&
      (v.candidates.some((c) => !c.entityRef) ||
        new Set(v.candidates.map((c) => c.subjectId)).size > 1)
    )
      fail("Product request requires one subject and registered products.");
  });
export const evidenceRowSchema = z
  .object({
    appId: id,
    subjectId: id,
    ruleRevision: revision,
    mappingVersion: revision,
    entityRef: id.optional(),
    contextId: id,
    measurementProfileId: id,
    day: integer,
    experiment: z.enum(["training", "holdout"]),
    exposures: integer,
    clicks: integer,
    dispatches: integer,
  })
  .strict()
  .refine(
    (v) =>
      v.day % DAY === 0 && v.dispatches <= v.clicks && v.clicks <= v.exposures,
  );
export const evidenceKey = (v: z.infer<typeof evidenceRowSchema>) =>
  JSON.stringify([
    v.appId,
    v.subjectId,
    v.ruleRevision,
    v.mappingVersion,
    v.entityRef ?? null,
    v.contextId,
    v.measurementProfileId,
    v.day,
    v.experiment,
  ]);
export const modelSchema = z
  .object({
    schemaVersion: z.literal(1),
    modelGenerationId: id,
    generatedAt: integer,
    rows: z.array(evidenceRowSchema).max(100000),
  })
  .strict()
  .refine((v) => unique(v.rows.map(evidenceKey)), "Duplicate evidence row.");
const scoredCandidate = candidateSchema
  .extend({
    weight: z.number().finite().min(0).max(1),
    rank: revision,
    confidence: z.enum(["prior", "local", "shared"]),
    reason: z.enum([
      "cold-start",
      "local-evidence",
      "shared-prior",
      "insufficient-shared-evidence",
    ]),
  })
  .strict();
export const resultSchema = z
  .object({
    schemaVersion: z.literal(1),
    requestId: id,
    decisionId: id,
    appId: id,
    appRevision: revision,
    policyId: id,
    policyVersion: revision,
    modelGenerationId: id,
    inputDigest: z.string().regex(/^[a-f0-9]{64}$/),
    generatedAt: integer,
    expiresAt: integer,
    contextId: id,
    measurementProfileId: id,
    kind: z.enum(["subject", "product"]),
    seed: z.string().min(1).max(128),
    samplerVersion: z.literal("sha256-counter-v1"),
    reason: z.enum(["scored", "no-eligible-candidates"]),
    entries: z.array(scoredCandidate).max(1000),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (
      !unique(v.entries.map(candidateKey)) ||
      !unique(v.entries.map((e) => e.rank)) ||
      v.entries.some((e) => e.rank > v.entries.length) ||
      v.expiresAt <= v.generatedAt ||
      (v.entries.length === 0) !== (v.reason === "no-eligible-candidates") ||
      (v.entries.length > 0 &&
        Math.abs(v.entries.reduce((n, e) => n + e.weight, 0) - 1) > 1e-9)
    )
      ctx.addIssue({
        code: "custom",
        message: "Invalid recommendation result invariants.",
      });
  });
export type Config = z.infer<typeof configSchema>;
export type Request = z.infer<typeof requestSchema>;
export type Candidate = z.infer<typeof candidateSchema>;
export type Model = z.infer<typeof modelSchema>;
export type Result = z.infer<typeof resultSchema>;
