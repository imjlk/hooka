const uiPort = Number(Bun.env.HOOKA_UI_PORT ?? 4310);
const apiPort = Number(Bun.env.HOOKA_UI_SMOKE_API_PORT ?? 3000);
const apiOrigin = Bun.env.HOOKA_UI_API_ORIGIN ?? `http://127.0.0.1:${apiPort}`;

const apiServer = Bun.serve({
  port: apiPort,
  fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === "/api/health") {
      return Response.json({
        ok: true,
        service: "hooka-smoke-backend",
      });
    }

    return new Response("Not Found", {
      status: 404,
    });
  },
});

const child = Bun.spawn(
  [process.execPath, "--hot", "packages/admin-ui/src/dev.ts"],
  {
    cwd: process.cwd(),
    env: {
      ...Bun.env,
      HOOKA_UI_PORT: String(uiPort),
      HOOKA_UI_API_ORIGIN: apiOrigin,
    },
    stdout: "pipe",
    stderr: "pipe",
  },
);

const stdoutDrain = new Response(child.stdout).text();
const stderrDrain = new Response(child.stderr).text();

try {
  await waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${uiPort}/`).catch(
      () => null,
    );
    if (!response?.ok) {
      return false;
    }

    const body = await response.text();
    return body.includes("Hooka Control Plane");
  }, 20_000);

  await waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${uiPort}/api/health`).catch(
      () => null,
    );

    if (!response?.ok) {
      return false;
    }

    const body = (await response.json()) as {
      ok?: boolean;
      service?: string;
    };
    return body.ok === true && body.service === "hooka-smoke-backend";
  }, 20_000);

  console.log(
    JSON.stringify(
      {
        uiPort,
        apiOrigin,
        ok: true,
      },
      null,
      2,
    ),
  );
} finally {
  child.kill();
  await child.exited;
  apiServer.stop(true);
  await Promise.all([stdoutDrain, stderrDrain]);
}

async function waitFor(
  condition: () => Promise<boolean>,
  timeoutMs: number,
): Promise<void> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    if (await condition()) {
      return;
    }

    await Bun.sleep(200);
  }

  throw new Error(`Timed out after ${timeoutMs}ms.`);
}
