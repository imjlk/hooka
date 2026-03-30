import { expect, test } from "bun:test";
import { createLogger } from "./index";

test("createLogger emits structured JSON lines with service context", () => {
  const lines: string[] = [];
  const logger = createLogger({
    service: "hooka-worker",
    runtimeRole: "cf-pages",
    sink: {
      log: (message) => lines.push(message),
      warn: (message) => lines.push(message),
      error: (message) => lines.push(message),
    },
  });

  logger.info("Worker started", {
    workerId: "worker-1",
  });
  logger.error("Worker failed", new Error("boom"), {
    runId: "run-1",
  });

  const info = JSON.parse(lines[0] ?? "null") as Record<string, unknown>;
  const error = JSON.parse(lines[1] ?? "null") as Record<string, unknown>;

  expect(info["level"]).toBe("info");
  expect(info["service"]).toBe("hooka-worker");
  expect(info["runtimeRole"]).toBe("cf-pages");
  expect(info["message"]).toBe("Worker started");
  expect(info["workerId"]).toBe("worker-1");

  expect(error["level"]).toBe("error");
  expect(error["message"]).toBe("Worker failed");
  expect(error["runId"]).toBe("run-1");
  expect(error["errorMessage"]).toBe("boom");
});
