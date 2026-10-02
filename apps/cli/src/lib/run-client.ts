import type { RunListQuery } from "@hooka/contracts";
import {
  enqueueRunResponseSchema,
  runDetailSchema,
  runListQuerySchema,
  runSummarySchema,
} from "@hooka/contracts";
import type { z } from "zod";
import { withRunStore } from "./shared";

interface RunClientOptions {
  dbPath: string;
  url?: string;
  token?: string;
  requestTimeoutMs: number;
  allowInsecureHttp: boolean;
}

/** An explicit URL selects the API; request failures never open the local DB. */
export function createRunClient(options: RunClientOptions) {
  async function request<T>(
    path: string,
    schema: z.ZodType<T>,
    method: "GET" | "POST" = "GET",
  ): Promise<T> {
    const target = new URL(path, options.url);
    const loopback =
      target.hostname === "localhost" ||
      target.hostname === "[::1]" ||
      /^127(?:\.\d{1,3}){3}$/.test(target.hostname);
    if (
      options.token &&
      target.protocol === "http:" &&
      !loopback &&
      !options.allowInsecureHttp
    ) {
      throw new Error(
        "Refusing to send the admin token over remote HTTP. Use an HTTPS URL or explicitly set --allow-insecure-http for a trusted network.",
      );
    }

    const signal = AbortSignal.timeout(options.requestTimeoutMs);
    const headers = new Headers({ accept: "application/json" });
    if (options.token) {
      headers.set("authorization", `Bearer ${options.token}`);
    }

    try {
      const response = await fetch(target, {
        method,
        headers,
        signal,
        redirect: "error",
      });

      if (!response.ok) {
        const body = await response.text();
        let message = body;
        try {
          const parsed: unknown = JSON.parse(body);
          if (
            parsed &&
            typeof parsed === "object" &&
            "error" in parsed &&
            typeof parsed.error === "string"
          ) {
            message = parsed.error;
          }
        } catch {
          // Reverse proxies can return a plain-text error response.
        }
        throw new Error(
          `Hooka API returned HTTP ${response.status}${message ? `: ${message.slice(0, 500)}` : ""}`,
        );
      }

      let body: unknown;
      try {
        body = await response.json();
      } catch (error) {
        if (signal.aborted) throw error;
        throw new Error(
          "Hooka API returned invalid JSON. Check the server URL.",
        );
      }
      const result = schema.safeParse(body);
      if (!result.success) {
        throw new Error(
          "Hooka API returned an unexpected response. Check the server URL and version.",
        );
      }
      return result.data;
    } catch (error) {
      if (signal.aborted) {
        throw new Error(
          `Hooka API request timed out after ${options.requestTimeoutMs}ms.`,
        );
      }
      throw error;
    }
  }

  return {
    async listRuns(filters: RunListQuery) {
      const query = runListQuerySchema.parse(filters);
      if (!options.url) {
        return withRunStore(options.dbPath, (store) => store.queryRuns(query));
      }

      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined) {
          params.set(key, String(value));
        }
      }
      return request(`/api/runs?${params}`, runSummarySchema.array());
    },
    async getRun(runId: string) {
      return options.url
        ? request(`/api/runs/${encodeURIComponent(runId)}`, runDetailSchema)
        : withRunStore(options.dbPath, (store) => store.getRun(runId));
    },
    async retryRun(runId: string) {
      return options.url
        ? request(
            `/api/runs/${encodeURIComponent(runId)}/retry`,
            enqueueRunResponseSchema,
            "POST",
          )
        : withRunStore(
            options.dbPath,
            (store) => store.retryRun(runId, { source: "cli.retry" }).response,
          );
    },
  };
}
