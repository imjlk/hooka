import {
  enqueueRunRequestSchema,
  genericTaskWebhookSchema,
} from "@hooka/contracts";
import type { EnqueueRunRequest, GenericTaskWebhook } from "@hooka/contracts";
import { createHmac, timingSafeEqual } from "node:crypto";

const allowedClockSkewSeconds = 300;

export function verifyHookaHmacSignature(input: {
  secret: string;
  timestampHeader: string | null;
  signatureHeader: string | null;
  rawBody: string;
  nowMs?: number;
}): { ok: true } | { ok: false; status: number; error: string } {
  const timestampValue = input.timestampHeader?.trim();
  const signatureValue = input.signatureHeader?.trim();

  if (!timestampValue || !signatureValue) {
    return {
      ok: false,
      status: 401,
      error: "Missing webhook signature headers.",
    };
  }

  const timestamp = Number(timestampValue);

  if (!Number.isInteger(timestamp)) {
    return {
      ok: false,
      status: 400,
      error: "Invalid x-hooka-timestamp header.",
    };
  }

  const nowSeconds = Math.floor((input.nowMs ?? Date.now()) / 1000);
  if (Math.abs(nowSeconds - timestamp) > allowedClockSkewSeconds) {
    return {
      ok: false,
      status: 401,
      error: "Webhook timestamp is outside the allowed skew window.",
    };
  }

  const provided = signatureValue.startsWith("sha256=")
    ? signatureValue.slice("sha256=".length)
    : signatureValue;
  const expected = createHmac("sha256", input.secret)
    .update(`${timestamp}.${input.rawBody}`)
    .digest("hex");

  const providedBuffer = Buffer.from(provided, "utf8");
  const expectedBuffer = Buffer.from(expected, "utf8");

  if (
    providedBuffer.length !== expectedBuffer.length ||
    !timingSafeEqual(providedBuffer, expectedBuffer)
  ) {
    return {
      ok: false,
      status: 401,
      error: "Webhook signature verification failed.",
    };
  }

  return {
    ok: true,
  };
}

export function parseGenericTaskWebhook(rawBody: string) {
  return genericTaskWebhookSchema.parse(JSON.parse(rawBody));
}

export function normalizeGenericTaskWebhook(
  payload: GenericTaskWebhook,
): EnqueueRunRequest {
  return enqueueRunRequestSchema.parse({
    taskId: payload.taskId,
    input: payload.input,
    source: payload.source,
    sourceEventId: payload.eventId,
  });
}
