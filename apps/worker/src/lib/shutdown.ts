import type { Logger } from "@hooka/logger";

export interface WorkerShutdownSignal {
  isShutdownRequested(): boolean;
  requestShutdown(signal: string): void;
}

export function createWorkerShutdownSignal(
  logger?: Logger,
): WorkerShutdownSignal {
  let shutdownRequested = false;

  return {
    isShutdownRequested() {
      return shutdownRequested;
    },
    requestShutdown(signal: string) {
      if (shutdownRequested) {
        return;
      }

      shutdownRequested = true;
      logger?.info("Worker shutting down", {
        signal,
      });
    },
  };
}

export function registerWorkerShutdownHandlers(
  input: { logger?: Logger } = {},
): WorkerShutdownSignal {
  const shutdownSignal = createWorkerShutdownSignal(input.logger);
  process.on("SIGINT", () => shutdownSignal.requestShutdown("SIGINT"));
  process.on("SIGTERM", () => shutdownSignal.requestShutdown("SIGTERM"));
  return shutdownSignal;
}
