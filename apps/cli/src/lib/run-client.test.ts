import { expect, spyOn, test } from "bun:test";
import { createRunClient } from "./run-client";

test.each([
  { url: "http://hooka.example.com" },
  { url: "http://localhost.example.com" },
  { url: "http://127.0.0.1.example.com" },
  { url: "http://[::]" },
])(
  "remote HTTP never receives the admin token by default: $url",
  async ({ url }) => {
    const request = spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json([]),
    );
    try {
      const client = createRunClient({
        dbPath: ":memory:",
        url,
        token: "admin-token",
        requestTimeoutMs: 1000,
        allowInsecureHttp: false,
      });

      await expect(client.listRuns({ limit: 20 })).rejects.toThrow(
        "Refusing to send the admin token",
      );
      expect(request).not.toHaveBeenCalled();
    } finally {
      request.mockRestore();
    }
  },
);

test.each([
  { url: "https://hooka.example.com", allowInsecureHttp: false },
  { url: "http://localhost", allowInsecureHttp: false },
  { url: "http://127.0.0.1", allowInsecureHttp: false },
  { url: "http://127.0.0.2", allowInsecureHttp: false },
  { url: "http://[::1]", allowInsecureHttp: false },
  { url: "http://hooka.internal", allowInsecureHttp: true },
])(
  "authenticated API requests support the selected transport: $url",
  async ({ url, allowInsecureHttp }) => {
    const request = spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json([]),
    );
    try {
      const client = createRunClient({
        dbPath: ":memory:",
        url,
        token: "admin-token",
        requestTimeoutMs: 1000,
        allowInsecureHttp,
      });

      expect(await client.listRuns({ limit: 20 })).toEqual([]);
      expect(request).toHaveBeenCalledTimes(1);
      const [target, init] = request.mock.calls[0] ?? [];
      expect(String(target)).toBe(`${url}/api/runs?limit=20`);
      expect(new Headers(init?.headers).get("authorization")).toBe(
        "Bearer admin-token",
      );
      expect(init?.redirect).toBe("error");
    } finally {
      request.mockRestore();
    }
  },
);
