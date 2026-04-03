import type {
  AuditEventCategory,
  EnqueueRunRequest,
  GenericTaskWebhook,
  IncomingTaskWebhook,
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
  updateTarget,
} from "@hooka/targets";
import { extname, resolve } from "node:path";
import { ZodError } from "zod";
import { isAuthorizedAdminRequest, isPublicServerRoute } from "./lib/auth";
import {
  InMemoryRateLimiter,
  createServerRateLimitContext,
} from "./lib/rate-limit";
import {
  normalizeGenericTaskWebhook,
  parseIncomingTaskWebhook,
  verifyHookaHmacSignature,
} from "./lib/webhooks";

export interface HookaServerAppOptions {
  adminToken?: string;
  apiRateLimit: number;
  capabilityManifestPath: string;
  defaultMaxAttempts: number;
  logger?: Logger;
  rateLimitWindowMs: number;
  runStore: RunStore;
  targetsPath: string;
  trustProxy: boolean;
  uiDistDir: string;
  webhookRateLimit: number;
  webhookSecret?: string;
}

class NotFoundError extends Error {}

type RouteHandler = (
  request: Request,
  url: URL,
) => Promise<Response> | Response;

interface EnqueueMetadata {
  maxAttempts?: number;
  targetId?: string;
  targetPolicy?: TargetPolicy;
}

export function createHookaFetchHandler(options: HookaServerAppOptions) {
  const exactRoutes = createExactRoutes(options);
  const apiRateLimiter = new InMemoryRateLimiter({
    limit: options.apiRateLimit,
    windowMs: options.rateLimitWindowMs,
  });
  const webhookRateLimiter = new InMemoryRateLimiter({
    limit: options.webhookRateLimit,
    windowMs: options.rateLimitWindowMs,
  });

  return async function fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    try {
      if (url.pathname.startsWith("/api/")) {
        const rateLimitResponse = checkRateLimit(
          options,
          request,
          apiRateLimiter,
          webhookRateLimiter,
        );
        if (rateLimitResponse) {
          return rateLimitResponse;
        }

        const authResponse = requireAdminAuth(options, request, url.pathname);
        if (authResponse) {
          return authResponse;
        }
      }

      const exactHandler = exactRoutes.get(
        routeKey(request.method, url.pathname),
      );
      if (exactHandler) {
        return await exactHandler(request, url);
      }

      const retryRunId = matchRunRetryRoute(request.method, url.pathname);
      if (retryRunId) {
        return retryRun(options, retryRunId);
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

      const targetDetailId = matchTargetDetailRoute(
        request.method,
        url.pathname,
      );
      if (targetDetailId) {
        return handleTargetDetail(options, targetDetailId);
      }

      const targetUpdateId = matchTargetUpdateRoute(
        request.method,
        url.pathname,
      );
      if (targetUpdateId) {
        return handleTargetUpdate(options, request, targetUpdateId);
      }

      const targetDeleteId = matchTargetDeleteRoute(
        request.method,
        url.pathname,
      );
      if (targetDeleteId) {
        return handleTargetDelete(options, request, targetDeleteId);
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
      routeKey("GET", "/api/events/stream"),
      (request) => createEventStreamResponse(options, request),
    ],
    [
      routeKey("POST", "/api/webhooks/task"),
      async (request) => {
        const rawBody = await request.text();
        return handleSignedIncomingWebhook(options, request, rawBody);
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

async function handleSignedIncomingWebhook(
  options: HookaServerAppOptions,
  request: Request,
  rawBody: string,
): Promise<Response> {
  const verified = verifySignedWebhook(options, request, rawBody);
  if (verified) {
    return verified;
  }

  const webhookPayload = parseIncomingTaskWebhook(rawBody);
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

  const webhookPayload = adapter.normalize(rawBody);
  return enqueueIncomingWebhook(options, webhookPayload);
}

async function enqueueIncomingWebhook(
  options: HookaServerAppOptions,
  payload: IncomingTaskWebhook,
): Promise<Response> {
  if ("taskId" in payload) {
    const enqueuePayload = normalizeGenericTaskWebhook(
      payload as GenericTaskWebhook,
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
  const filters = auditEventListQuerySchema.parse({
    limit: getPositiveInt(url.searchParams.get("limit"), 20),
    category: url.searchParams.get("category") ?? undefined,
    outcome: url.searchParams.get("outcome") ?? undefined,
  });

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
  const target = targetSchema.parse(await request.json());

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
  const target = targetSchema.parse(await request.json());

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

  const manifest = await loadInstalledCapabilities(
    options.capabilityManifestPath,
  );
  const queued = options.runStore.enqueueRun({
    taskId: run.taskId,
    input: run.payload,
    source: "api.retry",
    capabilitySnapshot: manifest.installed,
    targetId: run.targetId ?? undefined,
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
    targetId: metadata.targetId,
    targetPolicy: metadata.targetPolicy,
    maxAttempts: metadata.maxAttempts ?? options.defaultMaxAttempts,
  });

  return {
    task,
    queued,
  };
}

function createEventStreamResponse(
  options: HookaServerAppOptions,
  request: Request,
): Response {
  const encoder = new TextEncoder();
  let interval: ReturnType<typeof setInterval> | undefined;
  let lastSequence = options.runStore.getLastRunEventSequence();
  let lastAuditSequence = options.runStore.getLastAuditEventSequence();
  let lastWorkerSeenAt =
    options.runStore.listWorkerHeartbeats()[0]?.lastSeenAt ?? null;

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
      }, 1_000);
    },
    cancel() {
      if (interval) {
        clearInterval(interval);
      }
    },
  });

  request.signal.addEventListener("abort", () => {
    if (interval) {
      clearInterval(interval);
    }
  });

  return new Response(stream, {
    headers: withSecurityHeaders({
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "content-type": "text/event-stream; charset=utf-8",
    }),
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

  if (
    isAuthorizedAdminRequest(request, options.adminToken, {
      allowQueryToken: pathname === "/api/events/stream",
    })
  ) {
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
  );
}

function checkRateLimit(
  options: HookaServerAppOptions,
  request: Request,
  apiRateLimiter: InMemoryRateLimiter,
  webhookRateLimiter: InMemoryRateLimiter,
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
  const decision = rateLimiter.check(context.key);

  if (decision.ok) {
    return null;
  }

  appendAuditEvent(options, {
    category: "security",
    action: "rate_limit_rejected",
    outcome: "rejected",
    subjectType: context.bucket,
    subjectId: context.key,
    clientIp: context.clientIp,
    requestPath: context.pathname,
    message: "Rate limit exceeded.",
    context: {
      bucket: context.bucket,
      retryAfterSeconds: decision.retryAfterSeconds,
    },
  });
  options.logger?.warn("Rate limit rejected", {
    pathname: context.pathname,
    clientIp: context.clientIp,
    bucket: context.bucket,
    key: decision.key,
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

function matchRunRetryRoute(method: string, pathname: string): string | null {
  if (method.toUpperCase() !== "POST") {
    return null;
  }

  const match = pathname.match(/^\/api\/runs\/([^/]+)\/retry$/);
  return match?.[1] ?? null;
}

function matchTargetDetailRoute(
  method: string,
  pathname: string,
): string | null {
  if (method.toUpperCase() !== "GET") {
    return null;
  }

  const match = pathname.match(/^\/api\/targets\/([^/]+)$/);
  return match?.[1] ?? null;
}

function matchTargetUpdateRoute(
  method: string,
  pathname: string,
): string | null {
  if (method.toUpperCase() !== "PUT") {
    return null;
  }

  const match = pathname.match(/^\/api\/targets\/([^/]+)$/);
  return match?.[1] ?? null;
}

function matchTargetDeleteRoute(
  method: string,
  pathname: string,
): string | null {
  if (method.toUpperCase() !== "DELETE") {
    return null;
  }

  const match = pathname.match(/^\/api\/targets\/([^/]+)$/);
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
  const message = error instanceof Error ? error.message : String(error);

  return json(
    {
      ok: false,
      error: message,
    },
    message.startsWith("Target not found:")
      ? 404
      : message.startsWith("Target already exists:")
        ? 409
        : message.startsWith("Target id mismatch:")
          ? 409
          : 400,
  );
}
