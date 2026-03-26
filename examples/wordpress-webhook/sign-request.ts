import { createHmac } from "node:crypto";

const webhookSecret = Bun.env.HOOKA_WEBHOOK_SECRET ?? "local-secret";
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
      timestamp,
      signature: `sha256=${signature}`,
      body: payload,
    },
    null,
    2,
  ),
);
