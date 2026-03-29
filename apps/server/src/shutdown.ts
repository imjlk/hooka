import type { RunStore } from "@hooka/run-store";

export interface HookaStoppableServer {
  stop(closeActiveConnections?: boolean): void;
}

export function createServerShutdownHandler(input: {
  runStore: RunStore;
  server: HookaStoppableServer;
  logger?: Pick<typeof console, "log">;
}) {
  let shutdownRequested = false;
  const logger = input.logger ?? console;

  return (signal: string) => {
    if (shutdownRequested) {
      return;
    }

    shutdownRequested = true;
    logger.log(
      `[${new Date().toISOString()}] hooka-server shutting down after ${signal}`,
    );
    input.server.stop(true);
    input.runStore.close();
  };
}

export function registerServerShutdownHandlers(input: {
  runStore: RunStore;
  server: HookaStoppableServer;
  logger?: Pick<typeof console, "log">;
}) {
  const shutdown = createServerShutdownHandler(input);
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  return shutdown;
}
