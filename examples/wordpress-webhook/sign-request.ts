import { createHmac } from "node:crypto";

const webhookSecret = Bun.env.HOOKA_WEBHOOK_SECRET ?? "local-secret";
const timestamp = String(Math.floor(Date.now() / 1000));
const payload = {
  eventId: `evt_${Date.now()}`,
  project: "staging-site",
  exportDir: "/data/exports/simply-static",
  branch: "main",
  triggeredAt: new Date().toISOString(),
};
const rawBody = JSON.stringify(payload);
const signature = createHmac("sha256", webhookSecret)
  .update(`${timestamp}.${rawBody}`)
  .digest("hex");

console.log(
  JSON.stringify(
    {
      timestamp,
      signature: `sha256=${signature}`,
      body: payload,
    },
    null,
    2,
  ),
);
