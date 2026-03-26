import { createRunStore, defaultHookaDbPath } from "@hooka/run-store";
import { resolve } from "node:path";
import { createHookaFetchHandler } from "./app";

const port = Number(Bun.env.HOOKA_PORT ?? 3000);
const dbPath = Bun.env.HOOKA_DB_PATH ?? defaultHookaDbPath;
const uiDistDir = resolve(process.cwd(), "packages/admin-ui/dist");
const capabilityManifestPath = resolve(
  process.cwd(),
  "docker/manifests/installed-capabilities.json",
);
const runStore = await createRunStore({
  dbPath,
});

const server = Bun.serve({
  port,
  idleTimeout: 30,
  fetch: createHookaFetchHandler({
    capabilityManifestPath,
    runStore,
    uiDistDir,
    webhookSecret: Bun.env.HOOKA_WEBHOOK_SECRET,
  }),
});

console.log(`Hooka server listening on http://localhost:${server.port}`);
