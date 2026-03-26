import { ensureDir } from "../packages/bun-utils/src/index.ts";
import { renderDockerBakeHcl } from "../packages/preset-catalog/src/index.ts";
import { dirname, resolve } from "node:path";

const outputPath = resolve(process.cwd(), "docker/docker-bake.hcl");
const output = renderDockerBakeHcl();

await ensureDir(dirname(outputPath));
await Bun.write(outputPath, output);

console.log(`Generated ${outputPath}`);
