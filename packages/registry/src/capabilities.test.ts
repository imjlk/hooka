import { expect, test } from "bun:test";
import { listCapabilities } from "./index";

test("registry capability definitions expose the required core shape", () => {
  const capabilities = listCapabilities();

  expect(capabilities.length).toBeGreaterThan(0);

  for (const capability of capabilities) {
    expect(typeof capability.id).toBe("string");
    expect(capability.id.length).toBeGreaterThan(0);
    expect(typeof capability.title).toBe("string");
    expect(typeof capability.description).toBe("string");
    expect(Array.isArray(capability.binaries)).toBe(true);
    expect(capability.binaries.length).toBeGreaterThan(0);
    expect(typeof capability.healthcheck.command).toBe("string");
  }
});
