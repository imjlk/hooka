import { createHmac } from "node:crypto";

// Signs a generic task webhook the same way a producer should: the HMAC covers
// `${timestamp}.${rawBody}`, where rawBody is the exact request body sent. The
// timestamp must be within five minutes of the server clock.
const webhookSecret = Bun.env["HOOKA_WEBHOOK_SECRET"] ?? "local-secret";
const baseUrl = Bun.env["HOOKA_URL"] ?? "http://localhost:3000";
const timestamp = String(Math.floor(Date.now() / 1000));
const payload = {
  taskId: "deploy.shared-volume.wrangler",
  input: {
    kind: "pages-deploy",
    project: "staging-site",
    sourcePath: "/shared-source/simply-static",
    branch: "main",
  },
  eventId: `evt_${Date.now()}`,
  source: "wordpress.webhook",
  triggeredAt: new Date().toISOString(),
};
const rawBody = JSON.stringify(payload);
const signature = createHmac("sha256", webhookSecret)
  .update(`${timestamp}.${rawBody}`)
  .digest("hex");

console.log(
  JSON.stringify(
    {
      endpoint: "/api/webhooks/task",
      headers: {
        "x-hooka-timestamp": timestamp,
        "x-hooka-signature": `sha256=${signature}`,
      },
      // Send this string byte for byte; re-serializing the JSON changes the
      // signature input.
      rawBody,
      curl: [
        "curl -sS -X POST",
        `'${baseUrl}/api/webhooks/task'`,
        "-H 'content-type: application/json'",
        `-H 'x-hooka-timestamp: ${timestamp}'`,
        `-H 'x-hooka-signature: sha256=${signature}'`,
        `--data-raw '${rawBody}'`,
      ].join(" "),
    },
    null,
    2,
  ),
);
