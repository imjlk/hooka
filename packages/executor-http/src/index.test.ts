import { afterEach, expect, test } from "bun:test";
import { defineTask } from "@hooka/task-sdk";
import { z } from "zod";
import { runHttpTask } from "./index";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const httpTaskInput = z.object({
  project: z.string(),
});

const httpTask = defineTask({
  id: "test.http.task",
  title: "Test HTTP Task",
  input: httpTaskInput,
  requires: [],
  executor: {
    kind: "http",
    method: "POST",
    url: ({ input }) => `https://example.com/deploy/${input.project}`,
    headers: ({ env }) => ({
      authorization: `Bearer ${env["API_TOKEN"] ?? ""}`,
    }),
    body: ({ input }) => ({
      project: input.project,
    }),
  },
});

test("runHttpTask returns skipped results for dry runs", async () => {
  let called = false;
  globalThis.fetch = (async () => {
    called = true;
    return new Response("unexpected");
  }) as unknown as typeof fetch;

  const result = await runHttpTask(
    httpTask,
    {
      project: "site-a",
    },
    true,
  );

  expect(called).toBe(false);
  expect(result).toMatchObject({
    ok: true,
    status: "skipped",
    summary:
      "Dry run only. POST https://example.com/deploy/site-a was not sent.",
    data: {
      project: "site-a",
    },
  });
});

test("runHttpTask sends method, headers, and body for real execution", async () => {
  let requestInit: RequestInit | undefined;
  let requestUrl = "";

  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    requestUrl = String(input);
    requestInit = init;
    return new Response(JSON.stringify({ ok: true }), {
      status: 201,
      headers: {
        "content-type": "application/json",
      },
    });
  }) as unknown as typeof fetch;

  const result = await runHttpTask(
    httpTask,
    {
      project: "site-a",
    },
    false,
    {
      env: {
        API_TOKEN: "secret-token",
      },
    },
  );

  expect(requestUrl).toBe("https://example.com/deploy/site-a");
  expect(requestInit).toMatchObject({
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer secret-token",
    },
    body: JSON.stringify({
      project: "site-a",
    }),
  });
  expect(result).toMatchObject({
    ok: true,
    status: "succeeded",
    summary: "POST https://example.com/deploy/site-a returned 201.",
    stdout: '{"ok":true}',
  });
});

test("runHttpTask reports non-2xx responses as failed results", async () => {
  globalThis.fetch = (async () =>
    new Response("bad gateway", {
      status: 502,
    })) as unknown as typeof fetch;

  const result = await runHttpTask(
    httpTask,
    {
      project: "site-a",
    },
    false,
  );

  expect(result).toMatchObject({
    ok: false,
    status: "failed",
    summary: "POST https://example.com/deploy/site-a returned 502.",
    stdout: "bad gateway",
  });
});

test("runHttpTask reports timeout failures as retryable", async () => {
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) =>
    new Promise((_resolve, reject) => {
      void input;
      const signal = init?.signal;
      signal?.addEventListener("abort", () => {
        reject(signal.reason);
      });
    })) as unknown as typeof fetch;

  const timeoutTask = defineTask({
    id: httpTask.id,
    title: httpTask.title,
    input: httpTask.input,
    requires: httpTask.requires,
    executor: {
      kind: "http",
      method: "POST",
      timeoutMs: 5,
      url: ({ input }) => `https://example.com/deploy/${input.project}`,
      headers: ({ env }) => ({
        authorization: `Bearer ${env["API_TOKEN"] ?? ""}`,
      }),
      body: ({ input }) => ({
        project: input.project,
      }),
    },
  });

  const result = await runHttpTask(
    timeoutTask,
    {
      project: "site-a",
    },
    false,
  );

  expect(result).toMatchObject({
    ok: false,
    status: "failed",
    retryable: true,
    errorCode: "http_timeout",
    summary: "HTTP execution for test.http.task timed out after 5ms.",
  });
});
