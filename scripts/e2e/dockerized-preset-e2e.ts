import { createHmac } from "node:crypto";
import {
  createTempDir,
  ensureDir,
  readTextFile,
  removeDir,
} from "@hooka/bun-utils";
import { getWorkerPresetBuildSpec } from "@hooka/preset-catalog";
import { join, resolve } from "node:path";

const repoRoot = process.cwd();
const imagePrefix = `hooka-e2e-${Date.now()}`;
const serverImageTag = `${imagePrefix}-server`;
const workerImageTag = `${imagePrefix}-cf-pages`;
const legacyWorkerImageTag = `${imagePrefix}-wrangler-worker`;
const mockBinDir = resolve(repoRoot, "docker/e2e/mock-bin");
const defaultPath =
  "/mock-bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
const $ = Bun.$.cwd(repoRoot);
const cfPagesSpec = getWorkerPresetBuildSpec("cf-pages");

if (!cfPagesSpec) {
  throw new Error("Missing active worker preset spec for cf-pages.");
}

await ensureDocker();
await buildImages();

try {
  await runScenario({
    name: "success-canonical",
    workerImage: workerImageTag,
    serverInstalledCapabilities: cfPagesSpec.installedCapabilities,
    wranglerExitCode: "0",
    expectedStatus: "succeeded",
    maxAttempts: "3",
    expectedStderr: null,
  });
  await runScenario({
    name: "failure-legacy-alias",
    workerImage: legacyWorkerImageTag,
    serverInstalledCapabilities: cfPagesSpec.installedCapabilities,
    wranglerExitCode: "17",
    expectedStatus: "dead-lettered",
    maxAttempts: "1",
    expectedStderr: "mock wrangler failed",
  });
} finally {
  await $`docker image rm -f ${serverImageTag}`.quiet().nothrow();
  await $`docker image rm -f ${workerImageTag}`.quiet().nothrow();
  await $`docker image rm -f ${legacyWorkerImageTag}`.quiet().nothrow();
}

console.log("Dockerized preset E2E passed.");

async function ensureDocker(): Promise<void> {
  await $`docker version`.quiet();
  await $`docker compose config`.quiet();
}

async function buildImages(): Promise<void> {
  await Promise.all([
    $`docker build -f docker/Dockerfile --target webhook-server -t ${serverImageTag} .`,
    $`docker build -f docker/Dockerfile --target worker-preset --build-arg HOOKA_FEATURES=${cfPagesSpec.features} --build-arg HOOKA_IMAGE_LABEL=${cfPagesSpec.imageLabel} --build-arg HOOKA_RUNTIME_ROLE=${cfPagesSpec.runtimeRole} --build-arg HOOKA_INSTALLED_CAPABILITIES=${cfPagesSpec.installedCapabilities} -t ${workerImageTag} .`,
  ]);
  await $`docker tag ${workerImageTag} ${legacyWorkerImageTag}`.quiet();
}

async function runScenario(input: {
  name: string;
  workerImage: string;
  serverInstalledCapabilities: string;
  wranglerExitCode: string;
  expectedStatus: "succeeded" | "dead-lettered";
  maxAttempts: string;
  expectedStderr: string | null;
}): Promise<void> {
  const tempDir = await createTempDir(`hooka-e2e-${input.name}`);
  const dataDir = join(tempDir, "data");
  const sharedSourceDir = join(tempDir, "shared-source");
  const exportDir = join(sharedSourceDir, "export");
  const serverName = `hooka-e2e-server-${input.name}-${Date.now()}`;
  const workerName = `hooka-e2e-worker-${input.name}-${Date.now()}`;
  const secret = "e2e-secret";
  const adminToken = "e2e-admin-token";

  await ensureDir(exportDir);
  await Bun.write(join(exportDir, "index.html"), "<html>ok</html>");
  await Bun.write(join(exportDir, "about.html"), "<html>about</html>");

  try {
    await $`docker run -d --rm --name ${serverName} -P -e HOOKA_DB_PATH=/data/hooka.sqlite -e HOOKA_WEBHOOK_SECRET=${secret} -e HOOKA_ADMIN_TOKEN=${adminToken} -e HOOKA_RUN_MAX_ATTEMPTS=${input.maxAttempts} -e HOOKA_INSTALLED_CAPABILITIES=${input.serverInstalledCapabilities} -e PATH=${defaultPath} -e HOOKA_TEST_WRANGLER_EXIT_CODE=${input.wranglerExitCode} -e HOOKA_TEST_WRANGLER_STDERR=${input.expectedStderr ?? ""} -v ${dataDir}:/data -v ${mockBinDir}:/mock-bin:ro ${serverImageTag}`.quiet();
    await $`docker run -d --rm --name ${workerName} -e HOOKA_DB_PATH=/data/hooka.sqlite -e HOOKA_WEBHOOK_SECRET=${secret} -e CLOUDFLARE_API_TOKEN=test-token -e CLOUDFLARE_ACCOUNT_ID=test-account -e PATH=${defaultPath} -e HOOKA_TEST_WRANGLER_EXIT_CODE=${input.wranglerExitCode} -e HOOKA_TEST_WRANGLER_STDERR=${input.expectedStderr ?? ""} -v ${dataDir}:/data -v ${sharedSourceDir}:/shared-source -v ${mockBinDir}:/mock-bin:ro ${input.workerImage}`.quiet();
    const serverPort = await resolvePublishedPort(serverName);

    await waitForHealth(serverPort);
    const runId = await enqueueGenericWebhook(serverPort, secret);
    const run = await waitForRunStatus(
      serverPort,
      runId,
      input.expectedStatus,
      adminToken,
    );

    if (run.status !== input.expectedStatus) {
      throw new Error(
        `${input.name}: expected ${input.expectedStatus}, received ${run.status}`,
      );
    }

    if (input.expectedStderr) {
      if ((run.result?.stderr ?? "").trim() !== input.expectedStderr) {
        throw new Error(
          `${input.name}: expected stderr "${input.expectedStderr}", received "${run.result?.stderr ?? ""}"`,
        );
      }
    }

    const wranglerLog = await readTextFile(join(dataDir, "mock-wrangler.log"));

    if (!wranglerLog.includes("pages deploy /shared-source/export")) {
      throw new Error(
        `${input.name}: mock wrangler was not called with pages deploy.`,
      );
    }
  } finally {
    await $`docker logs ${serverName}`.quiet().nothrow();
    await $`docker logs ${workerName}`.quiet().nothrow();
    await $`docker rm -f ${serverName}`.quiet().nothrow();
    await $`docker rm -f ${workerName}`.quiet().nothrow();
    await removeDir(tempDir);
  }
}

async function resolvePublishedPort(containerName: string): Promise<number> {
  const response = await $`docker port ${containerName} 3000/tcp`.text();
  const line = response
    .split("\n")
    .map((value) => value.trim())
    .find((value) => value.length > 0 && !value.startsWith(":::"));

  if (!line) {
    throw new Error(
      `Could not resolve a published host port for ${containerName}.`,
    );
  }

  const portText = line.split(":").at(-1);
  const port = Number(portText);

  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`Invalid published port "${line}" for ${containerName}.`);
  }

  return port;
}

async function waitForHealth(port: number): Promise<void> {
  await waitFor(async () => {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      return response.ok;
    } catch {
      return false;
    }
  }, 30_000);
}

async function enqueueGenericWebhook(
  port: number,
  secret: string,
): Promise<string> {
  const payload = JSON.stringify({
    taskId: "deploy.shared-volume.wrangler",
    input: {
      kind: "pages-deploy",
      project: "staging-site",
      sourcePath: "/shared-source/export",
      branch: "main",
    },
    eventId: `evt_${Date.now()}`,
    source: "webhook",
  });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHmac("sha256", secret)
    .update(`${timestamp}.${payload}`)
    .digest("hex");
  const response = await fetch(`http://127.0.0.1:${port}/api/webhooks/task`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-hooka-timestamp": timestamp,
      "x-hooka-signature": `sha256=${signature}`,
    },
    body: payload,
  });

  if (!response.ok) {
    throw new Error(
      `Failed to enqueue webhook: ${response.status} ${await response.text()}`,
    );
  }

  const body = (await response.json()) as { runId: string };
  return body.runId;
}

async function waitForRunStatus(
  port: number,
  runId: string,
  expectedStatus: "succeeded" | "dead-lettered",
  adminToken: string,
): Promise<{
  status: string;
  result: {
    stderr?: string;
  } | null;
}> {
  let lastRun: {
    status: string;
    result: {
      stderr?: string;
    } | null;
  } | null = null;

  await waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${port}/api/runs/${runId}`, {
      headers: {
        authorization: `Bearer ${adminToken}`,
      },
    });

    if (!response.ok) {
      return false;
    }

    lastRun = await response.json();
    return lastRun?.status === expectedStatus;
  }, 30_000);

  if (!lastRun) {
    throw new Error(`Run ${runId} was not found.`);
  }

  return lastRun;
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

    await Bun.sleep(500);
  }

  throw new Error(`Timed out after ${timeoutMs}ms.`);
}
