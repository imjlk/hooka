import { expect, test } from "bun:test";
import { createHmac } from "node:crypto";

const bunBinary = process.execPath;
const cwd = process.cwd();

test("webhook test sends a signed generic task payload", async () => {
  let resolveRequest:
    | ((value: { headers: Headers; body: string }) => void)
    | null = null;
  const receivedRequest = new Promise<{ headers: Headers; body: string }>(
    (resolve) => {
      resolveRequest = resolve;
    },
  );

  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const body = await request.text();
      resolveRequest?.({
        headers: request.headers,
        body,
      });

      return new Response(JSON.stringify({ ok: true }), {
        headers: {
          "content-type": "application/json",
        },
      });
    },
  });

  try {
    const result = await runCli(
      [
        "webhook",
        "test",
        "--url",
        `http://127.0.0.1:${server.port}/api/webhooks/task`,
        "--task-id",
        "deploy.shared-volume.wrangler",
        "--payload-json",
        '{"kind":"pages-deploy","project":"staging-site","sourcePath":"/shared-source/site"}',
        "--event-id",
        "evt_cli",
        "--timestamp",
        "1774483200",
      ],
      {
        HOOKA_WEBHOOK_SECRET: "secret",
      },
    );

    const request = await receivedRequest;
    const payload = JSON.parse(request.body) as {
      taskId: string;
      input: { sourcePath: string };
      eventId: string;
      source: string;
    };
    const output = JSON.parse(result.stdout) as {
      status: number;
      body: { ok: boolean };
    };

    expect(result.exitCode).toBe(0);
    expect(output).toEqual({
      status: 200,
      body: {
        ok: true,
      },
    });
    expect(payload).toMatchObject({
      taskId: "deploy.shared-volume.wrangler",
      eventId: "evt_cli",
      source: "cli.webhook-test",
      input: {
        sourcePath: "/shared-source/site",
      },
    });
    expect(request.headers.get("x-hooka-timestamp")).toBe("1774483200");
    expect(request.headers.get("x-hooka-signature")).toMatch(/^sha256=/);
  } finally {
    server.stop(true);
  }
});

test("webhook send signs and sends a raw JSON body", async () => {
  let resolveRequest:
    | ((value: { headers: Headers; body: string }) => void)
    | null = null;
  const receivedRequest = new Promise<{ headers: Headers; body: string }>(
    (resolve) => {
      resolveRequest = resolve;
    },
  );

  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const body = await request.text();
      resolveRequest?.({
        headers: request.headers,
        body,
      });

      return new Response(JSON.stringify({ accepted: true }), {
        headers: {
          "content-type": "application/json",
        },
      });
    },
  });

  try {
    const rawBody =
      '{"eventId":"evt_raw","project":"main-site","exportDir":"/shared-source/site"}';
    const result = await runCli(
      [
        "webhook",
        "send",
        "--url",
        `http://127.0.0.1:${server.port}/api/webhooks/wordpress/simply-static`,
        "--body-json",
        rawBody,
        "--timestamp",
        "1774483200",
      ],
      {
        HOOKA_WEBHOOK_SECRET: "secret",
      },
    );

    const request = await receivedRequest;
    const output = JSON.parse(result.stdout) as {
      status: number;
      body: { accepted: boolean };
    };
    const signature = createHmac("sha256", "secret")
      .update(`1774483200.${rawBody}`)
      .digest("hex");

    expect(result.exitCode).toBe(0);
    expect(output).toEqual({
      status: 200,
      body: {
        accepted: true,
      },
    });
    expect(request.body).toBe(rawBody);
    expect(request.headers.get("x-hooka-timestamp")).toBe("1774483200");
    expect(request.headers.get("x-hooka-signature")).toBe(
      `sha256=${signature}`,
    );
  } finally {
    server.stop(true);
  }
});

async function runCli(
  args: string[],
  envOverrides: Record<string, string | undefined> = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const processResult = Bun.spawn(
    [bunBinary, "run", "apps/cli/src/index.ts", ...args],
    {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...Bun.env,
        ...envOverrides,
      },
    },
  );
  const [exitCode, stdout, stderr] = await Promise.all([
    processResult.exited,
    new Response(processResult.stdout).text(),
    new Response(processResult.stderr).text(),
  ]);

  return {
    exitCode,
    stdout,
    stderr,
  };
}
