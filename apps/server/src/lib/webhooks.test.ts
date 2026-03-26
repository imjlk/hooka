import { expect, test } from "bun:test";
import {
  normalizeWordpressSimplyStaticWebhook,
  parseGenericTaskWebhook,
  parseWordpressSimplyStaticWebhook,
  verifyHookaHmacSignature,
} from "./webhooks";
import { createHmac } from "node:crypto";

test("valid hmac signature is accepted", () => {
  const rawBody = JSON.stringify({
    eventId: "evt_1",
    project: "staging-site",
    exportDir: "/shared-source/simply-static",
  });
  const timestamp = "1774483200";
  const signature = createHmac("sha256", "secret")
    .update(`${timestamp}.${rawBody}`)
    .digest("hex");

  expect(
    verifyHookaHmacSignature({
      secret: "secret",
      timestampHeader: timestamp,
      signatureHeader: `sha256=${signature}`,
      rawBody,
      nowMs: 1774483200 * 1000,
    }),
  ).toEqual({
    ok: true,
  });
});

test("invalid hmac signature is rejected", () => {
  expect(
    verifyHookaHmacSignature({
      secret: "secret",
      timestampHeader: "1774483200",
      signatureHeader: "sha256=bad",
      rawBody: "{}",
      nowMs: 1774483200 * 1000,
    }),
  ).toMatchObject({
    ok: false,
    status: 401,
  });
});

test("wordpress webhook payload is validated", () => {
  const parsed = parseWordpressSimplyStaticWebhook(
    JSON.stringify({
      eventId: "evt_2",
      project: "customer-site",
      exportDir: "/shared-source/simply-static",
      triggeredAt: "2026-03-26T00:00:00.000Z",
    }),
  );

  expect(parsed.project).toBe("customer-site");
});

test("generic task webhook payload is validated", () => {
  const parsed = parseGenericTaskWebhook(
    JSON.stringify({
      taskId: "deploy.shared-volume.wrangler",
      input: {
        kind: "pages-deploy",
        project: "staging-site",
        sourcePath: "/shared-source/simply-static",
      },
      eventId: "evt_3",
      source: "wordpress.webhook",
    }),
  );

  expect(parsed.taskId).toBe("deploy.shared-volume.wrangler");
});

test("wordpress payload normalizes into generic task webhook payload", () => {
  const normalized = normalizeWordpressSimplyStaticWebhook({
    eventId: "evt_4",
    project: "staging-site",
    exportDir: "/shared-source/simply-static",
    branch: "main",
  });

  expect(normalized).toMatchObject({
    taskId: "deploy.shared-volume.wrangler",
    eventId: "evt_4",
    source: "wordpress.webhook",
    input: {
      kind: "pages-deploy",
      project: "staging-site",
      sourcePath: "/shared-source/simply-static",
      branch: "main",
    },
  });
});
