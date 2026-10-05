import { join } from "node:path";
import { Database } from "bun:sqlite";
import {
  configSchema,
  RecommendationStore,
  digest,
  DAY,
} from "@hooka/pack-recommendations";
import { recommendationBindingsSchema } from "./recommendations";
import type { App } from "./contracts";

/** Synthetic sealed evidence in a real offline store; never resolves provider credentials. */
export async function recommendationFixture(
  directory: string,
  app: App,
  now = Date.now(),
) {
  const source = app.subjects[0];
  if (!source) throw Error("Missing subject fixture");
  const config = configSchema.parse({
    schemaVersion: 1,
    policies: [{ policyId: "ctr", version: 1 }],
    entities: ["123", "124", "125", "126"].map((productId, index) => ({
      entityRef: `product-${index}`,
      provider: "toss-sharelink",
      catalogScope: "kr",
      productId,
    })),
    apps: [
      {
        appId: app.appId,
        appRevision: 7,
        producerId: "fixture-backend",
        contexts: [
          { contextId: "low-ready", measurementProfileId: "word-full-1s-v1" },
        ],
        subjects: [
          {
            subjectId: source.subjectId,
            ruleRevision: 9,
            entityRefs: ["product-0", "product-1", "product-2", "product-3"],
          },
        ],
      },
    ],
  });
  const bindings = recommendationBindingsSchema.parse({
    schemaVersion: 1,
    apps: [
      {
        appId: app.appId,
        sharelinkRevision: app.revision,
        recommendationRevision: 7,
        policyId: "ctr",
        policyVersion: 1,
        contextId: "low-ready",
        measurementProfileId: "word-full-1s-v1",
        catalogScope: "kr",
        subjects: [
          {
            subjectId: source.subjectId,
            sharelinkRuleRevision: source.revision,
            recommendationRuleRevision: 9,
          },
        ],
      },
    ],
  });
  const configPath = join(directory, "recommendation-config.json"),
    bindingPath = join(directory, "recommendation-bindings.json"),
    dbPath = join(directory, "learning.sqlite");
  await Bun.write(configPath, JSON.stringify(config));
  await Bun.write(bindingPath, JSON.stringify(bindings));
  const store = await RecommendationStore.open(dbPath);
  store.build(config, now);
  store.close();
  const model = {
    schemaVersion: 1,
    modelGenerationId: "fixture-ranked",
    generatedAt: now,
    rows: config.entities.map((e, index) => ({
      appId: app.appId,
      subjectId: source.subjectId,
      ruleRevision: 9,
      mappingVersion: 1,
      entityRef: e.entityRef,
      contextId: "low-ready",
      measurementProfileId: "word-full-1s-v1",
      day: Math.floor(now / DAY) * DAY - 3 * DAY,
      experiment: "training",
      exposures: 1000,
      clicks: index === 3 ? 900 : 0,
      dispatches: 0,
    })),
  };
  const db = new Database(dbPath);
  db.query("INSERT INTO rec_models VALUES(?,?,?,?)").run(
    model.modelGenerationId,
    digest(config),
    JSON.stringify(model),
    now,
  );
  db.query("UPDATE rec_meta SET value=? WHERE key='current'").run(
    model.modelGenerationId,
  );
  db.close();
  return {
    config,
    bindings,
    model,
    dbPath,
    configPath,
    bindingPath,
    env: {
      HOOKA_SHARELINK_RECOMMENDATIONS_ENABLED: "true",
      HOOKA_SHARELINK_RECOMMENDATIONS_BINDINGS_PATH: bindingPath,
      HOOKA_RECOMMENDATIONS_CONFIG_PATH: configPath,
      HOOKA_RECOMMENDATIONS_DB_PATH: dbPath,
    },
  };
}
