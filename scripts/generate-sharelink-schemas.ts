import { mkdir } from "node:fs/promises";
import { z } from "zod";
import {
  configSchema,
  exportInput,
  refreshInput,
  snapshotSchema,
  performanceInput,
  settlementInput,
  reportSchema,
} from "../packages/pack-toss-sharelink/src/contracts";
import { worksetSchema } from "../packages/pack-toss-sharelink/src/operations";
import { recommendationBindingsSchema } from "../packages/pack-toss-sharelink/src/recommendations";
import { refreshDemandSchema } from "../packages/pack-toss-sharelink/src/refresh-priority";

const directory = new URL(
  "../docs/contracts/toss-sharelink/v1/",
  import.meta.url,
);
await mkdir(directory, { recursive: true });
for (const [name, schema] of Object.entries({
  config: configSchema,
  refresh: refreshInput,
  export: exportInput,
  snapshot: snapshotSchema,
  performance: performanceInput,
  settlement: settlementInput,
  report: reportSchema,
  workset: worksetSchema,
})) {
  // Zod refinements (cross-field invariants, exact issued-link checks) remain runtime rules.
  const document = z.toJSONSchema(schema, {
    target: "draft-2020-12",
    io: ["snapshot", "report"].includes(name) ? "output" : "input",
  });
  await Bun.write(
    new URL(`${name}.schema.json`, directory),
    `${JSON.stringify(document, null, 2)}\n`,
  );
}

// Extensions get their own namespace; existing Sharelink v1 schemas remain byte-compatible.
const extensions = new URL(
  "../docs/contracts/toss-sharelink/extensions/v1/",
  import.meta.url,
);
await mkdir(extensions, { recursive: true });
for (const [name, schema] of Object.entries({
  "recommendation-bindings": recommendationBindingsSchema,
  "refresh-demand": refreshDemandSchema,
})) {
  await Bun.write(
    new URL(`${name}.schema.json`, extensions),
    `${JSON.stringify(z.toJSONSchema(schema, { target: "draft-2020-12", io: "input" }), null, 2)}\n`,
  );
}
