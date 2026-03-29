import { expect, mock, test } from "bun:test";
import { createWorkerShutdownSignal } from "./shutdown";

test("createWorkerShutdownSignal flips state once and logs once", () => {
  const logger = {
    log: mock(() => {}),
  };
  const shutdownSignal = createWorkerShutdownSignal(logger);

  expect(shutdownSignal.isShutdownRequested()).toBe(false);

  shutdownSignal.requestShutdown("SIGTERM");
  shutdownSignal.requestShutdown("SIGINT");

  expect(shutdownSignal.isShutdownRequested()).toBe(true);
  expect(logger.log).toHaveBeenCalledTimes(1);
});
