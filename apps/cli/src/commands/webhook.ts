import { defineCommand, defineGroup, option } from "@bunli/core";
import { createHmac } from "node:crypto";
import { z } from "zod";

export function createWebhookCommandGroup() {
  return defineGroup({
    name: "webhook",
    description: "Send signed webhook requests to a Hooka server.",
    commands: [
      defineCommand({
        name: "test",
        description: "Send a signed generic task webhook to /api/webhooks/task.",
        options: {
          url: option(
            z.string().default(
              `http://127.0.0.1:${Bun.env.HOOKA_PORT ?? "3000"}/api/webhooks/task`,
            ),
            {
              description: "Absolute webhook target URL.",
            },
          ),
          secret: option(z.string().optional(), {
            description:
              "Webhook secret. Falls back to HOOKA_WEBHOOK_SECRET when omitted.",
          }),
          source: option(z.string().default("cli.webhook-test"), {
            description: "Source label written into the webhook payload.",
          }),
          "task-id": option(z.string(), {
            description: "Task id for the generic webhook payload.",
          }),
          "payload-json": option(z.string().optional(), {
            description: "Inline JSON object for the task input payload.",
          }),
          "payload-file": option(z.string().optional(), {
            description: "Path to a JSON file for the task input payload.",
          }),
          "event-id": option(z.string().optional(), {
            description: "Explicit event id. Defaults to a generated UUID.",
          }),
          timestamp: option(z.coerce.number().int().positive().optional(), {
            description:
              "Unix timestamp override used for the HMAC signature and header.",
          }),
        },
        handler: async ({ flags }) => {
          const secret = flags.secret ?? Bun.env.HOOKA_WEBHOOK_SECRET;

          if (!secret) {
            throw new Error(
              "Provide --secret or set HOOKA_WEBHOOK_SECRET to sign the webhook.",
            );
          }

          const input = await loadWebhookPayload(flags);
          const timestamp =
            flags.timestamp ?? Math.floor(Date.now() / 1000);
          const payload = {
            taskId: flags["task-id"],
            input,
            eventId: flags["event-id"] ?? crypto.randomUUID(),
            source: flags.source,
          };
          const rawBody = JSON.stringify(payload);
          const signature = createHmac("sha256", secret)
            .update(`${timestamp}.${rawBody}`)
            .digest("hex");

          const response = await fetch(flags.url, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-hooka-timestamp": String(timestamp),
              "x-hooka-signature": `sha256=${signature}`,
            },
            body: rawBody,
          });

          const rawResponse = await response.text();
          console.log(
            JSON.stringify(
              {
                status: response.status,
                body: tryParseJson(rawResponse),
              },
              null,
              2,
            ),
          );

          if (!response.ok) {
            process.exitCode = 1;
          }
        },
      }),
    ],
  });
}

async function loadWebhookPayload(
  flags: Record<string, unknown>,
): Promise<unknown> {
  if (
    typeof flags["payload-file"] === "string" &&
    flags["payload-file"].length > 0
  ) {
    return JSON.parse(await Bun.file(flags["payload-file"]).text());
  }

  if (
    typeof flags["payload-json"] === "string" &&
    flags["payload-json"].length > 0
  ) {
    return JSON.parse(flags["payload-json"]);
  }

  throw new Error("Provide either --payload-json or --payload-file.");
}

function tryParseJson(value: string): unknown {
  if (value.length === 0) {
    return null;
  }

  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}
