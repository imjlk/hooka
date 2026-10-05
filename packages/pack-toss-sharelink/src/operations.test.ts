import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { configSchema, type Snapshot } from "./contracts";
import { selectSharelinkOffer } from "./consumer";
import {
  planSharelinkRefresh,
  readSharelinkAccounts,
  readSharelinkConfig,
  summarizeSharelinkApp,
  worksetSchema,
} from "./operations";
import { temporarySetup, testAccount, testApp, testStore } from "./fixtures";

function first<T>(items: T[]): T {
  const item = items[0];
  if (item === undefined) throw new Error("Missing fixture item");
  return item;
}
const config = () =>
  configSchema.parse({
    schemaVersion: 1,
    accounts: [testAccount],
    apps: [testApp()],
  });
const now = 1800000000000;

test("workset schema publishes and enforces unique subject IDs", () => {
  const workset = {
    schemaVersion: 1,
    appId: "app-one",
    appRevision: 1,
    expiresAt: now + 60000,
    subjectIds: ["pillow", "pillow"],
  };
  expect(worksetSchema.safeParse(workset).success).toBe(false);
  expect(
    z.toJSONSchema(worksetSchema).properties?.["subjectIds"],
  ).toMatchObject({ uniqueItems: true });
});
const expected = {
  appId: "app-one",
  appRevision: 1,
  subjectId: "pillow",
  ruleRevision: 1,
};
const snapshot = (): Snapshot => ({
  schemaVersion: 1,
  appId: "app-one",
  appRevision: 1,
  generationId: randomUUID(),
  generatedAt: now - 1,
  entries: [
    {
      subjectId: "pillow",
      ruleRevision: 1,
      status: "ready",
      offer: {
        provider: "toss-sharelink",
        productId: "123",
        title: "베개",
        url: "https://toss.im/_m/example",
        source: "automatic",
        checkedAt: now - 100,
        expiresAt: now + 100,
      },
    },
  ],
});

test("consumer rejects stale identities, expired offers, future timestamps and duplicates", () => {
  expect(selectSharelinkOffer(snapshot(), expected, now)?.productId).toBe(
    "123",
  );
  for (const change of [
    { appId: "another" },
    { appRevision: 2 },
    { ruleRevision: 2 },
    { subjectId: "unknown" },
  ])
    expect(
      selectSharelinkOffer(snapshot(), { ...expected, ...change }, now),
    ).toBeNull();
  expect(selectSharelinkOffer(snapshot(), expected, now + 100)).toBeNull();
  expect(
    selectSharelinkOffer({ ...snapshot(), schemaVersion: 2 }, expected, now),
  ).toBeNull();
  expect(
    selectSharelinkOffer(
      { ...snapshot(), generatedAt: now + 1 },
      expected,
      now,
    ),
  ).toBeNull();
  const duplicate = snapshot();
  duplicate.entries.push(...duplicate.entries);
  expect(selectSharelinkOffer(duplicate, expected, now)).toBeNull();
});

test("planner splits 1000 subjects with stable same-bucket IDs and new next-bucket IDs", () => {
  const data = config();
  first(data.apps).subjects = Array.from({ length: 1000 }, (_, index) => ({
    ...first(testApp().subjects),
    subjectId: `subject-${index}`,
  }));
  const plan = planSharelinkRefresh(data, [], { now });
  expect(plan.jobs).toHaveLength(40);
  expect(plan.jobs.every((job) => job.input.subjectIds?.length === 25)).toBe(
    true,
  );
  expect(planSharelinkRefresh(data, [], { now: now + 1 })).toEqual(plan);
  expect(
    planSharelinkRefresh(data, [], { now: now + 300000 }).jobs[0]
      ?.sourceEventId,
  ).not.toBe(plan.jobs[0]?.sourceEventId);
  expect(
    new Set(plan.jobs.flatMap((job) => job.input.subjectIds ?? [])).size,
  ).toBe(1000);
  expect(() => planSharelinkRefresh(data, [], { batchSize: 101 })).toThrow();
  expect(() => planSharelinkRefresh(data, [], { appId: "unknown" })).toThrow();
});

test("blocked and exhausted accounts export without provider jobs; active manual links can refresh", () => {
  const state = {
    accountId: "partner",
    blockedUntil: now + 60000,
    leasedUntil: 0,
    resetAt: now + 86400000,
    remainingProducts: 100,
    remainingLinks: 100,
  };
  const data = config();
  expect(planSharelinkRefresh(data, [state], { now }).jobs[0]?.taskId).toBe(
    "toss-sharelink.export",
  );
  expect(
    planSharelinkRefresh(
      data,
      [{ ...state, blockedUntil: 0, remainingProducts: 0 }],
      { now },
    ).skipped[0]?.reason,
  ).toBe("daily-budget");
  first(first(data.apps).subjects).manual = {
    productId: "123",
    title: "베개",
    url: "https://toss.im/_m/manual",
    reviewedAt: now - 100,
    reviewUntil: now + 60000,
  };
  expect(planSharelinkRefresh(data, [state], { now }).jobs[0]?.taskId).toBe(
    "toss-sharelink.refresh",
  );
});

test("offline validation and status do not read credentials or mutate private caches", async () => {
  const setup = await temporarySetup();
  try {
    expect(
      (await readSharelinkConfig(setup.env.HOOKA_SHARELINK_CONFIG_PATH)).apps,
    ).toHaveLength(1);
    const store = await testStore(setup.env.HOOKA_SHARELINK_DB_PATH);
    await store.withAccount("partner", async () => {
      store.put("partner", "oauth:test", "do-not-leak", Date.now() + 600000);
      store.reserve(testAccount, 30, 1);
    });
    store.close();
    const status = readSharelinkAccounts(
      setup.env.HOOKA_SHARELINK_DB_PATH,
      config(),
    );
    expect(status[0]?.remainingProducts).toBe(8970);
    expect(JSON.stringify(status)).not.toContain("do-not-leak");
    expect(summarizeSharelinkApp(testApp(), snapshot(), now).counts.ready).toBe(
      1,
    );
    expect(
      summarizeSharelinkApp(testApp(), snapshot(), now + 101).counts.expired,
    ).toBe(1);
    expect(summarizeSharelinkApp(testApp(), null, now).counts.pending).toBe(1);
  } finally {
    await setup.cleanup();
  }
});

test("consumer-only entry bundles for browsers without Bun or SQLite", async () => {
  const result = await Bun.build({
    entrypoints: [new URL("./consumer.ts", import.meta.url).pathname],
    target: "browser",
  });
  expect(result.success).toBe(true);
});
