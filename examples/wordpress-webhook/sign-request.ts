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

// Print plain text rather than JSON: JSON-escaping would add backslashes to
// every quote, and a copied body would no longer match the signature.
console.log(`endpoint: ${baseUrl}/api/webhooks/task`);
console.log(`x-hooka-timestamp: ${timestamp}`);
console.log(`x-hooka-signature: sha256=${signature}`);
console.log("");
console.log("rawBody (send exactly this line):");
console.log(rawBody);
console.log("");
console.log("curl:");
console.log(
  [
    "curl -sS -X POST",
    `'${baseUrl}/api/webhooks/task'`,
    "-H 'content-type: application/json'",
    `-H 'x-hooka-timestamp: ${timestamp}'`,
    `-H 'x-hooka-signature: sha256=${signature}'`,
    `--data-raw '${rawBody}'`,
  ].join(" "),
);
