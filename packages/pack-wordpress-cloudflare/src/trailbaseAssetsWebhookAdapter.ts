import type { IncomingTaskWebhook } from "@hooka/contracts";
import type { CompatibilityWebhookAdapter } from "@hooka/task-sdk";
import {
  type TrailBaseAssetsDrainedWebhook,
  trailbaseAssetsDrainedWebhookSchema,
} from "./schema";

export const trailbaseAssetsDrainedWebhookAdapter: CompatibilityWebhookAdapter =
  {
    id: "trailbase.assets-drained",
    routePath: "/api/webhooks/trailbase/assets-drained",
    normalize(rawBody: string): IncomingTaskWebhook {
      return normalizeTrailBaseAssetsDrainedWebhook(
        parseTrailBaseAssetsDrainedWebhook(rawBody),
      );
    },
  };

export function parseTrailBaseAssetsDrainedWebhook(
  rawBody: string,
): TrailBaseAssetsDrainedWebhook {
  return trailbaseAssetsDrainedWebhookSchema.parse(JSON.parse(rawBody));
}

export function normalizeTrailBaseAssetsDrainedWebhook(
  payload: TrailBaseAssetsDrainedWebhook,
): IncomingTaskWebhook {
  const input = {
    kind: "pages-deploy",
    project: payload.project,
    sourcePath: payload.sourcePath,
    branch: payload.branch,
    commitMessage: buildCommitMessage(payload),
    noBundle: true,
  };

  if (payload.targetId) {
    return {
      targetId: payload.targetId,
      overrides: toTargetOverrides(input),
      eventId: payload.idempotencyKey,
      source: payload.source,
      triggeredAt: payload.triggeredAt,
    };
  }

  return {
    taskId: payload.taskId,
    input,
    eventId: payload.idempotencyKey,
    source: payload.source,
    triggeredAt: payload.triggeredAt,
  };
}

function toTargetOverrides(
  input: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(input).filter(
      ([key, value]) => key !== "kind" && value !== undefined,
    ),
  );
}

function buildCommitMessage(payload: TrailBaseAssetsDrainedWebhook): string {
  const failedSuffix =
    payload.failedCount > 0 ? `, failed=${payload.failedCount}` : "";
  const latestSuffix =
    payload.latestAssetUpdatedAt === undefined
      ? ""
      : `, latest=${payload.latestAssetUpdatedAt}`;
  const staticSuffix = payload.staticRevision
    ? `, static=${payload.staticRevision}`
    : "";
  return `TrailBase full static deploy: ready=${payload.readyCount}${failedSuffix}${latestSuffix}${staticSuffix}`;
}
