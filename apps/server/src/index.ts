import { getEnvOrDefault, getNumberEnv } from "@hooka/bun-utils";
import { createRunStore, defaultHookaDbPath } from "@hooka/run-store";
import { getDefaultManifestPath } from "@hooka/runner-core";
import { resolve } from "node:path";
import { createHookaFetchHandler } from "./app";
import { registerServerShutdownHandlers } from "./shutdown";

const port = getNumberEnv("HOOKA_PORT", 3000);
const dbPath = getEnvOrDefault("HOOKA_DB_PATH", defaultHookaDbPath);
const runtimeRole = getEnvOrDefault("HOOKA_RUNTIME_ROLE", "hooka-server");
const uiDistDir = resolve(process.cwd(), "packages/admin-ui/dist");
const capabilityManifestPath = getDefaultManifestPath();
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
    webhookSecret: Bun.env["HOOKA_WEBHOOK_SECRET"],
  }),
});

registerServerShutdownHandlers({
  server,
  runStore,
});

console.log(
  JSON.stringify(
    {
      service: "hooka-server",
      runtimeRole,
      port: server.port,
      dbPath,
      capabilityManifestPath,
    },
    null,
    2,
  ),
);
