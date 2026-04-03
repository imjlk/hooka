import { expect, test } from "bun:test";
import { createTempDir } from "@hooka/bun-utils";
import {
  createDevCommandSpecs,
  runDevSession,
  validateDevSetup,
  type DevCommandSpec,
  type SpawnedDevProcess,
} from "./dev";

test("createDevCommandSpecs includes ui by default and can omit it", () => {
  expect(
    createDevCommandSpecs({
      noUi: false,
    }).map((spec) => spec.name),
  ).toEqual(["server", "worker", "ui"]);

  expect(
    createDevCommandSpecs({
      noUi: true,
    }).map((spec) => spec.name),
  ).toEqual(["server", "worker"]);
});

test("validateDevSetup reports missing secret, manifest, and worker env", async () => {
  const tempDir = await createTempDir("hooka-dev-validate");

  const issues = await validateDevSetup({
    cwd: tempDir,
    env: {
      HOOKA_INSTALLED_CAPABILITIES: "wrangler",
      HOOKA_WEBHOOK_SECRET: "",
      CLOUDFLARE_API_TOKEN: "",
      CLOUDFLARE_ACCOUNT_ID: "",
    },
  });

  expect(issues).toEqual(
    expect.arrayContaining([
      "HOOKA_WEBHOOK_SECRET is required.",
      expect.stringContaining("Manifest not found"),
      expect.stringContaining("Worker runtime env missing: wrangler:allOf"),
    ]),
  );
});

test("runDevSession prefixes output and stops sibling processes after a failure", async () => {
  const output: string[] = [];
  let workerKilled = false;

  const exitCode = await runDevSession({
    repoRoot: "/repo",
    specs: [
      {
        name: "server",
        argv: ["bun", "run", "dev:server"],
      },
      {
        name: "worker",
        argv: ["bun", "run", "dev:worker"],
      },
    ] satisfies DevCommandSpec[],
    spawnProcess(spec) {
      if (spec.name === "server") {
        return createFakeProcess({
          stdout: "server ready\n",
          exitCode: 1,
        });
      }

      return createDeferredFakeProcess({
        stdout: "worker ready\n",
        onKill() {
          workerKilled = true;
        },
      });
    },
    stdout(line) {
      output.push(line);
    },
    stderr(line) {
      output.push(line);
    },
  });

  expect(exitCode).toBe(1);
  expect(output).toEqual(
    expect.arrayContaining(["[server] server ready", "[worker] worker ready"]),
  );
  expect(workerKilled).toBe(true);
});

function createFakeProcess(input: {
  stdout?: string;
  stderr?: string;
  exitCode: number;
}): SpawnedDevProcess {
  return {
    stdout: input.stdout ? streamFromText(input.stdout) : null,
    stderr: input.stderr ? streamFromText(input.stderr) : null,
    exited: Promise.resolve(input.exitCode),
    kill() {},
  };
}

function createDeferredFakeProcess(input: {
  stdout?: string;
  stderr?: string;
  onKill?: () => void;
}): SpawnedDevProcess {
  let resolveExit = (_code: number) => {};
  const exited = new Promise<number>((resolve) => {
    resolveExit = resolve;
  });

  return {
    stdout: input.stdout ? streamFromText(input.stdout) : null,
    stderr: input.stderr ? streamFromText(input.stderr) : null,
    exited,
    kill() {
      input.onKill?.();
      resolveExit(0);
    },
  };
}

function streamFromText(value: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(value));
      controller.close();
    },
  });
}
