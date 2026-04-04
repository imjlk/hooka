import { defineCommand, defineGroup, option } from "@bunli/core";
import { createServerConfig } from "@hooka/config";
import type { AuditEvent } from "@hooka/contracts";
import { z } from "zod";
import { booleanFlagSchema, resolveBooleanFlag } from "../lib/shared";

export function createAuditCommandGroup() {
  const defaultUrl = `http://127.0.0.1:${createServerConfig().port}`;

  return defineGroup({
    name: "audit",
    description: "Inspect recent Hooka audit events.",
    commands: [
      defineCommand({
        name: "list",
        description: "List recent security, policy, and target audit events.",
        options: {
          url: option(z.string().url().default(defaultUrl), {
            description: "Hooka server base URL.",
          }),
          token: option(z.string().optional(), {
            description:
              "Admin bearer token. Falls back to HOOKA_ADMIN_TOKEN when omitted.",
          }),
          category: option(
            z.enum(["security", "policy", "targets"]).optional(),
            {
              description: "Filter audit events by category.",
            },
          ),
          outcome: option(
            z.enum(["rejected", "created", "updated", "deleted"]).optional(),
            {
              description: "Filter audit events by outcome.",
            },
          ),
          limit: option(z.coerce.number().int().positive().default(20), {
            description: "Maximum number of audit events to fetch.",
          }),
          json: option(booleanFlagSchema, {
            description: "Print raw JSON instead of a human-readable report.",
          }),
        },
        handler: async ({ flags }) => {
          const json = resolveBooleanFlag(flags.json, "--json");
          const auditEvents = await fetchAuditEvents(flags.url, {
            token: flags.token ?? Bun.env["HOOKA_ADMIN_TOKEN"],
            category: flags.category,
            outcome: flags.outcome,
            limit: flags.limit,
          });

          if (json) {
            console.log(JSON.stringify(auditEvents, null, 2));
            return;
          }

          if (auditEvents.length === 0) {
            console.log("No audit events recorded.");
            return;
          }

          for (const event of auditEvents) {
            const details = [
              `${event.category}/${event.outcome}`,
              event.action,
              event.subjectId
                ? `${event.subjectType}:${event.subjectId}`
                : event.subjectType,
              event.clientIp ? `ip=${event.clientIp}` : null,
              event.requestPath ? `path=${event.requestPath}` : null,
            ]
              .filter(Boolean)
              .join(" · ");
            const context = formatAuditContextPreview(event.context);

            console.log(`${event.createdAt} ${details}`);
            console.log(`  ${event.message}`);
            if (context) {
              console.log(`  context: ${context}`);
            }
          }
        },
      }),
    ],
  });
}

async function fetchAuditEvents(
  baseUrl: string,
  filters: {
    token?: string;
    category?: "security" | "policy" | "targets";
    outcome?: "rejected" | "created" | "updated" | "deleted";
    limit: number;
  },
): Promise<AuditEvent[]> {
  const url = new URL("/api/audit-events", baseUrl);
  url.searchParams.set("limit", String(filters.limit));

  if (filters.category) {
    url.searchParams.set("category", filters.category);
  }

  if (filters.outcome) {
    url.searchParams.set("outcome", filters.outcome);
  }

  const headers = new Headers();
  if (filters.token) {
    headers.set("authorization", `Bearer ${filters.token}`);
  }

  const response = await fetch(url, {
    headers,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `HTTP ${response.status}`);
  }

  return (await response.json()) as AuditEvent[];
}

function formatAuditContextPreview(context: unknown): string | null {
  if (context === undefined) {
    return null;
  }

  const serialized =
    typeof context === "string" ? context : JSON.stringify(context);

  if (!serialized || serialized.length === 0) {
    return null;
  }

  return serialized.length > 160
    ? `${serialized.slice(0, 157)}...`
    : serialized;
}
