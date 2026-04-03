import {
  listActiveWorkerPresets,
  serverImageTag,
} from "../packages/preset-catalog/src/index.ts";

const registry = Bun.env["REGISTRY"];
const version = Bun.env["HOOKA_IMAGE_VERSION"];

if (!registry || !version) {
  throw new Error("REGISTRY and HOOKA_IMAGE_VERSION are required.");
}

const tags = [
  serverImageTag,
  ...listActiveWorkerPresets().map(
    (preset) => preset.publicWorkerTag ?? preset.imageTag,
  ),
];

for (const tag of tags) {
  const source = `${registry}:${tag}`;
  const target = `${registry}:${version}-${tag}`;
  await Bun.$`docker buildx imagetools create -t ${target} ${source}`.quiet();
  console.log(`Published immutable tag ${target}`);
}
