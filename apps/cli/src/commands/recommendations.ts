import { z } from "zod";
import {
  configSchema,
  RecommendationStore,
  readArtifact,
  publishDecision,
} from "@hooka/pack-recommendations";
import { defineCommand, defineGroup, option } from "../lib/command";

export function createRecommendationsCommandGroup() {
  const config = option(
    z
      .string()
      .min(1)
      .default(Bun.env["HOOKA_RECOMMENDATIONS_CONFIG_PATH"] ?? ""),
    { description: "Operator registration JSON path." },
  );
  const domain = option(
    z
      .string()
      .min(1)
      .default(Bun.env["HOOKA_RECOMMENDATIONS_DB_PATH"] ?? ""),
    { description: "Dedicated private recommendation SQLite file." },
  );
  const artifact = option(z.string().min(1), {
    description: "Operator-owned local input artifact path.",
  });
  const print = (value: unknown) => console.log(JSON.stringify(value, null, 2));
  const loadConfig = async (path: string) =>
    configSchema.parse(await readArtifact(path, 2 * 1024 * 1024));
  const open = async (path: string, readonly: boolean, create = false) => {
    if (!create && !(await Bun.file(path).exists()))
      throw new Error("Initialize the recommendation DB explicitly first.");
    return RecommendationStore.open(path, readonly);
  };
  return defineGroup({
    name: "recommendations",
    description: "Offline app-scoped recommendation learning and previews.",
    commands: [
      defineCommand({
        name: "validate",
        description: "Validate registration offline without a database.",
        options: { config },
        handler: async ({ flags }) => {
          const data = await loadConfig(flags.config);
          print({
            ok: true,
            apps: data.apps.length,
            policies: data.policies.length,
            entities: data.entities.length,
          });
        },
      }),
      defineCommand({
        name: "init",
        description: "Explicitly initialize a dedicated private database.",
        options: { domain },
        handler: async ({ flags }) => {
          const store = await open(flags.domain, false, true);
          try {
            print(store.status());
          } finally {
            store.close();
          }
        },
      }),
      defineCommand({
        name: "status",
        description:
          "Read status without initializing or migrating a database.",
        options: { domain },
        handler: async ({ flags }) => {
          const store = await open(flags.domain, true);
          try {
            print(store.status());
          } finally {
            store.close();
          }
        },
      }),
      defineCommand({
        name: "build",
        description:
          "Build a complete sealed model from retained accepted aggregates.",
        options: { config, domain },
        handler: async ({ flags }) => {
          const data = await loadConfig(flags.config),
            store = await open(flags.domain, false);
          try {
            const model = store.build(data);
            print({
              modelGenerationId: model.modelGenerationId,
              rows: model.rows.length,
              generatedAt: model.generatedAt,
            });
          } finally {
            store.close();
          }
        },
      }),
      defineCommand({
        name: "ingest",
        description:
          "Validate and ingest a complete app backend manifest or daily aggregate.",
        options: {
          config,
          domain,
          artifact,
          kind: option(z.enum(["manifest", "aggregate"]), {
            description: "Artifact contract kind.",
          }),
        },
        handler: async ({ flags }) => {
          const data = await loadConfig(flags.config),
            input = await readArtifact(flags.artifact, 8 * 1024 * 1024),
            store = await open(flags.domain, false);
          try {
            print(
              flags.kind === "manifest"
                ? store.ingestManifest(data, input)
                : store.ingestAggregate(data, input),
            );
          } finally {
            store.close();
          }
        },
      }),
      defineCommand({
        name: "plan",
        description:
          "Preview scoring and sampling using a read-only store; no writes or provider calls.",
        options: { config, domain, artifact },
        handler: async ({ flags }) => {
          const data = await loadConfig(flags.config),
            input = await readArtifact(flags.artifact, 2 * 1024 * 1024),
            store = await open(flags.domain, true);
          try {
            print(store.plan(data, input));
          } finally {
            store.close();
          }
        },
      }),
      defineCommand({
        name: "export",
        description:
          "Record a decision and atomically publish it to the app outbox.",
        options: {
          config,
          domain,
          artifact,
          results: option(
            z
              .string()
              .min(1)
              .default(Bun.env["HOOKA_RECOMMENDATIONS_RESULTS_PATH"] ?? ""),
            { description: "Operator-owned app outbox root." },
          ),
        },
        handler: async ({ flags }) => {
          const data = await loadConfig(flags.config),
            input = await readArtifact(flags.artifact, 2 * 1024 * 1024),
            store = await open(flags.domain, false);
          try {
            const now = Date.now();
            const result = store.recordDecision(data, input, now);
            print(
              await publishDecision(
                flags.results,
                result,
                input,
                now,
                (action) => store.commitPublication(action),
              ),
            );
          } finally {
            store.close();
          }
        },
      }),
      defineCommand({
        name: "prune",
        description:
          "Prune retained aggregates and evidence; older days remain ineligible for replay.",
        options: { domain },
        handler: async ({ flags }) => {
          const store = await open(flags.domain, false);
          try {
            print(store.prune());
          } finally {
            store.close();
          }
        },
      }),
    ],
  });
}
