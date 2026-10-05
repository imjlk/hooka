import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
const entry = resolve(import.meta.dir, "../index.ts");
async function cli(args: string[], cwd: string) {
  const child = Bun.spawn(
    [process.execPath, entry, "recommendations", ...args],
    { cwd, stdout: "pipe", stderr: "pipe" },
  );
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, stdout, stderr };
}
test("CLI requires explicit initialization and keeps preview/status read-only", async () => {
  const root = mkdtempSync(join(tmpdir(), "hooka-recommendation-cli-"));
  try {
    const domain = join(root, "private.sqlite"),
      config = join(root, "config.json"),
      artifact = join(root, "request.json");
    const now = Date.now();
    await Bun.write(
      config,
      JSON.stringify({
        schemaVersion: 1,
        policies: [{ policyId: "ctr", version: 1 }],
        entities: [],
        apps: [
          {
            appId: "cats",
            appRevision: 1,
            producerId: "backend",
            contexts: [{ contextId: "low", measurementProfileId: "visible" }],
            subjects: [{ subjectId: "mug", ruleRevision: 1 }],
          },
        ],
      }),
    );
    await Bun.write(
      artifact,
      JSON.stringify({
        schemaVersion: 1,
        requestId: "today",
        appId: "cats",
        appRevision: 1,
        policyId: "ctr",
        policyVersion: 1,
        contextId: "low",
        measurementProfileId: "visible",
        kind: "subject",
        generatedAt: now,
        expiresAt: now + 60000,
        seed: "fixture",
        candidates: [{ subjectId: "mug", ruleRevision: 1 }],
      }),
    );
    expect((await cli(["status", "--domain", domain], root)).code).toBe(1);
    expect(await Bun.file(domain).exists()).toBe(false);
    expect((await cli(["validate", "--config", config], root)).code).toBe(0);
    expect(await Bun.file(domain).exists()).toBe(false);
    expect((await cli(["init", "--domain", domain], root)).code).toBe(0);
    expect(
      (await cli(["build", "--domain", domain, "--config", config], root)).code,
    ).toBe(0);
    const before = await cli(["status", "--domain", domain], root);
    const plan = await cli(
      ["plan", "--domain", domain, "--config", config, "--artifact", artifact],
      root,
    );
    expect(plan.code, plan.stderr).toBe(0);
    expect(JSON.parse(plan.stdout).entries[0].weight).toBe(1);
    expect((await cli(["status", "--domain", domain], root)).stdout).toBe(
      before.stdout,
    );
    const out = join(root, "out");
    const exported = await cli(
      [
        "export",
        "--domain",
        domain,
        "--config",
        config,
        "--artifact",
        artifact,
        "--results",
        out,
      ],
      root,
    );
    expect(exported.code, exported.stderr).toBe(0);
    expect(JSON.parse(exported.stdout).appId).toBe("cats");
    expect(
      await Bun.file(
        join(out, "cats", "requests", "today", "recommendations.json"),
      ).exists(),
    ).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
