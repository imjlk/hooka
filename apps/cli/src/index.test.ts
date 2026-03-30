import { expect, test } from "bun:test";
import { createTempDir, ensureParentDir } from "@hooka/bun-utils";
import { join } from "node:path";

const bunBinary = process.execPath;
const cwd = process.cwd();

test("image plan exposes the active cf-pages preset contract", async () => {
  const result = await runCli(["image", "plan", "--preset", "cf-pages"]);

  expect(result.exitCode).toBe(0);
  const plan = JSON.parse(result.stdout) as {
    presetId: string;
    tier?: string;
    publicWorkerTag?: string;
    capabilities: string[];
    requiredEnv: Array<{ capabilityId: string; match: string }>;
  };

  expect(plan.presetId).toBe("cf-pages");
  expect(plan.tier).toBe("lean");
  expect(plan.publicWorkerTag).toBe("cf-pages");
  expect(plan.capabilities).toEqual(["wrangler"]);
  expect(plan.requiredEnv).toEqual([
    expect.objectContaining({
      capabilityId: "wrangler",
      match: "allOf",
    }),
  ]);
});

test("image plan exposes the active cf-cache preset contract", async () => {
  const result = await runCli(["image", "plan", "--preset", "cf-cache"]);

  expect(result.exitCode).toBe(0);
  const plan = JSON.parse(result.stdout) as {
    presetId: string;
    tier?: string;
    publicWorkerTag?: string;
    capabilities: string[];
    requiredEnv: Array<{ capabilityId: string; match: string }>;
  };

  expect(plan.presetId).toBe("cf-cache");
  expect(plan.tier).toBe("lean");
  expect(plan.publicWorkerTag).toBe("cf-cache");
  expect(plan.capabilities).toEqual(["cloudflare-api"]);
  expect(plan.requiredEnv).toEqual([
    expect.objectContaining({
      capabilityId: "cloudflare-api",
      match: "allOf",
    }),
  ]);
});

test("doctor reports missing env for installed wrangler capability", async () => {
  const result = await runCli(["doctor"], {
    HOOKA_INSTALLED_CAPABILITIES: "wrangler",
    CLOUDFLARE_API_TOKEN: "",
    CLOUDFLARE_ACCOUNT_ID: "",
  });

  expect(result.exitCode).toBe(0);

  const report = JSON.parse(result.stdout) as {
    installed: string[];
    missingEnv: Array<{
      capabilityId: string;
      match: string;
      missingNames: string[];
    }>;
  };

  expect(report.installed).toEqual(["wrangler"]);
  expect(report.missingEnv).toEqual([
    expect.objectContaining({
      capabilityId: "wrangler",
      match: "allOf",
      missingNames: ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"],
    }),
  ]);
});

test("install-features records env-only capabilities without a docker installer", async () => {
  const result = await runCli([
    "image",
    "install-features",
    "--features",
    "cloudflare-api",
    "--dry-run",
  ]);

  expect(result.exitCode).toBe(0);

  const manifest = JSON.parse(result.stdout) as {
    installed: string[];
  };

  expect(manifest.installed).toEqual(["cloudflare-api"]);
});

test("doctor honors HOOKA_MANIFEST_PATH for the default manifest lookup", async () => {
  const tempDir = await createTempDir("hooka-cli-manifest");
  const manifestPath = join(tempDir, "custom", "installed-capabilities.json");

  await ensureParentDir(manifestPath);
  await Bun.write(
    manifestPath,
    JSON.stringify({
      image: "hooka:test",
      generatedAt: "2026-03-29T00:00:00.000Z",
      installed: ["cloudflare-api"],
    }),
  );

  const result = await runCli(["doctor"], {
    HOOKA_MANIFEST_PATH: manifestPath,
    HOOKA_INSTALLED_CAPABILITIES: undefined,
    CLOUDFLARE_API_TOKEN: "",
    CLOUDFLARE_ACCOUNT_ID: "",
  });

  expect(result.exitCode).toBe(0);

  const report = JSON.parse(result.stdout) as {
    installed: string[];
    missingEnv: Array<{ capabilityId: string }>;
  };

  expect(report.installed).toEqual(["cloudflare-api"]);
  expect(report.missingEnv).toEqual([
    expect.objectContaining({
      capabilityId: "cloudflare-api",
    }),
  ]);
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
