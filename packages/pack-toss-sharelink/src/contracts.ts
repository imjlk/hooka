import { z } from "zod";

export const idSchema = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/);
const envName = z.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/);
export const providerIdSchema = z
  .string()
  .regex(/^[1-9][0-9]{0,15}$/)
  .refine((id) => Number.isSafeInteger(Number(id)));
const cleanText = z
  .string()
  .trim()
  .min(1)
  .max(180)
  .regex(/^[^\p{Cc}]*$/u);
const keyword = cleanText.max(40).min(2);

/** Accept issued HTTPS destinations without credentials, ports, control characters or lookalike hosts. */
export function isIssuedLink(value: string): boolean {
  if (value.length > 4096 || /[\s\\\p{Cc}]/u.test(value)) return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.port &&
      ["toss.im", "toss.shopping"].includes(url.hostname) &&
      /^https:\/\/(?:toss\.im|toss\.shopping)(?:[/?#]|$)/i.test(value)
    );
  } catch {
    return false;
  }
}

export const offerSchema = z
  .object({
    provider: z.literal("toss-sharelink"),
    productId: providerIdSchema,
    title: cleanText,
    url: z.string().refine(isIssuedLink),
    source: z.enum(["manual", "automatic"]),
    checkedAt: z.number().int().nonnegative(),
    expiresAt: z.number().int().nonnegative(),
  })
  .strict()
  .refine((offer) => offer.expiresAt > offer.checkedAt);
export type Offer = z.infer<typeof offerSchema>;

export const subjectSchema = z
  .object({
    subjectId: idSchema,
    revision: z.number().int().positive(),
    enabled: z.boolean().default(true),
    categoryId: providerIdSchema,
    catalogSource: z
      .enum(["category-best", "today-deals", "overall-best"])
      .default("category-best"),
    keywords: z.array(keyword).min(1).max(8),
    // Optional without defaults: old config fingerprints remain stable on upgrade.
    pinnedProductId: providerIdSchema.optional(),
    maxCatalogPages: z.number().int().min(1).max(5).optional(),
    excludedKeywords: z.array(keyword).max(8).default([]),
    excludedCategoryIds: z.array(providerIdSchema).max(100).default([]),
    excludedProductIds: z.array(providerIdSchema).max(100).default([]),
    manual: z
      .object({
        productId: providerIdSchema,
        title: cleanText,
        url: z.string().refine(isIssuedLink),
        reviewedAt: z.number().int().nonnegative(),
        reviewUntil: z.number().int().nonnegative(),
      })
      .strict()
      .refine(
        (v) =>
          v.reviewUntil > v.reviewedAt &&
          v.reviewUntil - v.reviewedAt <= 7 * 86400000,
      )
      .optional(),
  })
  .strict();
export type Subject = z.infer<typeof subjectSchema>;

const accountSchema = z
  .object({
    accountId: idSchema,
    publisherId: z.string().uuid(),
    accessKeyEnv: envName,
    secretKeyEnv: envName,
    productBudget: z.number().int().min(1).max(10000).default(9000),
    linkBudget: z.number().int().min(1).max(10000).default(9000),
  })
  .strict();
export type Account = z.infer<typeof accountSchema>;

export const appSchema = z
  .object({
    appId: idSchema,
    accountId: idSchema,
    revision: z.number().int().positive(),
    subTagId: z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/),
    subjects: z.array(subjectSchema).max(1000),
  })
  .strict()
  .refine(
    (app) =>
      new Set(app.subjects.map((s) => s.subjectId)).size ===
      app.subjects.length,
  );
export type App = z.infer<typeof appSchema>;
export const configSchema = z
  .object({
    schemaVersion: z.literal(1),
    accounts: z.array(accountSchema).min(1).max(20),
    apps: z.array(appSchema).min(1).max(100),
  })
  .strict()
  .superRefine((config, ctx) => {
    if (
      new Set(config.accounts.map((a) => a.accountId)).size !==
        config.accounts.length ||
      new Set(config.apps.map((a) => a.appId)).size !== config.apps.length
    ) {
      ctx.addIssue({ code: "custom", message: "Duplicate account or app." });
    }
    for (const app of config.apps)
      if (!config.accounts.some((a) => a.accountId === app.accountId)) {
        ctx.addIssue({ code: "custom", message: "Unknown account." });
      }
  });

export const refreshInput = z
  .object({
    schemaVersion: z.literal(1),
    appId: idSchema,
    subjectIds: z.array(idSchema).min(1).max(100).optional(),
  })
  .strict();
export const exportInput = z
  .object({ schemaVersion: z.literal(1), appId: idSchema })
  .strict();

export const resultEntrySchema = z
  .object({
    subjectId: idSchema,
    ruleRevision: z.number().int().positive(),
    status: z.enum(["ready", "no-match", "disabled", "pending"]),
    offer: offerSchema.nullable(),
  })
  .strict()
  .refine((entry) => (entry.status === "ready") === (entry.offer !== null));
export type ResultEntry = z.infer<typeof resultEntrySchema>;
export const snapshotSchema = z
  .object({
    schemaVersion: z.literal(1),
    appId: idSchema,
    appRevision: z.number().int().positive(),
    generationId: z.string().uuid(),
    generatedAt: z.number().int().nonnegative(),
    entries: z.array(resultEntrySchema).max(1000),
  })
  .strict();
export type Snapshot = z.infer<typeof snapshotSchema>;

const attributionSchema = z.enum(["DIRECT", "INDIRECT", "UNKNOWN"]);
export const performanceInput = z
  .object({
    schemaVersion: z.literal(1),
    appId: idSchema,
    fromDate: z.iso.date(),
    toDate: z.iso.date(),
    attribution: attributionSchema.optional(),
  })
  .strict()
  .refine((v) => {
    const span = Date.parse(v.toDate) - Date.parse(v.fromDate);
    return span >= 0 && span <= 30 * 86400000;
  });
export const settlementInput = z
  .object({
    schemaVersion: z.literal(1),
    appId: idSchema,
    settlementMonth: z.string().regex(/^[0-9]{4}-(?:0[1-9]|1[0-2])$/),
    attribution: attributionSchema.optional(),
  })
  .strict();
export type PerformanceInput = z.infer<typeof performanceInput>;
export type SettlementInput = z.infer<typeof settlementInput>;

const amount = z.number().finite();
const count = z.number().int().nonnegative();
const timestamp = z.string().max(64).nullable();
export const performanceAmounts = z.object({
  soldQuantity: count,
  refundedQuantity: count,
  salesAmount: amount,
  discountAmount: amount,
  netPaymentAmount: amount,
  expectedCommissionAmount: amount,
  confirmedCommissionAmount: amount,
});
export const performanceSummary = performanceAmounts.extend({
  clickCount: count,
  lastUpdatedAt: timestamp,
});
export const settlementAmounts = z.object({
  orderProductCount: count,
  productAmount: amount,
  promotionCost: amount,
  settlementBase: amount,
  commissionAmount: amount,
  latestConfirmedAt: timestamp,
});
const productReportFields = {
  productId: z.number().int().positive().refine(Number.isSafeInteger),
  productName: z.string().max(1000),
  attribution: attributionSchema,
};
export const performanceItem = performanceAmounts.extend(productReportFields);
export const settlementItem = settlementAmounts.extend(productReportFields);
export const reportSchema = z.discriminatedUnion("kind", [
  z
    .object({
      schemaVersion: z.literal(1),
      kind: z.literal("performance"),
      appId: idSchema,
      collectedAt: z.number().int(),
      fromDate: z.iso.date(),
      toDate: z.iso.date(),
      attribution: attributionSchema.nullable(),
      summary: performanceSummary,
      items: z.array(performanceItem).max(5000),
    })
    .strict(),
  z
    .object({
      schemaVersion: z.literal(1),
      kind: z.literal("settlement"),
      appId: idSchema,
      collectedAt: z.number().int(),
      settlementMonth: z.string(),
      attribution: attributionSchema.nullable(),
      summary: settlementAmounts,
      items: z.array(settlementItem).max(5000),
    })
    .strict(),
]);
export type SharelinkReport = z.infer<typeof reportSchema>;
