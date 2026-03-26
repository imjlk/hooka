import { expect, test } from "bun:test";
import {
  parseWordpressSimplyStaticWebhook,
  verifyHookaHmacSignature,
} from "./webhooks";
import { createHmac } from "node:crypto";

test("valid hmac signature is accepted", () => {
  const rawBody = JSON.stringify({
    eventId: "evt_1",
    project: "staging-site",
    exportDir: "/tmp/export",
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
      project: "main-site",
      exportDir: "/tmp/export",
      triggeredAt: "2026-03-26T00:00:00.000Z",
    }),
  );

  expect(parsed.project).toBe("main-site");
});
