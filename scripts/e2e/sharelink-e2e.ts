import { createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { selectSharelinkOffer } from "../../packages/pack-toss-sharelink/src/consumer";

const project = `hooka-sharelink-e2e-${Date.now()}`;
const image = `${project}:worker`;
const directory = await mkdtemp(join(tmpdir(), project));
const composePath = join(directory, "compose.json");
const fixturePath = resolve("scripts/e2e/sharelink");
const secret = "e2e-webhook-secret";
const token = "e2e-admin-token";
const $ = Bun.$;
const publisherId = "00000000-0000-4000-8000-000000000001";
const account = {
  accountId: "partner",
  publisherId,
  accessKeyEnv: "E2E_ACCESS",
  secretKeyEnv: "E2E_SECRET",
};
const app = (id: string, revision = 1, categoryId = "10") => ({
  appId: id,
  accountId: "partner",
  revision,
  subTagId: id,
  subjects: [{ subjectId: "pillow", revision, categoryId, keywords: ["베개"] }],
});
async function config(id: string, revision = 1, categoryId = "10") {
  await Bun.write(
    join(directory, `${id}.json`),
    JSON.stringify({
      schemaVersion: 1,
      accounts: [account],
      apps: [app(id, revision, categoryId)],
    }),
  );
}
const base = { image, networks: ["isolated"] };
const services: Record<string, unknown> = {
  mock: {
    ...base,
    networks: ["isolated", "ingress"],
    command: ["bun", "/test/mock.ts"],
    volumes: [`${fixturePath}:/test:ro`],
    ports: ["127.0.0.1::8080"],
  },
  reader: {
    ...base,
    command: ["bun", "-e", "setInterval(() => {}, 60000)"],
    volumes: ["results:/snapshots:ro", `${fixturePath}:/test:ro`],
  },
};
for (const id of ["a", "b"]) {
  await config(id);
  const environment = {
    HOOKA_DB_PATH: "/queue/hooka.sqlite",
    HOOKA_ADMIN_TOKEN: token,
    HOOKA_WEBHOOK_SECRET: secret,
    HOOKA_INSTALLED_CAPABILITIES: "toss-sharelink",
    HOOKA_RUN_MAX_ATTEMPTS: "8",
    HOOKA_RETRY_BASE_DELAY_MS: "10000",
    HOOKA_POLL_INTERVAL_MS: "100",
    HOOKA_RUN_LEASE_MS: "5000",
    HOOKA_WORKER_HEARTBEAT_MS: "1000",
    HOOKA_SHARELINK_CONFIG_PATH: `/config/${id}.json`,
    HOOKA_SHARELINK_DB_PATH: "/private/sharelink.sqlite",
    HOOKA_SHARELINK_RESULTS_PATH: "/results",
    E2E_ACCESS: "e2e-access",
    E2E_SECRET: "e2e-secret",
  };
  services[`server-${id}`] = {
    ...base,
    networks: ["isolated", "ingress"],
    command: ["bun", "apps/server/dist/index.js"],
    environment,
    volumes: [`queue-${id}:/queue`],
    ports: ["127.0.0.1::3000"],
  };
  services[`worker-${id}`] = {
    ...base,
    command: [
      "bun",
      "--preload",
      "/test/preload.ts",
      "apps/worker/dist/index.js",
    ],
    environment,
    volumes: [
      `queue-${id}:/queue`,
      "private:/private",
      "results:/results",
      `${directory}:/config:ro`,
      `${fixturePath}:/test:ro`,
    ],
  };
}
await Bun.write(
  composePath,
  JSON.stringify({
    services,
    networks: {
      ingress: {
        ...(Bun.env["HOOKA_SHARELINK_E2E_INGRESS_SUBNET"]
          ? {
              ipam: {
                config: [
                  { subnet: Bun.env["HOOKA_SHARELINK_E2E_INGRESS_SUBNET"] },
                ],
              },
            }
          : {}),
      },
      isolated: {
        internal: true,
        ...(Bun.env["HOOKA_SHARELINK_E2E_SUBNET"]
          ? {
              ipam: {
                config: [{ subnet: Bun.env["HOOKA_SHARELINK_E2E_SUBNET"] }],
              },
            }
          : {}),
      },
    },
    volumes: { "queue-a": {}, "queue-b": {}, private: {}, results: {} },
  }),
);
async function compose(...args: string[]) {
  return $`docker compose -p ${project} -f ${composePath} ${args}`.quiet();
}
async function port(service: string, number: number) {
  return (await compose("port", service, String(number))).stdout
    .toString()
    .trim()
    .split(":")
    .at(-1);
}
async function waitFor<T>(
  read: () => Promise<T>,
  ready: (value: T) => boolean,
  timeout = 30000,
): Promise<T> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const value = await read();
      if (ready(value)) return value;
    } catch {
      /* services may still be starting */
    }
    await Bun.sleep(200);
  }
  throw new Error("Sharelink E2E condition timed out.");
}
const urls: Record<string, string> = {};
async function enqueue(id: string, eventId: string) {
  const payload = JSON.stringify({
    taskId: "toss-sharelink.refresh",
    input: { schemaVersion: 1, appId: id },
    eventId,
    source: "e2e",
  });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHmac("sha256", secret)
    .update(`${timestamp}.${payload}`)
    .digest("hex");
  const response = await fetch(`${urls[id]}/api/webhooks/task`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-hooka-timestamp": timestamp,
      "x-hooka-signature": `sha256=${signature}`,
    },
    body: payload,
  });
  if (!response.ok) throw new Error(`Webhook failed: ${response.status}`);
  return ((await response.json()) as { runId: string }).runId;
}
async function run(id: string, runId: string) {
  return (await (
    await fetch(`${urls[id]}/api/runs/${runId}`, {
      headers: { authorization: `Bearer ${token}` },
    })
  ).json()) as {
    status: string;
    lastErrorCode?: string;
    result?: { errorCode?: string };
  };
}
async function snapshot(id: string) {
  return JSON.parse(
    (
      await compose("exec", "-T", "reader", "bun", "/test/reader.ts", id)
    ).stdout.toString(),
  );
}
function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
try {
  await $`docker build -f docker/Dockerfile --target worker-preset --build-arg HOOKA_FEATURES=toss-sharelink --build-arg HOOKA_RUNTIME_ROLE=worker:toss-sharelink --build-arg HOOKA_INSTALLED_CAPABILITIES=toss-sharelink -t ${image} .`.quiet();
  await compose("up", "-d");
  console.log("Containers started; waiting for health.");
  for (const id of ["a", "b"]) {
    urls[id] = `http://127.0.0.1:${await port(`server-${id}`, 3000)}`;
    await waitFor(
      () => fetch(`${urls[id]}/api/health`),
      (response) => response.ok,
    );
  }
  console.log("Servers healthy.");
  const mockUrl = `http://127.0.0.1:${await port("mock", 8080)}`;
  const state = async () =>
    (await (await fetch(`${mockUrl}/_state`)).json()) as {
      calls: Record<string, number>;
      maxActive: number;
      held: boolean;
    };
  const control = async (body: unknown) => {
    const response = await fetch(`${mockUrl}/_control`, {
      method: "POST",
      body: JSON.stringify(body),
    });
    assert(response.ok, "Mock control failed");
  };
  await waitFor(state, () => true);
  const [a, b] = await Promise.all([
    enqueue("a", "initial-a"),
    enqueue("b", "initial-b"),
  ]);
  assert(
    (await enqueue("a", "initial-a")) === a,
    "Webhook deduplication failed",
  );
  await Promise.all([
    waitFor(
      () => run("a", a),
      (value) => value.status === "succeeded",
      90000,
    ),
    waitFor(
      () => run("b", b),
      (value) => value.status === "succeeded",
      90000,
    ),
  ]);
  for (const id of ["a", "b"]) {
    const offer = selectSharelinkOffer(await snapshot(id), {
      appId: id,
      appRevision: 1,
      subjectId: "pillow",
      ruleRevision: 1,
    });
    assert(offer?.url.includes(`e2e-${id}-`), "App-scoped offer missing");
    assert(offer, "Missing offer");
    assert(
      selectSharelinkOffer(
        await snapshot(id),
        { appId: id, appRevision: 1, subjectId: "pillow", ruleRevision: 1 },
        offer.expiresAt,
      ) === null,
      "Consumer accepted an expired offer",
    );
  }
  const shared = await state();
  assert(
    shared.calls["/oauth2.cert.toss.im/token"] === 1,
    "Shared OAuth cache was not reused",
  );
  assert(
    shared.calls["/sharelink.toss.im/openapi/products/detail"] === 1,
    "Shared detail cache was not reused",
  );
  assert(shared.maxActive === 1, "Account calls overlapped");
  console.log(
    "PASS: signed webhooks, separate queues, shared caches, account serialization and app-scoped snapshots",
  );

  // Force a process crash while holding the real account lease, then wait for
  // actual lease expiry/retry. Neither private DB nor clocks are edited.
  await config("a", 2, "20");
  await control({ holdDetails: true });
  const recovery = await enqueue("a", "crash-a");
  await waitFor(state, (value) => value.held);
  await compose("kill", "-s", "SIGKILL", "worker-a");
  await control({ holdDetails: false });
  await compose("start", "worker-a");
  await waitFor(
    () => run("a", recovery),
    (value) => value.status === "succeeded",
    150000,
  );
  assert(
    selectSharelinkOffer(await snapshot("a"), {
      appId: "a",
      appRevision: 2,
      subjectId: "pillow",
      ruleRevision: 2,
    }),
    "Crash recovery did not publish current offers",
  );
  console.log(
    "PASS: SIGKILL, persisted queue, real lease expiry and worker recovery",
  );

  // Fresh category forces a provider call while preserving the account cache.
  await config("b", 2, "30");
  await control({ quota: true });
  const limited = await enqueue("b", "quota-b");
  const failed = await waitFor(
    () => run("b", limited),
    (value) => ["failed", "dead-lettered"].includes(value.status),
  );
  assert(
    failed.result?.errorCode === "sharelink_provider_daily_budget",
    "Quota classification lost",
  );
  const tick = JSON.parse(
    (
      await compose(
        "exec",
        "-T",
        "worker-b",
        "bun",
        "apps/cli/dist/index.js",
        "sharelink",
        "tick",
        "--dry-run",
      )
    ).stdout.toString(),
  );
  assert(
    tick.skipped[0]?.reason === "account-cooldown" &&
      tick.jobs.every(
        (job: { taskId: string }) => job.taskId === "toss-sharelink.export",
      ),
    "Scheduler did not pause automatic requests",
  );
  const deniedWrite =
    await $`docker compose -p ${project} -f ${composePath} exec -T reader bun -e ${'await Bun.write("/snapshots/forbidden.txt", "no")'}`
      .quiet()
      .nothrow();
  assert(deniedWrite.exitCode !== 0, "Consumer mount is writable");
  console.log(
    "PASS: quota pause, consumer expiry contract and read-only snapshot volume",
  );
} catch (error) {
  const logs =
    await $`docker compose -p ${project} -f ${composePath} logs --tail 40`
      .quiet()
      .nothrow();
  console.error(logs.stdout.toString());
  throw error;
} finally {
  await $`docker compose -p ${project} -f ${composePath} down --volumes --remove-orphans`
    .quiet()
    .nothrow();
  await $`docker image rm ${image}`.quiet().nothrow();
  await rm(directory, { recursive: true, force: true });
}
