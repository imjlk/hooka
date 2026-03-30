import type { EnqueueRunRequest, GenericTaskWebhook } from "@hooka/contracts";
import { enqueueRunRequestSchema, runListQuerySchema } from "@hooka/contracts";
import type { Logger } from "@hooka/logger";
import {
  createRegistrySummary,
  getPresetPlan,
  getTask,
  listCapabilities,
  listPresets,
  listTasks,
  listWebhookAdapters,
} from "@hooka/registry";
import type { CompatibilityWebhookAdapter } from "@hooka/task-sdk";
import type { RunStore } from "@hooka/run-store";
import { loadInstalledCapabilities } from "@hooka/runner-core";
import { extname, resolve } from "node:path";
import { ZodError } from "zod";
import {
  normalizeGenericTaskWebhook,
  parseGenericTaskWebhook,
  verifyHookaHmacSignature,
} from "./lib/webhooks";

export interface HookaServerAppOptions {
  capabilityManifestPath: string;
  runStore: RunStore;
  uiDistDir: string;
  webhookSecret?: string;
  logger?: Logger;
}

class NotFoundError extends Error {}

type RouteHandler = (
  request: Request,
  url: URL,
) => Promise<Response> | Response;

export function createHookaFetchHandler(options: HookaServerAppOptions) {
  const exactRoutes = createExactRoutes(options);

  return async function fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    try {
      const exactHandler = exactRoutes.get(
        routeKey(request.method, url.pathname),
      );
      if (exactHandler) {
        return await exactHandler(request, url);
      }

      const runId = matchRunIdRoute(request.method, url.pathname);
      if (runId) {
        const run = options.runStore.getRun(runId);

        if (!run) {
          return json(
            {
              ok: false,
              error: `Run not found: ${runId}`,
            },
            404,
          );
        }

        return json(run);
      }

      return serveUi(url.pathname, options.uiDistDir);
    } catch (error) {
      if (
        !(error instanceof NotFoundError) &&
        !(error instanceof ZodError) &&
        !(error instanceof SyntaxError)
      ) {
        if (error instanceof Error) {
          options.logger?.error("Request failed unexpectedly", error, {
            method: request.method,
            pathname: url.pathname,
          });
        } else {
          options.logger?.error("Request failed unexpectedly", {
            method: request.method,
            pathname: url.pathname,
            error: String(error),
          });
        }
      }

      return json(
        {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        },
        error instanceof NotFoundError
          ? 404
          : error instanceof ZodError || error instanceof SyntaxError
            ? 400
            : 500,
      );
    }
  };
}

function createExactRoutes(
  options: HookaServerAppOptions,
): Map<string, RouteHandler> {
  const routes = new Map<string, RouteHandler>([
    [
      routeKey("GET", "/api/health"),
      () =>
        json({
          ok: true,
          service: "hooka-server",
        }),
    ],
    [routeKey("GET", "/api/ready"), () => checkReadiness(options)],
    [routeKey("GET", "/api/tasks"), () => json(listTasks())],
    [routeKey("GET", "/api/capabilities"), () => json(listCapabilities())],
    [
      routeKey("GET", "/api/presets"),
      () =>
        json(
          listPresets().map((preset) => ({
            ...preset,
            plan: getPresetPlan(preset.id),
          })),
        ),
    ],
    [
      routeKey("GET", "/api/summary"),
      async () => {
        const manifest = await loadInstalledCapabilities(
          options.capabilityManifestPath,
        );
        return json(createRegistrySummary(manifest.installed));
      },
    ],
    [
      routeKey("GET", "/api/runs"),
      (_request, url) => {
        const filters = runListQuerySchema.parse({
          limit: getPositiveInt(url.searchParams.get("limit"), 20),
          status: url.searchParams.get("status") ?? undefined,
          taskId: url.searchParams.get("taskId") ?? undefined,
          source: url.searchParams.get("source") ?? undefined,
        });
        return json(
          options.runStore.queryRuns({
            limit: filters.limit,
            status: filters.status,
            taskId: filters.taskId,
            source: filters.source,
          }),
        );
      },
    ],
    [
      routeKey("POST", "/api/runs"),
      async (request) => {
        const payload = enqueueRunRequestSchema.parse(await request.json());
        return handleGenericEnqueue(options, payload);
      },
    ],
    [
      routeKey("POST", "/api/webhooks/task"),
      async (request) => {
        const rawBody = await request.text();
        return handleSignedGenericTaskWebhook(options, request, rawBody);
      },
    ],
  ]);

  for (const adapter of listWebhookAdapters()) {
    routes.set(routeKey("POST", adapter.routePath), async (request) => {
      const rawBody = await request.text();
      return handleCompatibilityWebhook(options, request, rawBody, adapter);
    });
  }

  return routes;
}

async function handleGenericEnqueue(
  options: HookaServerAppOptions,
  payload: EnqueueRunRequest,
): Promise<Response> {
  const enqueued = await enqueueRun(options, payload);
  return json(enqueued.queued.response, 202);
}

async function handleSignedGenericTaskWebhook(
  options: HookaServerAppOptions,
  request: Request,
  rawBody: string,
): Promise<Response> {
  const verified = verifySignedWebhook(options, request, rawBody);
  if (verified) {
    return verified;
  }

  const webhookPayload = parseGenericTaskWebhook(rawBody);
  return enqueueGenericWebhook(options, webhookPayload);
}

async function handleCompatibilityWebhook(
  options: HookaServerAppOptions,
  request: Request,
  rawBody: string,
  adapter: CompatibilityWebhookAdapter,
): Promise<Response> {
  const verified = verifySignedWebhook(options, request, rawBody);
  if (verified) {
    return verified;
  }

  const webhookPayload = adapter.normalize(rawBody);
  return enqueueGenericWebhook(options, webhookPayload);
}

async function enqueueGenericWebhook(
  options: HookaServerAppOptions,
  payload: GenericTaskWebhook,
): Promise<Response> {
  const enqueuePayload = normalizeGenericTaskWebhook(payload);
  const enqueued = await enqueueRun(options, enqueuePayload);

  return json(enqueued.queued.response, enqueued.queued.created ? 202 : 200);
}

function verifySignedWebhook(
  options: HookaServerAppOptions,
  request: Request,
  rawBody: string,
): Response | null {
  const pathname = new URL(request.url).pathname;

  if (!options.webhookSecret) {
    options.logger?.error("Webhook secret is not configured", {
      pathname,
    });
    return json(
      {
        ok: false,
        error: "HOOKA_WEBHOOK_SECRET is not configured.",
      },
      500,
    );
  }

  const signatureCheck = verifyHookaHmacSignature({
    secret: options.webhookSecret,
    timestampHeader: request.headers.get("x-hooka-timestamp"),
    signatureHeader: request.headers.get("x-hooka-signature"),
    rawBody,
  });

  if (!signatureCheck.ok) {
    options.logger?.warn("Webhook signature rejected", {
      pathname,
      status: signatureCheck.status,
      error: signatureCheck.error,
    });
    return json(
      {
        ok: false,
        error: signatureCheck.error,
      },
      signatureCheck.status,
    );
  }

  return null;
}

function checkReadiness(options: HookaServerAppOptions): Response {
  try {
    options.runStore.db.query("select 1 as ok").get();

    return json({
      ok: true,
      service: "hooka-server",
    });
  } catch (error) {
    if (error instanceof Error) {
      options.logger?.error("Readiness check failed", error);
    } else {
      options.logger?.error("Readiness check failed", {
        error: String(error),
      });
    }

    return json(
      {
        ok: false,
        service: "hooka-server",
        error: "Database not ready.",
      },
      503,
    );
  }
}

async function enqueueRun(
  options: HookaServerAppOptions,
  payload: EnqueueRunRequest,
) {
  const task = getTask(payload.taskId);

  if (!task) {
    throw new NotFoundError(`Task not found: ${payload.taskId}`);
  }

  const manifest = await loadInstalledCapabilities(
    options.capabilityManifestPath,
  );
  const parsedInput = task.input.parse(payload.input ?? {});
  const queued = options.runStore.enqueueRun({
    taskId: task.id,
    input: parsedInput,
    source: payload.source,
    sourceEventId: payload.sourceEventId,
    capabilitySnapshot: manifest.installed,
  });

  return {
    task,
    queued,
  };
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: withSecurityHeaders({
      "content-type": "application/json; charset=utf-8",
    }),
  });
}

function routeKey(method: string, pathname: string): string {
  return `${method.toUpperCase()} ${pathname}`;
}

function matchRunIdRoute(method: string, pathname: string): string | null {
  if (method.toUpperCase() !== "GET") {
    return null;
  }

  const match = pathname.match(/^\/api\/runs\/([^/]+)$/);
  return match?.[1] ?? null;
}

async function serveUi(pathname: string, uiDistDir: string): Promise<Response> {
  const assetPath = resolve(uiDistDir, `.${pathname}`);
  const isAssetRequest = extname(pathname).length > 0;

  if (assetPath.startsWith(uiDistDir)) {
    const assetFile = Bun.file(assetPath);
    if (isAssetRequest && (await assetFile.exists())) {
      return new Response(assetFile, {
        headers: withSecurityHeaders(),
      });
    }
  }

  const indexFile = Bun.file(resolve(uiDistDir, "index.html"));

  if (await indexFile.exists()) {
    return new Response(indexFile, {
      headers: withSecurityHeaders(),
    });
  }

  return new Response(
    "Admin UI bundle not found. Run `bun --filter @hooka/admin-ui run build`.",
    {
      status: 503,
      headers: withSecurityHeaders({
        "content-type": "text/plain; charset=utf-8",
      }),
    },
  );
}

function getPositiveInt(value: string | null, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function withSecurityHeaders(input: HeadersInit = {}): Headers {
  const headers = new Headers(input);
  headers.set("x-content-type-options", "nosniff");
  headers.set("x-frame-options", "DENY");
  headers.set("referrer-policy", "no-referrer");
  return headers;
}
