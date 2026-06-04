const adminAuthResponses = {
  401: { description: "Missing or invalid admin bearer token." },
  503: { description: "Server is missing HOOKA_ADMIN_TOKEN." },
};

const webhookIngressResponses = {
  200: { description: "Existing run reused" },
  202: { description: "Run queued" },
  400: { description: "Malformed webhook body" },
  401: { description: "Webhook signature verification failed" },
  413: { description: "Payload too large" },
  503: { description: "Server is missing HOOKA_WEBHOOK_SECRET." },
};

export function createOpenApiDocument() {
  return {
    openapi: "3.1.0",
    info: {
      title: "Hooka API",
      version: "1.0.0",
      description:
        "Machine-readable API surface for the Hooka single-node SQLite control plane.",
    },
    servers: [{ url: "/" }],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "token",
        },
        webhookSignature: {
          type: "apiKey",
          in: "header",
          name: "x-hooka-signature",
          description:
            "Used together with x-hooka-timestamp to verify HMAC signed webhook requests.",
        },
      },
      schemas: {
        ErrorResponse: {
          type: "object",
          properties: {
            ok: { type: "boolean", const: false },
            error: { type: "string" },
          },
          required: ["ok", "error"],
        },
        EnqueueRunRequest: {
          type: "object",
          properties: {
            taskId: { type: "string" },
            input: {},
            source: { type: "string" },
            sourceEventId: { type: "string" },
          },
          required: ["taskId"],
        },
        EventStreamTicket: {
          type: "object",
          properties: {
            ticket: { type: "string" },
            expiresAt: { type: "string", format: "date-time" },
          },
          required: ["ticket", "expiresAt"],
        },
        GenericTaskWebhook: {
          type: "object",
          properties: {
            taskId: { type: "string" },
            input: {},
            eventId: { type: "string" },
            source: { type: "string" },
          },
          required: ["taskId", "eventId"],
        },
        TargetedTaskWebhook: {
          type: "object",
          properties: {
            targetId: { type: "string" },
            overrides: { type: "object", additionalProperties: true },
            eventId: { type: "string" },
            source: { type: "string" },
          },
          required: ["targetId", "eventId"],
        },
      },
    },
    paths: {
      "/api/health": {
        get: {
          summary: "Server liveness",
          responses: {
            200: {
              description: "Server is alive",
            },
          },
        },
      },
      "/api/ready": {
        get: {
          summary: "Server readiness",
          responses: {
            200: { description: "Store is ready" },
            503: { description: "Store is not ready" },
          },
        },
      },
      "/api/openapi.json": {
        get: {
          summary: "OpenAPI document",
          responses: {
            200: {
              description: "OpenAPI 3.1 document",
            },
          },
        },
      },
      "/api/tasks": {
        get: {
          summary: "List registered tasks",
          security: [{ bearerAuth: [] }],
          responses: {
            200: { description: "Registered tasks" },
            ...adminAuthResponses,
          },
        },
      },
      "/api/capabilities": {
        get: {
          summary: "List registered capabilities",
          security: [{ bearerAuth: [] }],
          responses: {
            200: { description: "Registered capabilities" },
            ...adminAuthResponses,
          },
        },
      },
      "/api/presets": {
        get: {
          summary: "List active presets and plans",
          security: [{ bearerAuth: [] }],
          responses: {
            200: { description: "Preset catalog" },
            ...adminAuthResponses,
          },
        },
      },
      "/api/summary": {
        get: {
          summary: "Registry and worker summary",
          security: [{ bearerAuth: [] }],
          responses: {
            200: { description: "Summary payload" },
            ...adminAuthResponses,
          },
        },
      },
      "/api/runs": {
        get: {
          summary: "List runs",
          security: [{ bearerAuth: [] }],
          responses: {
            200: { description: "Run summaries" },
            ...adminAuthResponses,
          },
        },
        post: {
          summary: "Enqueue a task run",
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/EnqueueRunRequest" },
              },
            },
          },
          responses: {
            202: { description: "Run queued" },
            404: { description: "Task not found" },
            413: { description: "Payload too large" },
            ...adminAuthResponses,
          },
        },
      },
      "/api/runs/{id}": {
        get: {
          summary: "Get one run",
          security: [{ bearerAuth: [] }],
          parameters: [
            {
              name: "id",
              in: "path",
              required: true,
              schema: { type: "string" },
            },
          ],
          responses: {
            200: { description: "Run detail" },
            404: { description: "Run not found" },
            ...adminAuthResponses,
          },
        },
      },
      "/api/runs/{id}/retry": {
        post: {
          summary: "Retry a terminal run",
          security: [{ bearerAuth: [] }],
          parameters: [
            {
              name: "id",
              in: "path",
              required: true,
              schema: { type: "string" },
            },
          ],
          responses: {
            202: { description: "Retry queued" },
            404: { description: "Run not found" },
            409: { description: "Run is not terminal" },
            ...adminAuthResponses,
          },
        },
      },
      "/api/targets": {
        get: {
          summary: "List configured targets",
          security: [{ bearerAuth: [] }],
          responses: {
            200: { description: "Target list" },
            ...adminAuthResponses,
          },
        },
        post: {
          summary: "Create a target",
          security: [{ bearerAuth: [] }],
          responses: {
            200: { description: "Target created" },
            400: { description: "Invalid target" },
            409: { description: "Target conflict" },
            ...adminAuthResponses,
          },
        },
      },
      "/api/targets/{id}": {
        get: {
          summary: "Get one target",
          security: [{ bearerAuth: [] }],
          parameters: [
            {
              name: "id",
              in: "path",
              required: true,
              schema: { type: "string" },
            },
          ],
          responses: {
            200: { description: "Target detail" },
            404: { description: "Target not found" },
            ...adminAuthResponses,
          },
        },
        put: {
          summary: "Replace a target",
          security: [{ bearerAuth: [] }],
          parameters: [
            {
              name: "id",
              in: "path",
              required: true,
              schema: { type: "string" },
            },
          ],
          responses: {
            200: { description: "Target updated" },
            400: { description: "Invalid target" },
            404: { description: "Target not found" },
            409: { description: "Target conflict" },
            ...adminAuthResponses,
          },
        },
        delete: {
          summary: "Delete a target",
          security: [{ bearerAuth: [] }],
          parameters: [
            {
              name: "id",
              in: "path",
              required: true,
              schema: { type: "string" },
            },
          ],
          responses: {
            200: { description: "Target deleted" },
            404: { description: "Target not found" },
            ...adminAuthResponses,
          },
        },
      },
      "/api/audit-events": {
        get: {
          summary: "List audit events",
          security: [{ bearerAuth: [] }],
          responses: {
            200: { description: "Audit events" },
            ...adminAuthResponses,
          },
        },
      },
      "/api/events/ticket": {
        post: {
          summary: "Issue a short-lived SSE ticket",
          security: [{ bearerAuth: [] }],
          responses: {
            200: {
              description: "Short-lived ticket",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/EventStreamTicket" },
                },
              },
            },
            ...adminAuthResponses,
          },
        },
      },
      "/api/events/stream": {
        get: {
          summary: "Subscribe to SSE run and worker updates",
          parameters: [
            {
              name: "ticket",
              in: "query",
              required: true,
              schema: { type: "string" },
            },
          ],
          responses: {
            200: { description: "Event stream" },
            401: {
              description: "Missing, expired, invalid, or already consumed ticket",
            },
          },
        },
      },
      "/api/webhooks/task": {
        post: {
          summary: "Receive a signed generic or target-based webhook",
          security: [{ webhookSignature: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  oneOf: [
                    { $ref: "#/components/schemas/GenericTaskWebhook" },
                    { $ref: "#/components/schemas/TargetedTaskWebhook" },
                  ],
                },
              },
            },
          },
          responses: webhookIngressResponses,
        },
      },
      "/api/webhooks/wordpress/simply-static": {
        post: {
          summary: "Compatibility alias for WordPress Simply Static webhooks",
          security: [{ webhookSignature: [] }],
          responses: webhookIngressResponses,
        },
      },
    },
  };
}
