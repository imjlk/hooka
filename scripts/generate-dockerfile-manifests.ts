import { resolve } from "node:path";

const dockerfilePath = resolve(process.cwd(), "docker/Dockerfile");
const startMarker = "# BEGIN WORKSPACE MANIFESTS";
const endMarker = "# END WORKSPACE MANIFESTS";

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

const before = current.slice(0, startIndex + startMarker.length);
const after = current.slice(endIndex);
const next = `${before}\n${block}\n${after}`;

await Bun.write(dockerfilePath, next);
console.log(`Generated ${dockerfilePath}`);
