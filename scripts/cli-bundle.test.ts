import { expect, test } from "bun:test";

// Exercise the package build command and preset discovery in the shipped CLI.
test("built CLI discovers the sharelink preset without native terminal dependencies", async () => {
  const build = Bun.spawn(
    [process.execPath, "run", "--cwd", "apps/cli", "build"],
    { stdout: "pipe", stderr: "pipe" },
  );
  const buildOutput = await Promise.all([
    new Response(build.stdout).text(),
    new Response(build.stderr).text(),
    build.exited,
  ]);
  expect(buildOutput[2], String(buildOutput[1])).toBe(0);
  const cli = Bun.spawn(
    [
      process.execPath,
      "run",
      "apps/cli/dist/index.js",
      "image",
      "plan",
      "--preset",
      "toss-sharelink",
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(cli.stdout).text(),
    new Response(cli.stderr).text(),
    cli.exited,
  ]);
  expect(exitCode, stderr).toBe(0);
  expect(JSON.parse(stdout)).toMatchObject({
    presetId: "toss-sharelink",
    missingCapabilitiesByTask: {},
    coveredTasks: [
      "toss-sharelink.refresh",
      "toss-sharelink.export",
      "toss-sharelink.subtag.ensure",
      "toss-sharelink.performance.sync",
      "toss-sharelink.settlement.sync",
    ],
  });
});
