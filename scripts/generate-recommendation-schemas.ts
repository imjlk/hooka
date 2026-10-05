import { mkdir } from "node:fs/promises";
import { z } from "zod";
import {
  configSchema,
  requestSchema,
  modelSchema,
  resultSchema,
  policySchema,
} from "../packages/pack-recommendations/src/contracts";
import {
  manifestSchema,
  aggregateSchema,
  pointerSchema,
} from "../packages/pack-recommendations/src/measurement";
import {
  registrationTaskInput,
  ingestTaskInput,
  decisionTaskInput,
  maintenanceTaskInput,
} from "../packages/pack-recommendations/src/tasks";

const directory = new URL(
  "../docs/contracts/recommendations/v1/",
  import.meta.url,
);
await mkdir(directory, { recursive: true });
for (const [name, schema] of Object.entries({
  config: configSchema,
  request: requestSchema,
  model: modelSchema,
  result: resultSchema,
  policy: policySchema,
  manifest: manifestSchema,
  aggregate: aggregateSchema,
  pointer: pointerSchema,
})) {
  await Bun.write(
    new URL(`${name}.schema.json`, directory),
    `${JSON.stringify(z.toJSONSchema(schema, { target: "draft-2020-12", io: name === "result" ? "output" : "input" }), null, 2)}\n`,
  );
}

const tasksDirectory = new URL(
  "../docs/contracts/recommendations/tasks/v1/",
  import.meta.url,
);
await mkdir(tasksDirectory, { recursive: true });
for (const [name, schema] of Object.entries({
  registration: registrationTaskInput,
  ingest: ingestTaskInput,
  decision: decisionTaskInput,
  maintenance: maintenanceTaskInput,
})) {
  await Bun.write(
    new URL(`${name}.schema.json`, tasksDirectory),
    `${JSON.stringify(z.toJSONSchema(schema, { target: "draft-2020-12", io: "input" }), null, 2)}\n`,
  );
}
