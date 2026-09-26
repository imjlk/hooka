import type {
  AuditEventCategory,
  EnqueueRunRequest,
  GenericTaskWebhook,
  IncomingTaskWebhook,
  InstalledCapabilitiesManifest,
  TargetPolicy,
} from "@hooka/contracts";
import {
  auditEventListQuerySchema,
  enqueueRunRequestSchema,
  runListQuerySchema,
  targetSchema,
} from "@hooka/contracts";
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
import type { ResolvedTargetWebhook } from "@hooka/targets";
import {
  createTarget,
  deleteTarget,
  loadTargets,
  resolveTargetWebhook,
  TargetConflictError,
  TargetNotFoundError,
  TargetValidationError,
  updateTarget,
} from "@hooka/targets";
import { extname, resolve } from "node:path";
import { ZodError } from "zod";
import {
  isAuthorizedAdminRequest,
  isAuthorizedWebhookSecretRequest,
  isPublicServerRoute,
} from "./lib/auth";
import {
  InMemoryRateLimiter,
  createServerRateLimitContext,
} from "./lib/rate-limit";
import {
  normalizeGenericTaskWebhook,
  parseIncomingTaskWebhook,
  verifyHookaHmacSignature,
} from "./lib/webhooks";
import { createOpenApiDocument } from "./lib/openapi";

export interface HookaServerAppOptions {
  adminToken?: string;
  apiRateLimit: number;
  capabilityManifestPath: string;
  corsOrigins: string[];
  defaultMaxAttempts: number;
  globalApiRateLimit: number;
  globalWebhookRateLimit: number;
  logger?: Logger;
  loadCapabilities?: (
    manifestPath?: string,
  ) => Promise<InstalledCapabilitiesManifest>;
  maxBodyBytes: number;
  rateLimitWindowMs: number;
  runStore: RunStore;
  targetsPath: string;
  trustProxy: boolean;
  uiDistDir: string;
  webhookRateLimit: number;
  webhookSecret?: string;
  /** Interval for SSE keepalive comments; defaults to 15 seconds. */
  eventStreamKeepaliveMs?: number;
}

class NotFoundError extends Error {}
class PayloadTooLargeError extends Error {}
/** Raised for invalid request data; other errors are server faults (500). */
class BadRequestError extends Error {}

const eventStreamPath = "/api/events/stream";
const runPathPattern = /^\/api\/runs\/([^/]+)$/;
const runRetryPathPattern = /^\/api\/runs\/([^/]+)\/retry$/;
const targetPathPattern = /^\/api\/targets\/([^/]+)$/;
const parameterizedRoutes = [
  { pattern: runPathPattern, methods: ["GET"] },
  { pattern: runRetryPathPattern, methods: ["POST"] },
  { pattern: targetPathPattern, methods: ["GET", "PUT", "DELETE"] },
];

type RouteHandler = (
  request: Request,
  url: URL,
) => Promise<Response> | Response;

interface EnqueueMetadata {
  maxAttempts?: number;
  targetMaxConcurrentRuns?: number;
  targetId?: string;
  targetPolicy?: TargetPolicy;
}

interface EventStreamTicketEntry {
  consumed: boolean;
  expiresAt: number;
}

type EventStreamTicketRejectionReason =
  | "expired"
  | "missing"
  | "reused"
  | "unknown";

type EventStreamTicketCheck =
  | { ok: true }
  | {
      ok: false;
      reason: EventStreamTicketRejectionReason;
    };

export function createHookaFetchHandler(options: HookaServerAppOptions) {
  const apiRateLimiter = new InMemoryRateLimiter({
    limit: options.apiRateLimit,
    windowMs: options.rateLimitWindowMs,
  });
  const webhookRateLimiter = new InMemoryRateLimiter({
    limit: options.webhookRateLimit,
    windowMs: options.rateLimitWindowMs,
  });
  const globalApiRateLimiter = new InMemoryRateLimiter({
    limit: options.globalApiRateLimit,
    windowMs: options.rateLimitWindowMs,
  });
  const globalWebhookRateLimiter = new InMemoryRateLimiter({
    limit: options.globalWebhookRateLimit,
    windowMs: options.rateLimitWindowMs,
  });
  const eventStreamTickets = new Map<string, EventStreamTicketEntry>();
  const exactRoutes = createExactRoutes(options, eventStreamTickets);

  return async function fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    // HEAD is served by the matching GET route without a body. The event
    // stream is excluded: it would consume a ticket and open a stream.
    const routeMethod =
      request.method === "HEAD" && url.pathname !== eventStreamPath
        ? "GET"
        : request.method;
    const respond = (response: Response): Response => {
      const corsResponse = applyCorsHeaders(
        request,
        url.pathname,
        response,
        options.corsOrigins,
      );

      return request.method === "HEAD"
        ? new Response(null, {
            status: corsResponse.status,
            statusText: corsResponse.statusText,
            headers: corsResponse.headers,
          })
        : corsResponse;
    };

    try {
      const corsPreflight = createCorsPreflightResponse(
        request,
        url.pathname,
        options.corsOrigins,
      );
      if (corsPreflight) {
        return respond(corsPreflight);
      }

      if (url.pathname.startsWith("/api/")) {
        const rateLimitResponse = checkRateLimit(
          options,
          request,
          apiRateLimiter,
          webhookRateLimiter,
          globalApiRateLimiter,
          globalWebhookRateLimiter,
        );
        if (rateLimitResponse) {
          return respond(rateLimitResponse);
        }

        const authResponse = requireAdminAuth(options, request, url.pathname);
        if (authResponse) {
          return respond(authResponse);
        }
      }

      const exactHandler = exactRoutes.get(routeKey(routeMethod, url.pathname));
      if (exactHandler) {
        return respond(await exactHandler(request, url));
      }

      const retryRunId = matchRunRetryRoute(routeMethod, url.pathname);
      if (retryRunId) {
        return respond(await retryRun(options, retryRunId));
      }

      const runId = matchRunIdRoute(routeMethod, url.pathname);
      if (runId) {
        const run = options.runStore.getRun(runId);

        if (!run) {
          return respond(
            json(
              {
                ok: false,
                error: `Run not found: ${runId}`,
              },
              404,
            ),
          );
        }

        return respond(json(run));
      }

      const targetDetailId = matchTargetDetailRoute(routeMethod, url.pathname);
      if (targetDetailId) {
        return respond(await handleTargetDetail(options, targetDetailId));
      }

      const targetUpdateId = matchTargetUpdateRoute(routeMethod, url.pathname);
      if (targetUpdateId) {
        return respond(
          await handleTargetUpdate(options, request, targetUpdateId),
        );
      }

      const targetDeleteId = matchTargetDeleteRoute(routeMethod, url.pathname);
      if (targetDeleteId) {
        return respond(
          await handleTargetDelete(options, request, targetDeleteId),
        );
      }

      // Never answer an API path with the admin UI shell: a typo'd webhook
      // URL must not look like a successful delivery.
      if (url.pathname.startsWith("/api/")) {
        return respond(createUnmatchedApiResponse(url.pathname, exactRoutes));
      }

      return respond(await serveUi(url.pathname, options.uiDistDir));
    } catch (error) {
      const status =
        error instanceof NotFoundError
          ? 404
          : error instanceof BadRequestError
            ? 400
            : error instanceof PayloadTooLargeError
              ? 413
              : 500;

      if (status === 500) {
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

      return respond(
        json(
          {
            ok: false,
            error:
              status === 500 || !(error instanceof Error)
                ? "Internal server error"
                : error.message,
          },
          status,
        ),
      );
    }
  };
}

/**
 * Parses data that came from the request. JSON and validation errors here are
 * the client's fault (400). The same error types from server-side state, such
 * as a corrupt targets.json or manifest, fall through to the logged 500.
 */
function parseRequestData<T>(parse: () => T): T {
  try {
    return parse();
  } catch (error) {
    if (error instanceof ZodError || error instanceof SyntaxError) {
      throw new BadRequestError(error.message);
    }

    throw error;
  }
}

function createUnmatchedApiResponse(
  pathname: string,
  exactRoutes: Map<string, RouteHandler>,
): Response {
  const allowedMethods = new Set<string>();

  for (const key of exactRoutes.keys()) {
    const separator = key.indexOf(" ");
    if (key.slice(separator + 1) === pathname) {
      allowedMethods.add(key.slice(0, separator));
    }
  }

  for (const route of parameterizedRoutes) {
    if (route.pattern.test(pathname)) {
      for (const method of route.methods) {
        allowedMethods.add(method);
      }
    }
  }

  if (allowedMethods.size === 0) {
    return json(
      {
        ok: false,
        error: `No API route matches ${pathname}.`,
      },
      404,
    );
  }

  if (allowedMethods.has("GET") && pathname !== eventStreamPath) {
    allowedMethods.add("HEAD");
  }
  const allow = [...allowedMethods].sort().join(", ");

  return json(
    {
      ok: false,
      error: `Method not allowed. Allowed methods: ${allow}.`,
    },
    405,
    {
      allow,
    },
  );
}

function createExactRoutes(
  options: HookaServerAppOptions,
  eventStreamTickets: Map<string, EventStreamTicketEntry>,
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
    [
      routeKey("GET", "/api/openapi.json"),
      () =>
        json(
          createOpenApiDocument({
            webhookAdapters: listWebhookAdapters(),
          }),
        ),
    ],
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
        const manifest = await getInstalledCapabilities(options);
        return json(
          createRegistrySummary(
            manifest.installed,
            options.runStore.listWorkerHeartbeats(),
          ),
        );
      },
    ],
    [
      routeKey("GET", "/api/runs"),
      (_request, url) => {
        const filters = parseRequestData(() =>
          runListQuerySchema.parse({
            limit: getPositiveInt(url.searchParams.get("limit"), 20),
            status: url.searchParams.get("status") ?? undefined,
            taskId: url.searchParams.get("taskId") ?? undefined,
            source: url.searchParams.get("source") ?? undefined,
          }),
        );
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
        const body = await readJsonBody(request, options.maxBodyBytes);
        const payload = parseRequestData(() =>
          enqueueRunRequestSchema.parse(body),
        );
        return handleGenericEnqueue(options, payload);
      },
    ],
    [routeKey("GET", "/api/targets"), () => handleTargetsList(options)],
    [
      routeKey("GET", "/api/audit-events"),
      (_request, url) => handleAuditEventsList(options, url),
    ],
    [
      routeKey("POST", "/api/targets"),
      async (request) => handleTargetCreate(options, request),
    ],
    [
      routeKey("POST", "/api/events/ticket"),
      () => createEventStreamTicketResponse(eventStreamTickets),
    ],
    [
      routeKey("GET", eventStreamPath),
      (request, url) =>
        createEventStreamResponse(options, request, url, eventStreamTickets),
    ],
    [
      routeKey("POST", "/api/webhooks/task"),
      async (request) => {
        const rawBody = await readTextBody(request, options.maxBodyBytes);
        return handleSignedIncomingWebhook(options, request, rawBody);
      },
    ],
  ]);

  for (const adapter of listWebhookAdapters()) {
    routes.set(routeKey("POST", adapter.routePath), async (request) => {
      const rawBody = await readTextBody(request, options.maxBodyBytes);
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

async function handleSignedIncomingWebhook(
  options: HookaServerAppOptions,
  request: Request,
  rawBody: string,
): Promise<Response> {
  const verified = verifySignedWebhook(options, request, rawBody);
  if (verified) {
    return verified;
  }

  const webhookPayload = parseRequestData(() =>
    parseIncomingTaskWebhook(rawBody),
  );
  return enqueueIncomingWebhook(options, webhookPayload);
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

  const webhookPayload = parseRequestData(() => adapter.normalize(rawBody));
  return enqueueIncomingWebhook(options, webhookPayload);
}

async function enqueueIncomingWebhook(
  options: HookaServerAppOptions,
  payload: IncomingTaskWebhook,
): Promise<Response> {
  if ("taskId" in payload) {
    const enqueuePayload = parseRequestData(() =>
      normalizeGenericTaskWebhook(payload as GenericTaskWebhook),
    );
    const enqueued = await enqueueRun(options, enqueuePayload);
    return json(enqueued.queued.response, enqueued.queued.created ? 202 : 200);
  }

  const targets = await loadTargets(options.targetsPath);
  let resolved: ResolvedTargetWebhook;
  try {
    resolved = resolveTargetWebhook(targets, payload);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith("Target override rejected:")) {
      appendAuditEvent(options, {
        category: "policy",
        action: "target_policy_rejected",
        outcome: "rejected",
        subjectType: "target",
        subjectId: payload.targetId,
        message,
        context: {
          targetId: payload.targetId,
          source: payload.source,
          eventId: payload.eventId,
        },
      });
      options.logger?.warn("Target policy rejected", {
        targetId: payload.targetId,
        error: message,
      });
    }
    return json(
      {
        ok: false,
        error: message,
      },
      message.startsWith("Target not found:") ? 404 : 400,
    );
  }
  const enqueued = await enqueueRun(
    options,
    {
      taskId: resolved.taskId,
      input: resolved.input,
      source: resolved.source,
      sourceEventId: resolved.sourceEventId,
    },
    {
      maxAttempts: resolved.target.maxAttempts,
      targetMaxConcurrentRuns: resolved.target.maxConcurrentRuns ?? 1,
      targetId: resolved.target.id,
      targetPolicy: resolved.target.policy,
    },
  );

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
    return createMisconfiguredServerResponse("HOOKA_WEBHOOK_SECRET");
  }

  if (isAuthorizedWebhookSecretRequest(request, options.webhookSecret)) {
    return null;
  }

  const signatureCheck = verifyHookaHmacSignature({
    secret: options.webhookSecret,
    timestampHeader: request.headers.get("x-hooka-timestamp"),
    signatureHeader: request.headers.get("x-hooka-signature"),
    rawBody,
  });

  if (!signatureCheck.ok) {
    appendAuditEvent(options, {
      category: "security",
      action: "webhook_signature_rejected",
      outcome: "rejected",
      subjectType: "webhook",
      request,
      message: signatureCheck.error,
      context: {
        status: signatureCheck.status,
      },
    });
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

async function handleTargetsList(
  options: HookaServerAppOptions,
): Promise<Response> {
  return json(await loadTargets(options.targetsPath));
}

function handleAuditEventsList(
  options: HookaServerAppOptions,
  url: URL,
): Response {
  const filters = parseRequestData(() =>
    auditEventListQuerySchema.parse({
      limit: getPositiveInt(url.searchParams.get("limit"), 20),
      category: url.searchParams.get("category") ?? undefined,
      outcome: url.searchParams.get("outcome") ?? undefined,
    }),
  );

  return json(
    options.runStore.listAuditEvents({
      limit: filters.limit,
      category: filters.category,
      outcome: filters.outcome,
    }),
  );
}

async function handleTargetDetail(
  options: HookaServerAppOptions,
  targetId: string,
): Promise<Response> {
  const target = (await loadTargets(options.targetsPath)).find(
    (candidate) => candidate.id === targetId,
  );

  if (!target) {
    return json(
      {
        ok: false,
        error: `Target not found: ${targetId}`,
      },
      404,
    );
  }

  return json(target);
}

async function handleTargetCreate(
  options: HookaServerAppOptions,
  request: Request,
): Promise<Response> {
  const body = await readJsonBody(request, options.maxBodyBytes);
  const target = parseRequestData(() => targetSchema.parse(body));

  try {
    await createTarget(options.targetsPath, target);
  } catch (error) {
    return handleTargetWriteError(error);
  }

  appendAuditEvent(options, {
    category: "targets",
    action: "target_created",
    outcome: "created",
    subjectType: "target",
    subjectId: target.id,
    request,
    message: `Target ${target.id} was created.`,
    context: {
      taskId: target.taskId,
    },
  });

  options.logger?.info("Target created", {
    targetId: target.id,
    taskId: target.taskId,
  });
  return json(target, 201);
}

async function handleTargetUpdate(
  options: HookaServerAppOptions,
  request: Request,
  targetId: string,
): Promise<Response> {
  const body = await readJsonBody(request, options.maxBodyBytes);
  const target = parseRequestData(() => targetSchema.parse(body));

  try {
    await updateTarget(options.targetsPath, targetId, target);
  } catch (error) {
    return handleTargetWriteError(error);
  }

  appendAuditEvent(options, {
    category: "targets",
    action: "target_updated",
    outcome: "updated",
    subjectType: "target",
    subjectId: target.id,
    request,
    message: `Target ${target.id} was updated.`,
    context: {
      taskId: target.taskId,
    },
  });

  options.logger?.info("Target updated", {
    targetId: target.id,
    taskId: target.taskId,
  });
  return json(target);
}

async function handleTargetDelete(
  options: HookaServerAppOptions,
  request: Request,
  targetId: string,
): Promise<Response> {
  try {
    await deleteTarget(options.targetsPath, targetId);
  } catch (error) {
    return handleTargetWriteError(error);
  }

  appendAuditEvent(options, {
    category: "targets",
    action: "target_deleted",
    outcome: "deleted",
    subjectType: "target",
    subjectId: targetId,
    request,
    message: `Target ${targetId} was deleted.`,
  });

  options.logger?.info("Target deleted", {
    targetId,
  });
  return json({
    ok: true,
    targetId,
  });
}

async function retryRun(
  options: HookaServerAppOptions,
  runId: string,
): Promise<Response> {
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

  if (
    run.status !== "failed" &&
    run.status !== "succeeded" &&
    run.status !== "dead-lettered" &&
    run.status !== "skipped"
  ) {
    return json(
      {
        ok: false,
        error: `Only terminal runs can be retried. Current status: ${run.status}`,
      },
      409,
    );
  }

  const manifest = await getInstalledCapabilities(options);
  const queued = options.runStore.enqueueRun({
    taskId: run.taskId,
    input: run.payload,
    source: "api.retry",
    capabilitySnapshot: manifest.installed,
    targetId: run.targetId ?? undefined,
    targetMaxConcurrentRuns: run.targetMaxConcurrentRuns ?? undefined,
    maxAttempts: run.maxAttempts,
  });

  return json(queued.response, 202);
}

async function enqueueRun(
  options: HookaServerAppOptions,
  payload: EnqueueRunRequest,
  metadata: EnqueueMetadata = {},
) {
  const task = getTask(payload.taskId);

  if (!task) {
    throw new NotFoundError(`Task not found: ${payload.taskId}`);
  }

  const manifest = await getInstalledCapabilities(options);
  const parsedInput = parseRequestData(() =>
    task.input.parse(payload.input ?? {}),
  );
  const queued = options.runStore.enqueueRun({
    taskId: task.id,
    input: parsedInput,
    source: payload.source,
    sourceEventId: payload.sourceEventId,
    capabilitySnapshot: manifest.installed,
    targetId: metadata.targetId,
    targetPolicy: metadata.targetPolicy,
    maxAttempts: metadata.maxAttempts ?? options.defaultMaxAttempts,
    targetMaxConcurrentRuns: metadata.targetMaxConcurrentRuns,
  });

  return {
    task,
    queued,
  };
}

async function getInstalledCapabilities(
  options: HookaServerAppOptions,
): Promise<InstalledCapabilitiesManifest> {
  return (options.loadCapabilities ?? loadInstalledCapabilities)(
    options.capabilityManifestPath,
  );
}

function createEventStreamResponse(
  options: HookaServerAppOptions,
  request: Request,
  url: URL,
  eventStreamTickets: Map<string, EventStreamTicketEntry>,
): Response {
  const ticket = url.searchParams.get("ticket");
  const ticketCheck = consumeEventStreamTicket(eventStreamTickets, ticket);
  if (!ticketCheck.ok) {
    appendAuditEvent(options, {
      category: "security",
      action: "event_stream_ticket_rejected",
      outcome: "rejected",
      subjectType: "request",
      request,
      message: `Event stream ticket rejected: ${ticketCheck.reason}.`,
      context: {
        reason: ticketCheck.reason,
      },
    });
    options.logger?.warn("Event stream ticket rejected", {
      pathname: url.pathname,
      reason: ticketCheck.reason,
    });
    return json(
      {
        ok: false,
        error: createEventStreamTicketError(ticketCheck.reason),
      },
      401,
    );
  }

  const encoder = new TextEncoder();
  const keepaliveMs = options.eventStreamKeepaliveMs ?? 15_000;
  let lastWriteAt = Date.now();
  let interval: ReturnType<typeof setInterval> | undefined;
  let cleanedUp = false;
  let lastSequence = options.runStore.getLastRunEventSequence();
  let lastAuditSequence = options.runStore.getLastAuditEventSequence();
  let lastWorkerSeenAt =
    options.runStore.listWorkerHeartbeats()[0]?.lastSeenAt ?? null;

  function cleanup(): void {
    if (cleanedUp) {
      return;
    }

    cleanedUp = true;
    if (interval) {
      clearInterval(interval);
    }
  }

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      writeSseEvent(controller, encoder, "ready", {
        sequence: lastSequence,
        auditSequence: lastAuditSequence,
        workers: options.runStore.listWorkerHeartbeats(),
      });

      interval = setInterval(() => {
        const events = options.runStore.listRunEventsSince(lastSequence, 100);
        const auditSequence = options.runStore.getLastAuditEventSequence();
        const workers = options.runStore.listWorkerHeartbeats();
        const latestWorkerSeenAt = workers[0]?.lastSeenAt ?? null;

        if (
          events.length === 0 &&
          auditSequence === lastAuditSequence &&
          latestWorkerSeenAt === lastWorkerSeenAt
        ) {
          // Quiet streams would otherwise hit the server's 30s idle timeout
          // (and proxy read timeouts) and disconnect the admin UI.
          if (Date.now() - lastWriteAt >= keepaliveMs) {
            controller.enqueue(encoder.encode(": keepalive\n\n"));
            lastWriteAt = Date.now();
          }
          return;
        }

        if (events.length > 0) {
          lastSequence = events[events.length - 1]?.sequence ?? lastSequence;
        }
        lastAuditSequence = auditSequence;
        lastWorkerSeenAt = latestWorkerSeenAt;

        writeSseEvent(controller, encoder, "update", {
          events,
          auditSequence,
          workers,
        });
        lastWriteAt = Date.now();
      }, 1_000);
    },
    cancel() {
      cleanup();
    },
  });

  request.signal.addEventListener("abort", () => {
    cleanup();
  });

  return new Response(stream, {
    headers: withSecurityHeaders({
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "content-type": "text/event-stream; charset=utf-8",
    }),
  });
}

function createEventStreamTicketResponse(
  eventStreamTickets: Map<string, EventStreamTicketEntry>,
): Response {
  const issuedAt = Date.now();
  sweepExpiredEventStreamTickets(eventStreamTickets, issuedAt);

  const ticket = crypto.randomUUID();
  const expiresAt = issuedAt + 30_000;
  eventStreamTickets.set(ticket, {
    consumed: false,
    expiresAt,
  });

  return json({
    ticket,
    expiresAt: new Date(expiresAt).toISOString(),
  });
}

function writeSseEvent(
  controller: ReadableStreamDefaultController<Uint8Array>,
  encoder: TextEncoder,
  event: string,
  data: unknown,
): void {
  controller.enqueue(
    encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
  );
}

async function readJsonBody(
  request: Request,
  maxBodyBytes: number,
): Promise<unknown> {
  const text = await readTextBody(request, maxBodyBytes);
  return parseRequestData(() => JSON.parse(text));
}

async function readTextBody(
  request: Request,
  maxBodyBytes: number,
): Promise<string> {
  const contentLength = request.headers.get("content-length");
  if (contentLength) {
    const parsedLength = Number(contentLength);
    if (Number.isFinite(parsedLength) && parsedLength > maxBodyBytes) {
      throw new PayloadTooLargeError("Payload too large.");
    }
  }

  if (!request.body) {
    return "";
  }

  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let totalBytes = 0;
  let text = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    totalBytes += value.byteLength;
    if (totalBytes > maxBodyBytes) {
      await reader.cancel();
      throw new PayloadTooLargeError("Payload too large.");
    }

    text += decoder.decode(value, {
      stream: true,
    });
  }

  text += decoder.decode();
  return text;
}

function requireAdminAuth(
  options: HookaServerAppOptions,
  request: Request,
  pathname: string,
): Response | null {
  if (isPublicServerRoute(request.method, pathname)) {
    return null;
  }

  if (!pathname.startsWith("/api/")) {
    return null;
  }

  if (pathname === "/api/events/stream") {
    return null;
  }

  if (!options.adminToken) {
    options.logger?.error("Admin token is not configured", {
      pathname,
    });
    return createMisconfiguredServerResponse("HOOKA_ADMIN_TOKEN");
  }

  if (isAuthorizedAdminRequest(request, options.adminToken)) {
    return null;
  }

  appendAuditEvent(options, {
    category: "security",
    action: "admin_auth_rejected",
    outcome: "rejected",
    subjectType: "request",
    request,
    message: "Missing or invalid admin token.",
  });
  options.logger?.warn("Admin authorization rejected", {
    pathname,
  });
  return json(
    {
      ok: false,
      error: "Missing or invalid admin token.",
    },
    401,
    {
      "www-authenticate": 'Bearer realm="hooka"',
    },
  );
}

function checkRateLimit(
  options: HookaServerAppOptions,
  request: Request,
  apiRateLimiter: InMemoryRateLimiter,
  webhookRateLimiter: InMemoryRateLimiter,
  globalApiRateLimiter: InMemoryRateLimiter,
  globalWebhookRateLimiter: InMemoryRateLimiter,
): Response | null {
  const pathname = new URL(request.url).pathname;

  if (!pathname.startsWith("/api/")) {
    return null;
  }

  const context = createServerRateLimitContext(request, {
    trustProxy: options.trustProxy,
  });
  const rateLimiter =
    context.bucket === "webhook" ? webhookRateLimiter : apiRateLimiter;
  const globalRateLimiter =
    context.bucket === "webhook"
      ? globalWebhookRateLimiter
      : globalApiRateLimiter;
  const clientDecision = rateLimiter.check(context.clientKey);
  const globalDecision = globalRateLimiter.check(context.globalKey);
  const decision = clientDecision.ok ? globalDecision : clientDecision;

  if (decision.ok) {
    return null;
  }

  appendAuditEvent(options, {
    category: "security",
    action: "rate_limit_rejected",
    outcome: "rejected",
    subjectType: context.bucket,
    subjectId: decision.key,
    clientIp: context.clientIp,
    requestPath: context.pathname,
    message: "Rate limit exceeded.",
    context: {
      bucket: context.bucket,
      scope: clientDecision.ok ? "global" : "client",
      retryAfterSeconds: decision.retryAfterSeconds,
    },
  });
  options.logger?.warn("Rate limit rejected", {
    pathname: context.pathname,
    clientIp: context.clientIp,
    bucket: context.bucket,
    key: decision.key,
    scope: clientDecision.ok ? "global" : "client",
    retryAfterSeconds: decision.retryAfterSeconds,
  });

  return json(
    {
      ok: false,
      error: "Rate limit exceeded.",
    },
    429,
    {
      "retry-after": String(decision.retryAfterSeconds ?? 60),
    },
  );
}

function json(
  data: unknown,
  status = 200,
  headersInit: HeadersInit = {},
): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: withSecurityHeaders({
      "content-type": "application/json; charset=utf-8",
      ...headersInit,
    }),
  });
}

function createMisconfiguredServerResponse(setting: string): Response {
  return json(
    {
      ok: false,
      error: `Server misconfigured: ${setting} is not configured.`,
    },
    503,
  );
}

function createCorsPreflightResponse(
  request: Request,
  pathname: string,
  corsOrigins: string[],
): Response | null {
  if (
    request.method.toUpperCase() !== "OPTIONS" ||
    !pathname.startsWith("/api/")
  ) {
    return null;
  }

  const origin = request.headers.get("origin");
  if (!origin || !corsOrigins.includes(origin)) {
    return json(
      {
        ok: false,
        error: "CORS origin not allowed.",
      },
      403,
    );
  }

  return new Response(null, {
    status: 204,
    headers: withSecurityHeaders({
      "access-control-allow-origin": origin,
      "access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS",
      "access-control-allow-headers": "authorization,content-type",
      "access-control-max-age": "600",
      vary: "origin",
    }),
  });
}

function applyCorsHeaders(
  request: Request,
  pathname: string,
  response: Response,
  corsOrigins: string[],
): Response {
  if (!pathname.startsWith("/api/")) {
    return response;
  }

  const origin = request.headers.get("origin");
  if (!origin || !corsOrigins.includes(origin)) {
    return response;
  }

  const headers = new Headers(response.headers);
  headers.set("access-control-allow-origin", origin);
  headers.set("vary", "origin");

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function routeKey(method: string, pathname: string): string {
  return `${method.toUpperCase()} ${pathname}`;
}

function matchPathParam(
  method: string,
  expectedMethod: string,
  pathname: string,
  pattern: RegExp,
): string | null {
  if (method.toUpperCase() !== expectedMethod) {
    return null;
  }

  const segment = pathname.match(pattern)?.[1];
  if (segment === undefined) {
    return null;
  }

  // The admin UI and CLI percent-encode ids such as `site:prod`.
  try {
    return decodeURIComponent(segment);
  } catch {
    throw new BadRequestError(`Malformed path segment: ${segment}`);
  }
}

function matchRunIdRoute(method: string, pathname: string): string | null {
  return matchPathParam(method, "GET", pathname, runPathPattern);
}

function matchRunRetryRoute(method: string, pathname: string): string | null {
  return matchPathParam(method, "POST", pathname, runRetryPathPattern);
}

function matchTargetDetailRoute(
  method: string,
  pathname: string,
): string | null {
  return matchPathParam(method, "GET", pathname, targetPathPattern);
}

function matchTargetUpdateRoute(
  method: string,
  pathname: string,
): string | null {
  return matchPathParam(method, "PUT", pathname, targetPathPattern);
}

function matchTargetDeleteRoute(
  method: string,
  pathname: string,
): string | null {
  return matchPathParam(method, "DELETE", pathname, targetPathPattern);
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
  headers.set(
    "content-security-policy",
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'",
  );
  return headers;
}

function appendAuditEvent(
  options: HookaServerAppOptions,
  input: {
    category: AuditEventCategory;
    action: string;
    outcome: "rejected" | "created" | "updated" | "deleted";
    subjectType: string;
    subjectId?: string | null;
    clientIp?: string | null;
    requestPath?: string | null;
    request?: Request;
    message: string;
    context?: unknown;
  },
): void {
  const rateLimitContext = input.request
    ? createServerRateLimitContext(input.request, {
        trustProxy: options.trustProxy,
      })
    : null;

  options.runStore.appendAuditEvent({
    category: input.category,
    action: input.action,
    outcome: input.outcome,
    subjectType: input.subjectType,
    subjectId: input.subjectId ?? null,
    clientIp: input.clientIp ?? rateLimitContext?.clientIp ?? null,
    requestPath: input.requestPath ?? rateLimitContext?.pathname ?? null,
    message: input.message,
    context: input.context,
  });
}

function handleTargetWriteError(error: unknown): Response {
  if (
    !(error instanceof TargetNotFoundError) &&
    !(error instanceof TargetConflictError) &&
    !(error instanceof TargetValidationError)
  ) {
    // I/O failures such as EACCES are server faults; let the request handler
    // log them and answer 500 without echoing file-system paths.
    throw error;
  }

  return json(
    {
      ok: false,
      error: error.message,
    },
    error instanceof TargetNotFoundError ? 404 : 409,
  );
}

function sweepExpiredEventStreamTickets(
  eventStreamTickets: Map<string, EventStreamTicketEntry>,
  nowMs: number,
): void {
  for (const [ticket, entry] of eventStreamTickets.entries()) {
    if (entry.expiresAt <= nowMs) {
      eventStreamTickets.delete(ticket);
    }
  }
}

function consumeEventStreamTicket(
  eventStreamTickets: Map<string, EventStreamTicketEntry>,
  ticket: string | null,
  nowMs = Date.now(),
): EventStreamTicketCheck {
  if (!ticket) {
    sweepExpiredEventStreamTickets(eventStreamTickets, nowMs);
    return {
      ok: false,
      reason: "missing",
    };
  }

  const entry = eventStreamTickets.get(ticket);
  if (!entry) {
    sweepExpiredEventStreamTickets(eventStreamTickets, nowMs);
    return {
      ok: false,
      reason: "unknown",
    };
  }

  if (entry.expiresAt <= nowMs) {
    eventStreamTickets.delete(ticket);
    sweepExpiredEventStreamTickets(eventStreamTickets, nowMs);
    return {
      ok: false,
      reason: "expired",
    };
  }

  if (entry.consumed) {
    sweepExpiredEventStreamTickets(eventStreamTickets, nowMs);
    return {
      ok: false,
      reason: "reused",
    };
  }

  entry.consumed = true;
  eventStreamTickets.set(ticket, entry);
  sweepExpiredEventStreamTickets(eventStreamTickets, nowMs);
  return {
    ok: true,
  };
}

function createEventStreamTicketError(
  reason: EventStreamTicketRejectionReason,
): string {
  if (reason === "expired") {
    return "Event stream ticket expired.";
  }

  if (reason === "reused") {
    return "Event stream ticket has already been used.";
  }

  return "Missing or invalid event stream ticket.";
}
