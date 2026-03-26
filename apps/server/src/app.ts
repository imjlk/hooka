import type {
  EnqueueRunRequest,
  WordpressSimplyStaticWebhook,
} from "@hooka/contracts";
import {
  enqueueRunRequestSchema,
  wordpressSimplyStaticWebhookSchema,
} from "@hooka/contracts";
import {
  createRegistrySummary,
  getPresetPlan,
  getTask,
  listCapabilities,
  listPresets,
  listTasks,
} from "@hooka/registry";
import type { RunStore } from "@hooka/run-store";
import { loadInstalledCapabilities } from "@hooka/runner-core";
import { extname, resolve } from "node:path";
import { ZodError } from "zod";
import {
  parseWordpressSimplyStaticWebhook,
  verifyHookaHmacSignature,
} from "./lib/webhooks";

export interface HookaServerAppOptions {
  capabilityManifestPath: string;
  runStore: RunStore;
  uiDistDir: string;
  webhookSecret?: string;
}

export function createHookaFetchHandler(options: HookaServerAppOptions) {
  return async function fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    try {
      if (url.pathname === "/api/health") {
        return json({
          ok: true,
          service: "hooka-server",
        });
      }

      if (url.pathname === "/api/tasks") {
        return json(listTasks());
      }

      if (url.pathname === "/api/capabilities") {
        return json(listCapabilities());
      }

      if (url.pathname === "/api/presets") {
        return json(
          listPresets().map((preset) => ({
            ...preset,
            plan: getPresetPlan(preset.id),
          })),
        );
      }

      if (url.pathname === "/api/summary") {
        const manifest = await loadInstalledCapabilities(options.capabilityManifestPath);
        return json(createRegistrySummary(manifest.installed));
      }

      if (url.pathname === "/api/runs" && request.method === "GET") {
        const limit = getPositiveInt(url.searchParams.get("limit"), 20);
        return json(options.runStore.listRuns(limit));
      }

      if (url.pathname === "/api/runs" && request.method === "POST") {
        const payload = enqueueRunRequestSchema.parse(await request.json());
        return handleGenericEnqueue(options, payload);
      }

      if (
        url.pathname === "/api/webhooks/wordpress/simply-static" &&
        request.method === "POST"
      ) {
        const rawBody = await request.text();
        return handleSimplyStaticWebhook(options, request, rawBody);
      }

      const runMatch = url.pathname.match(/^\/api\/runs\/([^/]+)$/);
      if (runMatch && request.method === "GET") {
        const runId = runMatch[1] ?? "";
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
      return json(
        {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        },
        error instanceof ZodError || error instanceof SyntaxError ? 400 : 500,
      );
    }
  };
}

async function handleGenericEnqueue(
  options: HookaServerAppOptions,
  payload: EnqueueRunRequest,
): Promise<Response> {
  const task = getTask(payload.taskId);

  if (!task) {
    return json(
      {
        ok: false,
        error: `Task not found: ${payload.taskId}`,
      },
      404,
    );
  }

  const manifest = await loadInstalledCapabilities(options.capabilityManifestPath);
  const parsedInput = task.input.parse(payload.input ?? {});
  const queued = options.runStore.enqueueRun({
    taskId: payload.taskId,
    input: parsedInput,
    source: payload.source,
    sourceEventId: payload.sourceEventId,
    capabilitySnapshot: manifest.installed,
  });

  return json(queued.response, 202);
}

async function handleSimplyStaticWebhook(
  options: HookaServerAppOptions,
  request: Request,
  rawBody: string,
): Promise<Response> {
  if (!options.webhookSecret) {
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
    return json(
      {
        ok: false,
        error: signatureCheck.error,
      },
      signatureCheck.status,
    );
  }

  const webhookPayload = parseWordpressSimplyStaticWebhook(rawBody);
  return enqueueSimplyStaticWebhook(options, webhookPayload);
}

async function enqueueSimplyStaticWebhook(
  options: HookaServerAppOptions,
  payload: WordpressSimplyStaticWebhook,
): Promise<Response> {
  const task = getTask("wordpress.deploy.simply-static");

  if (!task) {
    return json(
      {
        ok: false,
        error: "Task not found: wordpress.deploy.simply-static",
      },
      404,
    );
  }

  const manifest = await loadInstalledCapabilities(options.capabilityManifestPath);
  const validatedWebhookPayload = wordpressSimplyStaticWebhookSchema.parse(payload);
  const parsedInput = task.input.parse({
    project: validatedWebhookPayload.project,
    exportDir: validatedWebhookPayload.exportDir,
    branch: validatedWebhookPayload.branch,
    commitSha: validatedWebhookPayload.commitSha,
  });
  const queued = options.runStore.enqueueRun({
    taskId: task.id,
    input: parsedInput,
    source: "wordpress.webhook.simply-static",
    sourceEventId: validatedWebhookPayload.eventId,
    capabilitySnapshot: manifest.installed,
  });

  return json(queued.response, queued.created ? 202 : 200);
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
    },
  });
}

async function serveUi(pathname: string, uiDistDir: string): Promise<Response> {
  const assetPath = resolve(uiDistDir, `.${pathname}`);
  const isAssetRequest = extname(pathname).length > 0;

  if (assetPath.startsWith(uiDistDir)) {
    const assetFile = Bun.file(assetPath);
    if (isAssetRequest && (await assetFile.exists())) {
      return new Response(assetFile);
    }
  }

  const indexFile = Bun.file(resolve(uiDistDir, "index.html"));

  if (await indexFile.exists()) {
    return new Response(indexFile);
  }

  return new Response(
    "Admin UI bundle not found. Run `bun --filter @hooka/admin-ui run build`.",
    {
      status: 503,
      headers: {
        "content-type": "text/plain; charset=utf-8",
      },
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
