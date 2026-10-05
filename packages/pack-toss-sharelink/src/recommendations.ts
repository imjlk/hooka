import { isAbsolute, resolve } from "node:path";
import { z } from "zod";
import {
  configSchema as recommendationConfigSchema,
  requestSchema,
  RecommendationStore,
  readArtifact,
  validateRecommendations,
  digest,
  type Config,
  type Request,
  type Result,
} from "@hooka/pack-recommendations";
import { idSchema, type App, type Subject } from "./contracts";
import type { Product } from "./provider";

const revision = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
/** Independent operator binding: consumer recommendation revisions need not equal Sharelink revisions. */
export const recommendationBindingsSchema = z
  .object({
    schemaVersion: z.literal(1),
    apps: z
      .array(
        z
          .object({
            appId: idSchema,
            sharelinkRevision: revision,
            recommendationRevision: revision,
            policyId: idSchema,
            policyVersion: revision,
            contextId: idSchema,
            measurementProfileId: idSchema,
            catalogScope: idSchema,
            subjects: z
              .array(
                z
                  .object({
                    subjectId: idSchema,
                    sharelinkRuleRevision: revision,
                    recommendationRuleRevision: revision,
                  })
                  .strict(),
              )
              .max(1000)
              .refine(
                (rows) =>
                  new Set(rows.map((r) => r.subjectId)).size === rows.length,
              ),
          })
          .strict(),
      )
      .min(1)
      .max(100)
      .refine((rows) => new Set(rows.map((r) => r.appId)).size === rows.length),
  })
  .strict();
export type RecommendationBindings = z.infer<
  typeof recommendationBindingsSchema
>;
export type OrderingDiagnostic = {
  status: "scored" | "baseline";
  reason:
    | "scored-known-subset"
    | "uniform-prior"
    | "no-registered-products"
    | "binding-mismatch"
    | "unavailable-model-or-config";
  ranked: number;
  eligible: number;
  modelGenerationId?: string;
  decisionId?: string;
};

/** Build a product request only from reviewed identities on this already-observed eligible page. */
export function productOrderingRequest(
  config: Config,
  bindings: RecommendationBindings,
  app: App,
  subject: Subject,
  products: Product[],
  now: number,
): { request: Request; slots: number[] } | null {
  if (
    products.length > 1000 ||
    new Set(products.map((p) => p.id)).size !== products.length
  )
    throw Error("Invalid observed candidate page.");
  const binding = bindings.apps.find((b) => b.appId === app.appId);
  const rule = binding?.subjects.find((s) => s.subjectId === subject.subjectId);
  const registered = config.apps.find((a) => a.appId === app.appId);
  const registeredSubject = registered?.subjects.find(
    (s) => s.subjectId === subject.subjectId,
  );
  if (
    !binding ||
    !rule ||
    binding.sharelinkRevision !== app.revision ||
    rule.sharelinkRuleRevision !== subject.revision ||
    !registeredSubject?.enabled ||
    registered?.appRevision !== binding.recommendationRevision ||
    registeredSubject.ruleRevision !== rule.recommendationRuleRevision
  )
    throw Error("Stale Sharelink recommendation binding.");
  const approvedEntities = new Set(registeredSubject.entityRefs);
  const productsById = new Map(
    config.entities
      .filter(
        (e) =>
          e.provider === "toss-sharelink" &&
          e.catalogScope === binding.catalogScope &&
          approvedEntities.has(e.entityRef),
      )
      .map((e) => [e.productId, e.entityRef]),
  );
  const slots: number[] = [];
  const candidates = products.flatMap((product, index) => {
    const entityRef = productsById.get(product.id);
    if (!entityRef) return [];
    slots.push(index);
    return [
      {
        subjectId: subject.subjectId,
        ruleRevision: rule.recommendationRuleRevision,
        entityRef,
      },
    ];
  });
  if (!candidates.length) return null;
  const identity = [
    app.appId,
    app.revision,
    subject.subjectId,
    subject.revision,
    binding,
    candidates,
    Math.floor(now / 60000),
  ];
  return {
    slots,
    request: requestSchema.parse({
      schemaVersion: 1,
      requestId: `sl-${digest(identity).slice(0, 60)}`,
      appId: app.appId,
      appRevision: binding.recommendationRevision,
      policyId: binding.policyId,
      policyVersion: binding.policyVersion,
      contextId: binding.contextId,
      measurementProfileId: binding.measurementProfileId,
      kind: "product",
      generatedAt: now,
      expiresAt: now + 60000,
      seed: digest(identity),
      candidates,
    }),
  };
}

/** Unknown products keep their original slots; equal weights keep provider order. */
export function applyProductOrdering(
  products: Product[],
  prepared: { request: Request; slots: number[] },
  result: Result,
  now: number,
) {
  const accepted = validateRecommendations(result, prepared.request, now);
  if (
    !accepted ||
    prepared.slots.length !== accepted.entries.length ||
    new Set(prepared.slots).size !== prepared.slots.length ||
    prepared.slots.some(
      (i) => !Number.isInteger(i) || i < 0 || i >= products.length,
    )
  )
    throw Error("Invalid product ordering result.");
  const weights = new Map(accepted.entries.map((e) => [e.entityRef, e.weight]));
  const ordered = prepared.slots
    .map((slot, index) => {
      const product = products[slot],
        candidate = prepared.request.candidates[index];
      const weight = candidate ? weights.get(candidate.entityRef) : undefined;
      if (!product || weight === undefined)
        throw Error("Incomplete observed product binding.");
      return { product, slot, weight };
    })
    .sort((a, b) => b.weight - a.weight || a.slot - b.slot);
  const output = [...products];
  ordered.forEach((row, index) => {
    const target = prepared.slots[index];
    if (target === undefined) throw Error("Missing observed slot.");
    output[target] = row.product;
  });
  return output;
}

export async function rankSharelinkProducts(
  products: Product[],
  app: App,
  subject: Subject,
  env: Record<string, string | undefined>,
  now = Date.now(),
): Promise<{ products: Product[]; diagnostic?: OrderingDiagnostic }> {
  // Do not open files or databases when the extension is disabled or precedence applies.
  if (
    env["HOOKA_SHARELINK_RECOMMENDATIONS_ENABLED"] !== "true" ||
    subject.pinnedProductId ||
    (subject.manual &&
      subject.manual.reviewedAt <= now &&
      subject.manual.reviewUntil > now)
  )
    return { products };
  const baseline = (reason: OrderingDiagnostic["reason"]) => ({
    products,
    diagnostic: {
      status: "baseline" as const,
      reason,
      eligible: products.length,
      ranked: 0,
    },
  });
  let store: RecommendationStore | undefined;
  try {
    const bindingPath = env["HOOKA_SHARELINK_RECOMMENDATIONS_BINDINGS_PATH"],
      configPath = env["HOOKA_RECOMMENDATIONS_CONFIG_PATH"],
      dbPath = env["HOOKA_RECOMMENDATIONS_DB_PATH"];
    if (
      !bindingPath ||
      !configPath ||
      !dbPath ||
      ![bindingPath, configPath, dbPath].every(isAbsolute) ||
      [
        env["HOOKA_DB_PATH"] ?? "/data/hooka.sqlite",
        env["HOOKA_SHARELINK_DB_PATH"],
      ].some((p) => p && resolve(p) === resolve(dbPath)) ||
      [
        env["HOOKA_SHARELINK_RESULTS_PATH"],
        env["HOOKA_RECOMMENDATIONS_RESULTS_PATH"],
      ].some(
        (p) =>
          p &&
          (resolve(dbPath) === resolve(p) ||
            resolve(dbPath).startsWith(`${resolve(p)}/`)),
      )
    )
      return baseline("unavailable-model-or-config");
    const bindings = recommendationBindingsSchema.parse(
      await readArtifact(bindingPath, 2097152),
    );
    const config = recommendationConfigSchema.parse(
      await readArtifact(configPath, 2097152),
    );
    let prepared: ReturnType<typeof productOrderingRequest> = null;
    try {
      prepared = productOrderingRequest(
        config,
        bindings,
        app,
        subject,
        products,
        now,
      );
    } catch {
      return baseline("binding-mismatch");
    }
    if (!prepared) return baseline("no-registered-products");
    if (!(await Bun.file(dbPath).exists()))
      return baseline("unavailable-model-or-config");
    store = await RecommendationStore.open(dbPath, true);
    const result = store.plan(config, prepared.request, now);
    const output = applyProductOrdering(products, prepared, result, now);
    const first = result.entries[0];
    if (!first) throw Error("Missing scored candidate.");
    const uniform = result.entries.every((e) => e.weight === first.weight);
    return {
      products: output,
      diagnostic: {
        status: "scored",
        reason: uniform ? "uniform-prior" : "scored-known-subset",
        eligible: products.length,
        ranked: prepared.slots.length,
        modelGenerationId: result.modelGenerationId,
        decisionId: result.decisionId,
      },
    };
  } catch {
    return baseline("unavailable-model-or-config");
  } finally {
    store?.close();
  }
}
