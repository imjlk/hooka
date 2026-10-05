import { expect, test } from "bun:test";
import { configSchema, type Snapshot } from "./contracts";
import { testApp, testAccount } from "./fixtures";
import {
  previewRefreshPriority,
  estimateRefreshCost,
  refreshDemandSchema,
} from "./refresh-priority";
import {
  worksetSchema,
  planSharelinkRefresh,
  type AccountStatus,
} from "./operations";
import { nextKstDay } from "./store";

const now = 1800000000000;
function fixture(second = false) {
  const app = testApp(),
    first = required(app.subjects[0]);
  app.subjects = [
    first,
    { ...first, subjectId: "urgent" },
    { ...first, subjectId: "cold" },
    { ...first, subjectId: "other-cold" },
  ];
  const config = configSchema.parse({
    schemaVersion: 1,
    accounts: [testAccount],
    apps: second
      ? [app, { ...app, appId: "app-two", subTagId: "app-two-web" }]
      : [app],
  });
  const demand = {
    schemaVersion: 1,
    generatedAt: now,
    expiresAt: now + 900000,
    seed: "repeatable",
    policy: { maxSubjectsPerApp: 3, explorationFraction: 0.3 },
    apps: config.apps.map((a) => ({
      appId: a.appId,
      appRevision: a.revision,
      contextId: "low-ready",
      measurementProfileId: "word-full-1s-v1",
      subjects: [
        { subjectId: "pillow", ruleRevision: 1, estimatedReach: 1000 },
        { subjectId: "urgent", ruleRevision: 1, estimatedReach: 10 },
      ],
    })),
  };
  const snapshot: Snapshot = {
    schemaVersion: 1,
    appId: app.appId,
    appRevision: 1,
    generationId: "00000000-0000-4000-8000-000000000001",
    generatedAt: now,
    entries: ["pillow", "urgent"].map((subjectId, index) => ({
      subjectId,
      ruleRevision: 1,
      status: "ready",
      offer: {
        provider: "toss-sharelink",
        source: "automatic",
        productId: String(123 + index),
        title: "베개",
        url: "https://toss.im/fixture",
        checkedAt: now - 1,
        expiresAt: now + (index ? 60000 : 900000),
      },
    })),
  };
  return { config, demand, snapshot };
}
test("urgent demand precedes high reach and cold exploration receives capacity in deterministic preview", () => {
  const { config, demand, snapshot } = fixture();
  const parsed = refreshDemandSchema.parse(demand);
  parsed.policy.explorationFraction = 1 / 3;
  const result = previewRefreshPriority(config, parsed, [snapshot], [], now),
    repeat = previewRefreshPriority(config, parsed, [snapshot], [], now);
  expect(result).toEqual(repeat);
  expect(result.dispatchEnabled).toBe(false);
  expect(result.budgetReservations).toBe(false);
  expect(result.waitBoundEnforced).toBe(false);
  const app = required(result.apps[0]);
  expect(app.workset.subjectIds.slice(0, 2)).toEqual(["urgent", "pillow"]);
  expect(app.explorationSelected).toBe(1);
  expect(worksetSchema.safeParse(app.workset).success).toBe(true);
  expect(
    planSharelinkRefresh(config, [], {
      appId: app.appId,
      subjectIds: app.workset.subjectIds,
      now,
    }).jobs[0]?.input.subjectIds,
  ).toEqual(app.workset.subjectIds);
  expect(app.estimatedProducts).toBe(99);
  expect(app.estimatedLinks).toBe(9);
});
test("configured app shares cap total cold-cache estimates within observed remaining account budgets", () => {
  const { config, demand } = fixture(true);
  const parsed = refreshDemandSchema.parse(demand);
  parsed.policy.explorationFraction = 0;
  parsed.policy.maxSubjectsPerApp = 4;
  parsed.policy.accountShares = [
    {
      accountId: "partner",
      apps: [
        { appId: "app-one", weight: 1 },
        { appId: "app-two", weight: 3 },
      ],
    },
  ];
  const status: AccountStatus = {
    accountId: "partner",
    blockedUntil: 0,
    leasedUntil: 0,
    resetAt: nextKstDay(now),
    remainingProducts: 132,
    remainingLinks: 12,
  };
  const result = previewRefreshPriority(config, parsed, [], [status], now);
  expect(result.apps.map((a) => a.estimatedProducts)).toEqual([33, 66]);
  expect(
    result.apps[0]?.deferred.some((d) => d.reason === "account-share-budget"),
  ).toBe(true);
  expect(result.accounts[0]?.budgetEvidence).toBe("observed");
  expect(
    result.apps.reduce((n, a) => n + a.estimatedProducts, 0),
  ).toBeLessThanOrEqual(status.remainingProducts);
  expect(
    result.apps.reduce((n, a) => n + a.estimatedLinks, 0),
  ).toBeLessThanOrEqual(status.remainingLinks);
});
test("manual mappings cost zero and survive cooldown while pinned and paged bounds match reservations", () => {
  const { config, demand } = fixture();
  const app = required(config.apps[0]),
    subject = required(app.subjects[0]);
  subject.manual = {
    productId: "123",
    title: "베개",
    url: "https://toss.im/fixture",
    reviewedAt: now - 1,
    reviewUntil: now + 60000,
  };
  expect(estimateRefreshCost(subject, now)).toEqual({ products: 0, links: 0 });
  expect(
    estimateRefreshCost(
      { ...subject, manual: undefined, pinnedProductId: "123" },
      now,
    ),
  ).toEqual({ products: 1, links: 1 });
  expect(
    estimateRefreshCost(
      { ...subject, manual: undefined, maxCatalogPages: 5 },
      now,
    ),
  ).toEqual({ products: 153, links: 3 });
  const blocked = {
    accountId: "partner",
    blockedUntil: now + 60000,
    leasedUntil: 0,
    resetAt: nextKstDay(now),
    remainingProducts: 0,
    remainingLinks: 0,
  };
  const result = required(
    previewRefreshPriority(config, demand, [], [blocked], now).apps[0],
  );
  expect(result.workset.subjectIds).toEqual(["pillow"]);
  expect(result.workset.expiresAt).toBe(now + 60000);
  expect(result.deferred.every((d) => d.reason === "account-cooldown")).toBe(
    true,
  );
});
test("invalid identities, revision, time, duplicate subjects and incomplete shares reject the whole preview", () => {
  const { config, demand } = fixture(true);
  const modify = (change: (d: typeof demand) => void) => {
    const d = structuredClone(demand);
    change(d);
    return d;
  };
  for (const d of [
    modify((d) => {
      d.expiresAt = now;
    }),
    modify((d) => {
      d.generatedAt = now + 1;
    }),
    modify((d) => {
      required(d.apps[0]).appRevision = 2;
    }),
    modify((d) => {
      required(required(d.apps[0]).subjects[0]).ruleRevision = 2;
    }),
    modify((d) => {
      required(d.apps[0]).subjects.push({
        ...required(required(d.apps[0]).subjects[0]),
      });
    }),
    modify((d) => {
      required(required(d.apps[0]).subjects[0]).subjectId = "unknown";
    }),
  ])
    expect(() => previewRefreshPriority(config, d, [], [], now)).toThrow();
  const parsed = refreshDemandSchema.parse(demand);
  parsed.policy.accountShares = [
    { accountId: "partner", apps: [{ appId: "app-one", weight: 1 }] },
  ];
  expect(() => previewRefreshPriority(config, parsed, [], [], now)).toThrow();
  required(required(config.apps[0]).subjects[0]).enabled = false;
  expect(() => previewRefreshPriority(config, demand, [], [], now)).toThrow();
});
test("stale/future snapshots are not current, small capacity rotates exploration and zero disables it", () => {
  const { config, demand, snapshot } = fixture();
  const parsed = refreshDemandSchema.parse(demand);
  parsed.policy.maxSubjectsPerApp = 1;
  parsed.policy.explorationFraction = 0.2;
  const reports = Array.from({ length: 30 }, (_, i) =>
    previewRefreshPriority(
      config,
      {
        ...parsed,
        generatedAt: now + i * 300000,
        expiresAt: now + i * 300000 + 60000,
      },
      [],
      [],
      now + i * 300000,
    ),
  );
  expect(
    reports.some((r) => required(r.apps[0]).explorationSelected === 1),
  ).toBe(true);
  expect(
    reports.some((r) => required(r.apps[0]).explorationSelected === 0),
  ).toBe(true);
  parsed.policy.explorationFraction = 0;
  expect(
    previewRefreshPriority(
      config,
      parsed,
      [{ ...snapshot, appRevision: 2 }],
      [],
      now,
    ).apps[0]?.snapshotCurrent,
  ).toBe(false);
  expect(
    previewRefreshPriority(
      config,
      parsed,
      [{ ...snapshot, generatedAt: now + 1 }],
      [],
      now,
    ).apps[0]?.snapshotCurrent,
  ).toBe(false);
  expect(
    previewRefreshPriority(config, parsed, [], [], now).apps[0]
      ?.explorationSelected,
  ).toBe(0);
  expect(() =>
    previewRefreshPriority(
      config,
      parsed,
      [],
      [
        {
          accountId: "partner",
          resetAt: now,
          blockedUntil: 0,
          leasedUntil: 0,
          remainingProducts: 9000,
          remainingLinks: 9000,
        },
      ],
      now,
    ),
  ).toThrow();
});

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined)
    throw Error("Missing fixture value");
  return value;
}

test("an expired zero-demand offer joins missing-offer exploration before current offers", () => {
  const { config, demand, snapshot } = fixture();
  const parsed = refreshDemandSchema.parse(demand);
  parsed.apps[0] = { ...required(parsed.apps[0]), subjects: [] };
  parsed.policy.maxSubjectsPerApp = 1;
  parsed.policy.explorationFraction = 0.5;
  const offer = required(snapshot.entries[0]?.offer);
  snapshot.entries = required(config.apps[0]).subjects.map((s) => ({
    subjectId: s.subjectId,
    ruleRevision: s.revision,
    status: "ready",
    offer: {
      ...offer,
      checkedAt: now - 100,
      expiresAt: s.subjectId === "cold" ? now - 1 : now + 60000,
    },
  }));
  const report = required(
    previewRefreshPriority(config, parsed, [snapshot], [], now).apps[0],
  );
  expect(report.workset.subjectIds).toEqual(["cold"]);
  expect(report.selected[0]).toMatchObject({
    offerExpiresAt: null,
    overdue: true,
    reason: "exploration",
  });
});
