import type { GenericTaskWebhook } from "@hooka/contracts";
import type { CompatibilityWebhookAdapter } from "@hooka/task-sdk";
import {
  wordpressSimplyStaticWebhookSchema,
  type WordpressSimplyStaticWebhook,
} from "./schema";

export const wordpressSimplyStaticWebhookAdapter: CompatibilityWebhookAdapter = {
  id: "wordpress.simply-static",
  routePath: "/api/webhooks/wordpress/simply-static",
  normalize(rawBody: string): GenericTaskWebhook {
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
): GenericTaskWebhook {
  return {
    taskId: "deploy.shared-volume.wrangler",
    input: {
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
    },
    eventId: payload.eventId,
    source: "wordpress.webhook",
    triggeredAt: payload.triggeredAt,
  };
}
