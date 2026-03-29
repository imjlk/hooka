export interface WorkerShutdownSignal {
  isShutdownRequested(): boolean;
  requestShutdown(signal: string): void;
}

export function createWorkerShutdownSignal(
  logger: Pick<typeof console, "log"> = console,
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
      logger.log(
        `[${new Date().toISOString()}] hooka-worker shutting down after ${signal}`,
      );
    },
  };
}

export function registerWorkerShutdownHandlers(
  input: {
    logger?: Pick<typeof console, "log">;
  } = {},
): WorkerShutdownSignal {
  const shutdownSignal = createWorkerShutdownSignal(input.logger);
  process.on("SIGINT", () => shutdownSignal.requestShutdown("SIGINT"));
  process.on("SIGTERM", () => shutdownSignal.requestShutdown("SIGTERM"));
  return shutdownSignal;
}
