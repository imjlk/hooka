import { defineCommand, option } from "@bunli/core";
import { createServerConfig } from "@hooka/config";
import type { RegistrySummary, RunSummary } from "@hooka/contracts";
import { z } from "zod";
import { booleanFlagSchema, resolveBooleanFlag } from "../lib/shared";

interface EndpointStatus<T> {
  ok: boolean;
  status: number | null;
  body: T | null;
  error: string | null;
}

export interface StatusReport {
  url: string;
  workers: Array<{
    workerId: string;
    runtimeRole: string;
    lastSeenAt: string;
    currentRunId: string | null;
  }>;
  health: EndpointStatus<{
    ok: boolean;
    service: string;
  }>;
  ready: EndpointStatus<{
    ok: boolean;
    service: string;
    error?: string;
  }>;
  summary: EndpointStatus<RegistrySummary>;
  recentRuns: EndpointStatus<RunSummary[]>;
}

export function createStatusCommand() {
  const defaultUrl = `http://127.0.0.1:${createServerConfig().port}`;

  return defineCommand({
    name: "status",
    description:
      "Check server health, readiness, registry summary, and recent activity.",
    options: {
      url: option(z.string().url().default(defaultUrl), {
        description: "Hooka server base URL.",
      }),
      token: option(z.string().optional(), {
        description:
          "Admin bearer token. Falls back to HOOKA_ADMIN_TOKEN when omitted.",
      }),
      json: option(booleanFlagSchema, {
        description: "Print raw JSON instead of a human-readable summary.",
      }),
    },
    handler: async ({ flags }) => {
      const json = resolveBooleanFlag(flags.json, "--json");
      const report = await collectStatusReport(
        flags.url,
        flags.token ?? Bun.env["HOOKA_ADMIN_TOKEN"],
      );

      if (json) {
        console.log(JSON.stringify(report, null, 2));
      } else {
        console.log(`Status URL: ${report.url}`);
        console.log(
          `Health: ${formatEndpointStatus(report.health, (body) => body?.service ?? "unknown")}`,
        );
        console.log(
          `Readiness: ${formatEndpointStatus(report.ready, (body) => body?.error ?? body?.service ?? "unknown")}`,
        );

        if (report.summary.ok && report.summary.body) {
          console.log(
            `Installed Capabilities: ${report.summary.body.installedCapabilities.join(", ") || "(none)"}`,
          );
          console.log(
            `Registry Summary: ${report.summary.body.counts.tasks} tasks, ${report.summary.body.counts.capabilities} capabilities, ${report.summary.body.counts.presets} presets`,
          );
          console.log(
            `Workers: ${report.workers.length > 0 ? report.workers.map((worker) => `${worker.workerId}@${worker.runtimeRole} (${worker.lastSeenAt})`).join(", ") : "(none)"}`,
          );
        } else {
          console.log(
            `Registry Summary: unavailable (${report.summary.error ?? report.summary.status ?? "unknown error"})`,
          );
        }

        console.log("Recent Run Activity:");
        if (report.recentRuns.ok && report.recentRuns.body) {
          if (report.recentRuns.body.length === 0) {
            console.log("- no recent runs");
          } else {
            for (const run of report.recentRuns.body) {
              console.log(
                `- ${run.status} ${run.taskId} from ${run.source} at ${run.createdAt}`,
              );
            }
          }
        } else {
          console.log(
            `- unavailable (${report.recentRuns.error ?? report.recentRuns.status ?? "unknown error"})`,
          );
        }
      }

      if (!report.health.ok || !report.ready.ok) {
        process.exitCode = 1;
      }
    },
  });
}

export async function collectStatusReport(
  baseUrl: string,
  adminToken?: string,
): Promise<StatusReport> {
  const url = baseUrl.replace(/\/$/, "");
  const authHeader =
    adminToken && adminToken.trim().length > 0
      ? {
          authorization: `Bearer ${adminToken}`,
        }
      : undefined;
  const [health, ready, summary, recentRuns] = await Promise.all([
    fetchEndpoint<{
      ok: boolean;
      service: string;
    }>(`${url}/api/health`),
    fetchEndpoint<{
      ok: boolean;
      service: string;
      error?: string;
    }>(`${url}/api/ready`),
    fetchEndpoint<RegistrySummary>(`${url}/api/summary`, authHeader),
    fetchEndpoint<RunSummary[]>(`${url}/api/runs?limit=5`, authHeader),
  ]);

  return {
    url,
    workers: summary.body?.workers ?? [],
    health,
    ready,
    summary,
    recentRuns,
  };
}

async function fetchEndpoint<T>(
  url: string,
  headers?: HeadersInit,
): Promise<EndpointStatus<T>> {
  try {
    const response = await fetch(url, {
      headers,
    });
    const rawBody = await response.text();
    const parsedBody = rawBody.length > 0 ? (tryParseJson(rawBody) as T) : null;

    return {
      ok: response.ok,
      status: response.status,
      body: parsedBody,
      error: response.ok
        ? null
        : getEndpointError(parsedBody, rawBody, response.status),
    };
  } catch (error) {
    return {
      ok: false,
      status: null,
      body: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function getEndpointError<T>(
  body: T | null,
  rawBody: string,
  status: number,
): string {
  if (
    body &&
    typeof body === "object" &&
    "error" in body &&
    typeof body.error === "string"
  ) {
    return body.error;
  }

  return rawBody || `HTTP ${status}`;
}

function tryParseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function formatEndpointStatus<T>(
  endpoint: EndpointStatus<T>,
  extra: (body: T | null) => string,
): string {
  if (!endpoint.ok) {
    return `unavailable (${endpoint.error ?? endpoint.status ?? "unknown error"})`;
  }

  return `ok (${endpoint.status}) ${extra(endpoint.body)}`;
}
