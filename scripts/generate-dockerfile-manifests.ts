import { resolve } from "node:path";

const dockerfilePath = resolve(process.cwd(), "docker/Dockerfile");
const packageJsonPath = resolve(process.cwd(), "package.json");
const startMarker = "# BEGIN WORKSPACE MANIFESTS";
const endMarker = "# END WORKSPACE MANIFESTS";
const baseImagePattern = /^FROM oven\/bun:\S+ AS install$/m;

// package.json `packageManager` is the single source of truth for the Bun
// version: CI reads it through setup-bun, and the Docker base image follows it.
const packageJson = (await Bun.file(packageJsonPath).json()) as {
  packageManager?: unknown;
};
const bunVersion =
  typeof packageJson.packageManager === "string"
    ? /^bun@(\d+\.\d+\.\d+)$/.exec(packageJson.packageManager)?.[1]
    : undefined;

if (!bunVersion) {
  throw new Error(
    'package.json must pin "packageManager" to an exact "bun@X.Y.Z" version.',
  );
}

const manifestGlobs = ["apps/*/package.json", "packages/*/package.json"];
const manifestPaths = (
  await Promise.all(
    manifestGlobs.map(async (pattern) => {
      const glob = new Bun.Glob(pattern);
      return Array.fromAsync(glob.scan({ cwd: process.cwd() }));
    }),
  )
).flat();

const block = manifestPaths
  .sort()
  .map((relativePath) => `COPY ${relativePath} ${relativePath}`)
  .join("\n");

const current = await Bun.file(dockerfilePath).text();
const startIndex = current.indexOf(startMarker);
const endIndex = current.indexOf(endMarker);

if (startIndex < 0 || endIndex < 0 || endIndex <= startIndex) {
  throw new Error(
    "Workspace manifest markers are missing from docker/Dockerfile.",
  );
}

if (!baseImagePattern.test(current)) {
  throw new Error(
    "The oven/bun install stage is missing from docker/Dockerfile.",
  );
}

const before = current.slice(0, startIndex + startMarker.length);
const after = current.slice(endIndex);
const next = `${before}\n${block}\n${after}`.replace(
  baseImagePattern,
  `FROM oven/bun:${bunVersion}-alpine AS install`,
);

await Bun.write(dockerfilePath, next);
console.log(`Generated ${dockerfilePath}`);
