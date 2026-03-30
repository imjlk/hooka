import type { Logger } from "@hooka/logger";
import type { RunStore } from "@hooka/run-store";

export interface HookaStoppableServer {
  stop(closeActiveConnections?: boolean): void;
}

export function createServerShutdownHandler(input: {
  runStore: RunStore;
  server: HookaStoppableServer;
  logger?: Logger;
}) {
  let shutdownRequested = false;
  const logger = input.logger;

  return (signal: string) => {
    if (shutdownRequested) {
      return;
    }

    shutdownRequested = true;
    logger?.info("Server shutting down", {
      signal,
    });
    input.server.stop(true);
    input.runStore.close();
  };
}

export function registerServerShutdownHandlers(input: {
  runStore: RunStore;
  server: HookaStoppableServer;
  logger?: Logger;
}) {
  const shutdown = createServerShutdownHandler(input);
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  return shutdown;
}
