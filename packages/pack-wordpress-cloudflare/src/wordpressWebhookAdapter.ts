import type { IncomingTaskWebhook } from "@hooka/contracts";
import type { CompatibilityWebhookAdapter } from "@hooka/task-sdk";
import {
  wordpressSimplyStaticWebhookSchema,
  type WordpressSimplyStaticWebhook,
} from "./schema";

export const wordpressSimplyStaticWebhookAdapter: CompatibilityWebhookAdapter =
  {
    id: "wordpress.simply-static",
    routePath: "/api/webhooks/wordpress/simply-static",
    normalize(rawBody: string): IncomingTaskWebhook {
      return normalizeWordpressSimplyStaticWebhook(
        parseWordpressSimplyStaticWebhook(rawBody),
      );
    },
  };

export function parseWordpressSimplyStaticWebhook(
  rawBody: string,
): WordpressSimplyStaticWebhook {
  return wordpressSimplyStaticWebhookSchema.parse(JSON.parse(rawBody));
}

export function normalizeWordpressSimplyStaticWebhook(
  payload: WordpressSimplyStaticWebhook,
): IncomingTaskWebhook {
  const input = {
    kind: "pages-deploy",
    project: payload.project,
    sourcePath: payload.exportDir,
    branch: payload.branch,
    commitSha: payload.commitSha,
    commitMessage: payload.commitMessage,
    commitDirty: payload.commitDirty,
    skipCaching: payload.skipCaching,
    noBundle: payload.noBundle,
    uploadSourceMaps: payload.uploadSourceMaps,
  };

  if (payload.targetId) {
    return {
      targetId: payload.targetId,
      overrides: toTargetOverrides(input),
      eventId: payload.eventId,
      source: "wordpress.webhook",
      triggeredAt: payload.triggeredAt,
    };
  }

  return {
    taskId: "deploy.shared-volume.wrangler",
    input,
    eventId: payload.eventId,
    source: "wordpress.webhook",
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
