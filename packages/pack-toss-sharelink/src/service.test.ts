import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { join } from "node:path";
import {
  refreshSharelinkTask,
  exportSharelinkTask,
  ensureSubTagTask,
  performanceTask,
  settlementTask,
} from "./index";
import { runTask } from "@hooka/runner-core";
import { snapshotSchema } from "./contracts";
import {
  success,
  temporarySetup,
  testAccount,
  testApp,
  testProduct,
} from "./fixtures";
import { SharelinkStore } from "./store";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  mock.restore();
});
const options = (env: Record<string, string>) => ({
  installedCapabilities: ["toss-sharelink"],
  env,
});

test("refresh preserves selected priority order and defaults to config order", async () => {
  noPacingDelay();
  const app = testApp(),
    subject = app.subjects[0];
  if (!subject) throw Error("Missing subject");
  const reviewedAt = Date.now() - 100,
    reviewUntil = Date.now() + 60000;
  const manual = {
    productId: "123",
    title: "베개",
    url: "https://toss.im/_m/example",
    reviewedAt,
    reviewUntil,
  };
  app.subjects = [
    { ...subject, manual },
    { ...subject, subjectId: "second", manual },
  ];
  const setup = await temporarySetup([app]);
  try {
    expect(
      await runTask(
        refreshSharelinkTask,
        {
          schemaVersion: 1,
          appId: app.appId,
          subjectIds: ["second", "pillow"],
        },
        options(setup.env),
      ),
    ).toMatchObject({
      ok: true,
      data: { inspections: [{ subjectId: "second" }, { subjectId: "pillow" }] },
    });
    expect(
      await runTask(
        refreshSharelinkTask,
        { schemaVersion: 1, appId: app.appId },
        options(setup.env),
      ),
    ).toMatchObject({
      ok: true,
      data: { inspections: [{ subjectId: "pillow" }, { subjectId: "second" }] },
    });
  } finally {
    await setup.cleanup();
  }
});

test.each([true, false])(
  "pinned product checks detail without catalog fallback: available=%s",
  async (available) => {
    noPacingDelay();
    const app = testApp();
    const subject = app.subjects[0];
    if (!subject) throw Error("Missing subject");
    subject.pinnedProductId = "888";
    const setup = await temporarySetup([app]);
    const calls = providerRouter((url) =>
      url.pathname === "/openapi/products/detail"
        ? success({ items: available ? [testProduct(888)] : [] })
        : undefined,
    );
    try {
      expect(
        await runTask(refreshSharelinkTask, input, options(setup.env)),
      ).toMatchObject({ ok: true, data: { ready: Number(available) } });
      expect(calls.some((path) => path.includes("best-categories"))).toBe(
        false,
      );
      const data = await Bun.file(
        join(setup.env.HOOKA_SHARELINK_RESULTS_PATH, app.appId, "offers.json"),
      ).json();
      expect(data.entries[0].offer?.productId ?? null).toBe(
        available ? "888" : null,
      );
    } finally {
      await setup.cleanup();
    }
  },
);

test("catalog matching reaches the next cursor page within the configured bound", async () => {
  noPacingDelay();
  const app = testApp(),
    subject = app.subjects[0];
  if (!subject) throw Error("Missing subject");
  subject.maxCatalogPages = 2;
  const setup = await temporarySetup([app]);
  const pages: (string | null)[] = [];
  providerRouter((url) => {
    if (url.pathname.includes("best-categories")) {
      const cursor = url.searchParams.get("cursor");
      pages.push(cursor);
      return cursor
        ? success({ items: [testProduct()], hasNext: false, nextCursor: null })
        : success({
            items: [testProduct(122, { displayName: "물병" })],
            hasNext: true,
            nextCursor: "next",
          });
    }
    if (url.pathname === "/openapi/products/detail")
      return success({ items: [testProduct()] });
    return undefined;
  });
  try {
    expect(
      await runTask(refreshSharelinkTask, input, options(setup.env)),
    ).toMatchObject({
      ok: true,
      data: { ready: 1, inspections: [{ pages: 2, candidates: 1 }] },
    });
    expect(pages).toEqual([null, "next"]);
  } finally {
    await setup.cleanup();
  }
});
const input = { schemaVersion: 1, appId: "app-one" };
function noPacingDelay() {
  spyOn(SharelinkStore.prototype, "pace").mockImplementation(
    async (_id, guard) => guard(),
  );
}

function providerRouter(
  override?: (url: URL, body: Record<string, unknown>) => Response | undefined,
) {
  const calls: string[] = [];
  globalThis.fetch = mock(
    async (request: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(request));
      calls.push(url.pathname);
      const body =
        init?.body && typeof init.body === "string" && init.body.startsWith("{")
          ? (JSON.parse(init.body) as Record<string, unknown>)
          : {};
      const custom = override?.(url, body);
      if (custom) return custom;
      if (url.hostname === "oauth2.cert.toss.im")
        return Response.json({
          access_token: "test-oauth-token",
          expires_in: 3600,
        });
      if (url.pathname === "/openapi/categories")
        return success({
          categories: [
            { categoryId: 10, children: [{ categoryId: 11, children: [] }] },
          ],
        });
      if (url.pathname.startsWith("/openapi/products/"))
        return success({
          items: [
            testProduct(122, { displayName: "베개 커버" }),
            testProduct(),
          ],
        });
      if (url.pathname === "/openapi/links")
        return success({
          tacaItemId: body["tacaItemId"],
          publisherId: testAccount.publisherId,
          shortUrl: "https://toss.im/_m/example",
        });
      throw new Error(`Unexpected test route: ${url.pathname}`);
    },
  ) as unknown as typeof fetch;
  return calls;
}

test("refresh executes OAuth, matching, detail and issuance then exports a validated snapshot", async () => {
  noPacingDelay();
  const setup = await temporarySetup();
  const calls = providerRouter((url) =>
    url.pathname === "/openapi/products/detail"
      ? success({ items: [testProduct()] })
      : undefined,
  );
  try {
    const result = await runTask(
      refreshSharelinkTask,
      input,
      options(setup.env),
    );
    expect(result).toMatchObject({ ok: true, data: { ready: 1, total: 1 } });
    const file = join(
      setup.env.HOOKA_SHARELINK_RESULTS_PATH,
      "app-one",
      "offers.json",
    );
    const data = snapshotSchema.parse(await Bun.file(file).json());
    expect(data.entries[0]?.offer).toMatchObject({
      productId: "123",
      source: "automatic",
      url: "https://toss.im/_m/example",
    });
    expect(await Bun.file(file).text()).not.toContain("test-oauth-token");
    const firstCount = calls.length;
    expect(
      (await runTask(refreshSharelinkTask, input, options(setup.env))).ok,
    ).toBe(true);
    expect(calls.length).toBe(firstCount);
    await setup.writeConfig([
      {
        ...testApp(),
        revision: 2,
        subjects: testApp().subjects.map((s) => ({
          ...s,
          enabled: false,
          revision: 2,
        })),
      },
    ]);
    expect(
      (await runTask(exportSharelinkTask, input, options(setup.env))).ok,
    ).toBe(true);
    expect((await Bun.file(file).json()).entries[0]).toMatchObject({
      status: "disabled",
      offer: null,
    });
    expect(calls.length).toBe(firstCount);
  } finally {
    await setup.cleanup();
  }
});

test("manual priority and dry-run make no provider requests", async () => {
  const app = testApp();
  app.subjects = app.subjects.map((s) => ({
    ...s,
    manual: {
      productId: "123",
      title: "베개",
      url: "https://toss.im/_m/manual",
      reviewedAt: Date.now() - 1000,
      reviewUntil: Date.now() + 3600000,
    },
  }));
  const setup = await temporarySetup([app]);
  const transport = mock(async () => {
    throw new Error("must not call provider");
  });
  globalThis.fetch = transport as unknown as typeof fetch;
  try {
    expect(
      (
        await runTask(refreshSharelinkTask, input, {
          ...options(setup.env),
          dryRun: true,
        })
      ).status,
    ).toBe("skipped");
    expect(await Bun.file(setup.env.HOOKA_SHARELINK_DB_PATH).exists()).toBe(
      false,
    );
    expect(
      (await runTask(refreshSharelinkTask, input, options(setup.env))).data,
    ).toMatchObject({ ready: 1 });
    expect(transport).not.toHaveBeenCalled();
  } finally {
    await setup.cleanup();
  }
});

test("item-specific link refusal advances to another matching candidate", async () => {
  noPacingDelay();
  const setup = await temporarySetup();
  const calls = providerRouter((url, body) => {
    if (url.pathname === "/openapi/products/detail")
      return success({
        items: [testProduct(Number(url.searchParams.get("tacaItemIds")))],
      });
    if (url.pathname.startsWith("/openapi/products/"))
      return success({ items: [testProduct(123), testProduct(124)] });
    if (url.pathname === "/openapi/links" && body["tacaItemId"] === 123)
      return Response.json({
        resultType: "FAIL",
        error: { reason: "item blocked" },
      });
    return undefined;
  });
  try {
    expect(
      (await runTask(refreshSharelinkTask, input, options(setup.env))).ok,
    ).toBe(true);
    expect(calls.filter((path) => path === "/openapi/links")).toHaveLength(2);
    const snapshot = await Bun.file(
      join(setup.env.HOOKA_SHARELINK_RESULTS_PATH, "app-one", "offers.json"),
    ).json();
    expect(snapshot.entries[0].offer.productId).toBe("124");
  } finally {
    await setup.cleanup();
  }
});

test("daily provider quota stops the batch and withdraws the active subject", async () => {
  noPacingDelay();
  const setup = await temporarySetup();
  const calls = providerRouter((url) =>
    url.pathname === "/openapi/categories"
      ? Response.json({
          resultType: "FAIL",
          error: { errorCode: "SHARELINK_OPENAPI_QUOTA_EXCEEDED" },
        })
      : undefined,
  );
  try {
    const result = await runTask(
      refreshSharelinkTask,
      input,
      options(setup.env),
    );
    expect(result).toMatchObject({
      ok: false,
      errorCode: "sharelink_provider_daily_budget",
      retryable: false,
    });
    expect(calls).toEqual(["/token", "/openapi/categories"]);
    const snapshot = await Bun.file(
      join(setup.env.HOOKA_SHARELINK_RESULTS_PATH, "app-one", "offers.json"),
    ).json();
    expect(snapshot.entries[0]).toMatchObject({
      status: "pending",
      offer: null,
    });
  } finally {
    await setup.cleanup();
  }
});

test("channel registration is explicit and ordinary refresh never creates a subTag", async () => {
  noPacingDelay();
  const setup = await temporarySetup();
  const calls = providerRouter((url, body) => {
    if (url.pathname === "/openapi/sub-tags/create") {
      expect(body).toEqual({ subTags: [{ subTagId: "app-one-web" }] });
      return success({
        results: [{ subTagId: "app-one-web", status: "CREATED" }],
      });
    }
    return undefined;
  });
  try {
    expect(
      (await runTask(ensureSubTagTask, input, options(setup.env))).data,
    ).toMatchObject({ registered: true });
    expect(calls).toEqual(["/token", "/openapi/sub-tags/create"]);
  } finally {
    await setup.cleanup();
  }
});

const performanceTotals = {
  soldQuantity: 2,
  refundedQuantity: 0,
  salesAmount: 200,
  discountAmount: 0,
  netPaymentAmount: 200,
  expectedCommissionAmount: 10,
  confirmedCommissionAmount: 5,
};
const settlementTotals = {
  orderProductCount: 1,
  productAmount: 100,
  promotionCost: 0,
  settlementBase: 100,
  commissionAmount: 5,
  latestConfirmedAt: null,
};

test("performance pages use one whole-range summary and keep reports out of offer snapshots", async () => {
  noPacingDelay();
  const setup = await temporarySetup();
  providerRouter((url) => {
    if (url.pathname !== "/openapi/performance") return undefined;
    expect(url.searchParams.get("subTagId")).toBe("app-one-web");
    const second = url.searchParams.has("cursor");
    return success({
      subTagId: "app-one-web",
      fromDate: "2026-10-01",
      toDate: "2026-10-02",
      summary: { ...performanceTotals, clickCount: 8, lastUpdatedAt: null },
      items: [
        {
          ...performanceTotals,
          productId: second ? 124 : 123,
          productName: "베개",
          attribution: "DIRECT",
        },
      ],
      hasNext: !second,
      nextCursor: second ? null : "next",
    });
  });
  try {
    const result = await runTask(
      performanceTask,
      { ...input, fromDate: "2026-10-01", toDate: "2026-10-02" },
      options(setup.env),
    );
    expect(result).toMatchObject({
      ok: true,
      data: { kind: "performance", summary: { clickCount: 8 } },
    });
    expect((result.data as { items: unknown[] }).items).toHaveLength(2);
    expect(
      await Bun.file(
        join(setup.env.HOOKA_SHARELINK_RESULTS_PATH, "app-one", "offers.json"),
      ).exists(),
    ).toBe(false);
  } finally {
    await setup.cleanup();
  }
});

test("settlement task preserves confirmed amounts and rejects invalid performance ranges", async () => {
  noPacingDelay();
  const setup = await temporarySetup();
  providerRouter((url) =>
    url.pathname === "/openapi/settlements/2026-09"
      ? success({
          subTagId: "app-one-web",
          settlementMonth: "2026-09",
          summary: settlementTotals,
          items: [],
          hasNext: false,
          nextCursor: null,
        })
      : undefined,
  );
  try {
    expect(
      await runTask(
        settlementTask,
        { ...input, settlementMonth: "2026-09" },
        options(setup.env),
      ),
    ).toMatchObject({
      ok: true,
      data: { kind: "settlement", summary: { commissionAmount: 5 } },
    });
    expect(
      await runTask(
        performanceTask,
        { ...input, fromDate: "2026-01-01", toDate: "2026-02-02" },
        options(setup.env),
      ),
    ).toMatchObject({ ok: false, errorCode: "input_invalid" });
  } finally {
    await setup.cleanup();
  }
});
