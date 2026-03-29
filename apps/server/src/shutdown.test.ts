import { expect, mock, test } from "bun:test";
import type { RunStore } from "@hooka/run-store";
import { createServerShutdownHandler } from "./shutdown";

test("createServerShutdownHandler stops the server and closes the run store once", () => {
  const server = {
    stop: mock(() => {}),
  };
  const runStore = {
    close: mock(() => {}),
  } as unknown as RunStore;
  const logger = {
    log: mock(() => {}),
  };
  const shutdown = createServerShutdownHandler({
    server,
    runStore,
    logger,
  });

  shutdown("SIGTERM");
  shutdown("SIGINT");

  expect(server.stop).toHaveBeenCalledTimes(1);
  expect(server.stop).toHaveBeenCalledWith(true);
  expect(runStore.close).toHaveBeenCalledTimes(1);
  expect(logger.log).toHaveBeenCalledTimes(1);
});
