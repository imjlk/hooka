import { lstat, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import {
  defineTask,
  defineTaskPack,
  TaskExecutionError,
} from "@hooka/task-sdk";
import { configSchema, id, requestSchema } from "./contracts";
import { digest } from "./engine";
import { aggregateSchema, manifestSchema } from "./measurement";
import { publishDecision, readArtifact } from "./files";
import { RecommendationStore } from "./store";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const registrationTaskInput = z.object({ configDigest: hash }).strict();
const reference = {
  configDigest: hash,
  appId: id,
  artifactId: id,
  artifactDigest: hash,
};
export const ingestTaskInput = z
  .object({ ...reference, kind: z.enum(["manifest", "aggregate"]) })
  .strict();
export const decisionTaskInput = z
  .object({ ...reference, modelGenerationId: id })
  .strict();
export const maintenanceTaskInput = z.object({}).strict();
type Input = z.infer<typeof registrationTaskInput> & {
  appId?: string;
  artifactId?: string;
  artifactDigest?: string;
  kind?: "manifest" | "aggregate";
  modelGenerationId?: string;
};
type Operation =
  | "validate"
  | "ingest"
  | "build"
  | "plan"
  | "export"
  | "status"
  | "prune";
type Env = Record<string, string | undefined>;
function fail(code: string, message: string): never {
  throw new TaskExecutionError(message, { code });
}
function pathEnv(env: Env, name: string) {
  const path = env[name];
  if (!path || !isAbsolute(path))
    fail(
      "recommendations_paths_invalid",
      "Recommendation paths must be trusted absolute paths.",
    );
  return resolve(path);
}
const contains = (root: string, path: string) => {
  const child = relative(root, path);
  return (
    child === "" ||
    (!child.startsWith(`..${sep}`) && child !== ".." && !isAbsolute(child))
  );
};
async function directory(path: string) {
  const canonical = await realpath(path);
  if (!(await stat(canonical)).isDirectory())
    fail(
      "recommendations_paths_invalid",
      "Recommendation root must be an existing directory.",
    );
  return canonical;
}
/** App producers can write files, but cannot redirect reads/publications with symlinks. */
async function childPath(root: string, parts: string[], missing = false) {
  let path = root;
  for (const part of parts) {
    path = join(path, part);
    try {
      if ((await lstat(path)).isSymbolicLink())
        fail(
          "recommendations_paths_invalid",
          "Symlinked recommendation artifact paths are rejected.",
        );
    } catch (error) {
      if (missing && errorCode(error) === "ENOENT") continue;
      throw error;
    }
  }
  return path;
}
function errorCode(error: unknown) {
  return error && typeof error === "object" && "code" in error
    ? error.code
    : null;
}
async function database(env: Env, roots: string[], configPath?: string) {
  const path = await realpath(pathEnv(env, "HOOKA_RECOMMENDATIONS_DB_PATH"));
  const info = await stat(path);
  if (!info.isFile() || roots.some((root) => contains(root, path)))
    fail(
      "recommendations_paths_invalid",
      "Recommendation database must be a private file outside artifact roots.",
    );
  for (const other of [
    configPath,
    env["HOOKA_DB_PATH"],
    env["HOOKA_SHARELINK_DB_PATH"],
  ]) {
    if (!other || other === ":memory:") continue;
    try {
      const otherInfo = await stat(other);
      if (otherInfo.dev === info.dev && otherInfo.ino === info.ino)
        fail(
          "recommendations_paths_invalid",
          "Recommendation database must be distinct from configuration and runtime databases.",
        );
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    }
  }
  // Verify ownership/schema read-only first. Tasks never initialize a blank/foreign DB.
  const probe = await RecommendationStore.open(path, true);
  probe.close();
  return path;
}

/** Operator-only local jobs. No provider, scheduler, initialization or arbitrary payload paths. */
export async function runRecommendationTask(
  operation: Operation,
  input: unknown,
  env: Env,
  dryRun: boolean,
) {
  try {
    if (!dryRun && env["HOOKA_RECOMMENDATIONS_TASKS_ENABLED"] !== "true")
      fail(
        "recommendations_tasks_disabled",
        "Recommendation queue tasks require explicit operator enablement.",
      );
    const schema =
      operation === "ingest"
        ? ingestTaskInput
        : ["plan", "export"].includes(operation)
          ? decisionTaskInput
          : ["status", "prune"].includes(operation)
            ? maintenanceTaskInput
            : registrationTaskInput;
    const bound = schema.parse(input) as Partial<Input>;
    const needsConfig = !["status", "prune"].includes(operation);
    const configPath = needsConfig
      ? await realpath(pathEnv(env, "HOOKA_RECOMMENDATIONS_CONFIG_PATH"))
      : undefined;
    const config = configPath
      ? configSchema.parse(await readArtifact(configPath, 2 * 1024 * 1024))
      : undefined;
    if (config && digest(config) !== bound.configDigest)
      fail(
        "recommendations_config_changed",
        "Queued recommendation registration no longer matches.",
      );
    if (operation === "validate" && config)
      return {
        operation,
        dryRun,
        configDigest: digest(config),
        apps: config.apps.length,
        policies: config.policies.length,
        entities: config.entities.length,
      };

    const inbox = await directory(
      pathEnv(env, "HOOKA_RECOMMENDATIONS_INBOX_PATH"),
    );
    const results = await directory(
      pathEnv(env, "HOOKA_RECOMMENDATIONS_RESULTS_PATH"),
    );
    if (
      contains(inbox, results) ||
      contains(results, inbox) ||
      (configPath &&
        [inbox, results].some((root) => contains(root, configPath)))
    )
      fail(
        "recommendations_paths_invalid",
        "Recommendation configuration, inbox and outbox must be separated.",
      );
    const roots = [inbox, results];
    // Do not put the private model under an existing public Sharelink result root either.
    if (env["HOOKA_SHARELINK_RESULTS_PATH"])
      roots.push(await realpath(pathEnv(env, "HOOKA_SHARELINK_RESULTS_PATH")));
    const domain = await database(env, roots, configPath);
    let artifact: unknown;
    if (["ingest", "plan", "export"].includes(operation)) {
      if (!config || !bound.appId || !bound.artifactId || !bound.artifactDigest)
        fail(
          "recommendations_input_invalid",
          "Missing app-bound recommendation artifact reference.",
        );
      const app = config.apps.find((app) => app.appId === bound.appId);
      if (!app)
        fail("recommendations_app_mismatch", "Unknown recommendation app.");
      const kind = operation === "ingest" ? bound.kind : "request";
      if (!kind)
        fail(
          "recommendations_input_invalid",
          "Missing recommendation artifact kind.",
        );
      const path = await childPath(inbox, [
        app.appId,
        kind,
        `${bound.artifactId}.json`,
      ]);
      artifact = await readArtifact(
        path,
        operation === "ingest" ? 8 * 1024 * 1024 : 2 * 1024 * 1024,
      );
      if (digest(artifact) !== bound.artifactDigest)
        fail(
          "recommendations_artifact_changed",
          "Queued recommendation artifact no longer matches.",
        );
      const parsed =
        kind === "manifest"
          ? manifestSchema.parse(artifact)
          : kind === "aggregate"
            ? aggregateSchema.parse(artifact)
            : requestSchema.parse(artifact);
      if (
        parsed.appId !== app.appId ||
        ("producerId" in parsed && parsed.producerId !== app.producerId) ||
        ("appRevision" in parsed && parsed.appRevision !== app.appRevision)
      )
        fail(
          "recommendations_app_mismatch",
          "Recommendation artifact does not match the registered app.",
        );
      artifact = parsed;
      if (operation === "export" && "requestId" in parsed) {
        await childPath(
          results,
          [app.appId, "requests", parsed.requestId, "decisions"],
          true,
        );
        await childPath(
          results,
          [app.appId, "requests", parsed.requestId, "recommendations.json"],
          true,
        );
      }
    }
    const readonly = dryRun || operation === "plan" || operation === "status";
    const store = await RecommendationStore.open(domain, readonly);
    try {
      if (operation === "status")
        return { operation, dryRun, ...store.status() };
      if (operation === "plan" || operation === "export") {
        const now = Date.now();
        const result =
          dryRun || operation === "plan"
            ? store.plan(config, artifact, now)
            : store.recordDecision(
                config,
                artifact,
                now,
                bound.modelGenerationId,
              );
        if (result.modelGenerationId !== bound.modelGenerationId)
          fail(
            "recommendations_model_changed",
            "Queued recommendation model is no longer current.",
          );
        if (operation === "export" && !dryRun) {
          await childPath(
            results,
            [
              result.appId,
              "requests",
              result.requestId,
              "decisions",
              `${result.decisionId}.json`,
            ],
            true,
          );
          return {
            operation,
            dryRun,
            publication: await publishDecision(
              results,
              result,
              artifact,
              now,
              (action) =>
                store.commitPublication(action, result.modelGenerationId),
            ),
          };
        }
        // Keep operator queue history small; use the offline CLI for full weights/sample previews.
        return {
          operation,
          dryRun,
          appId: result.appId,
          requestId: result.requestId,
          decisionId: result.decisionId,
          modelGenerationId: result.modelGenerationId,
          candidates: result.entries.length,
          publication: null,
        };
      }
      if (dryRun)
        return {
          operation,
          dryRun,
          writes: false,
          validatedArtifact: artifact !== undefined,
          semanticIngestChecked: false,
        };
      if (operation === "ingest" && config)
        return {
          operation,
          dryRun,
          appId: bound.appId,
          ...(bound.kind === "manifest"
            ? store.ingestManifest(config, artifact)
            : store.ingestAggregate(config, artifact)),
        };
      if (operation === "build" && config) {
        const model = store.build(config);
        return {
          operation,
          dryRun,
          modelGenerationId: model.modelGenerationId,
          generatedAt: model.generatedAt,
          rows: model.rows.length,
        };
      }
      if (operation === "prune") return { operation, dryRun, ...store.prune() };
      fail(
        "recommendations_input_invalid",
        "Unsupported recommendation operation.",
      );
    } finally {
      store.close();
    }
  } catch (error) {
    if (error instanceof TaskExecutionError) throw error;
    const code = errorCode(error);
    const retryable = [
      "SQLITE_BUSY",
      "SQLITE_LOCKED",
      "EAGAIN",
      "EBUSY",
      "EMFILE",
      "ENFILE",
    ].includes(String(code));
    throw new TaskExecutionError(
      retryable
        ? "Recommendation storage temporarily unavailable; retry safely."
        : "Recommendation task rejected; check the private configuration, artifact and store offline.",
      {
        code: retryable
          ? "recommendations_storage_busy"
          : "recommendations_operation_rejected",
        retryable,
      },
    );
  }
}

const task = <T extends z.ZodType>(
  operation: Operation,
  schema: T,
  description: string,
) =>
  defineTask({
    id: `recommendations.${operation}`,
    title: `Recommendation ${operation}`,
    description,
    input: schema,
    requires: ["recommendations"],
    tags: ["recommendations", "offline"],
    executor: {
      kind: "internal",
      run: ({ input, env, dryRun }) =>
        runRecommendationTask(operation, input, env, dryRun),
    },
  });
export const recommendationTaskPack = defineTaskPack({
  id: "@hooka/pack-recommendations",
  title: "Recommendation Automation Pack",
  description:
    "Operator-owned offline learning and app-scoped publication using the existing queue.",
  tasks: [
    task(
      "validate",
      registrationTaskInput,
      "Validate the digest-bound operator registration without a DB.",
    ),
    task(
      "ingest",
      ingestTaskInput,
      "Ingest a digest-bound app manifest or complete daily aggregate.",
    ),
    task(
      "build",
      registrationTaskInput,
      "Build a sealed model from retained accepted evidence.",
    ),
    task(
      "plan",
      decisionTaskInput,
      "Preview a digest-bound request against the expected current model without writes.",
    ),
    task(
      "export",
      decisionTaskInput,
      "Record and publish a digest-bound decision into its app outbox.",
    ),
    task(
      "status",
      maintenanceTaskInput,
      "Read private model freshness and retained coverage without writes.",
    ),
    task(
      "prune",
      maintenanceTaskInput,
      "Prune expired evidence with existing replay protections.",
    ),
  ],
});
