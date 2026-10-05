import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { scoreRecommendations } from "@hooka/pack-recommendations";
import { temporarySetup, testApp } from "./fixtures";
import { recommendationFixture } from "./recommendations.fixture";
import { eligibleProducts, matchProducts } from "./matching";
import {
  productOrderingRequest,
  applyProductOrdering,
  rankSharelinkProducts,
} from "./recommendations";

const products = () =>
  ["123", "124", "125", "126"].map((id) => ({
    id,
    title: "편안한 베개",
    categoryIds: ["10"],
    soldOut: false,
  }));
const categories = [{ id: "10", children: [] }];
test("ranking can choose the fourth observed eligible product before the three-attempt cap", async () => {
  const app = testApp(),
    subject = required(app.subjects[0]);
  const setup = await temporarySetup([app]);
  try {
    const now = Date.now(),
      f = await recommendationFixture(setup.directory, app, now),
      all = products();
    expect(matchProducts(all, categories, subject).map((p) => p.id)).toEqual([
      "123",
      "124",
      "125",
    ]);
    expect(eligibleProducts(all, categories, subject)).toHaveLength(4);
    const ranked = await rankSharelinkProducts(all, app, subject, f.env, now);
    expect(ranked.products[0]?.id).toBe("126");
    expect(ranked.diagnostic?.ranked).toBe(4);
    expect(ranked.diagnostic?.modelGenerationId).toBe("fixture-ranked");
  } finally {
    await setup.cleanup();
  }
});
test("unregistered products keep their slots and a uniform prior keeps provider order", async () => {
  const app = testApp(),
    subject = required(app.subjects[0]),
    setup = await temporarySetup();
  try {
    const now = Date.now(),
      f = await recommendationFixture(setup.directory, app, now);
    const all = products();
    all.splice(1, 0, { ...required(all[0]), id: "999" });
    const prepared = required(
      productOrderingRequest(f.config, f.bindings, app, subject, all, now),
    );
    const result = scoreRecommendations(
      f.config,
      prepared.request,
      f.model,
      now,
    );
    const ranked = applyProductOrdering(all, prepared, result, now);
    expect(ranked[0]?.id).toBe("126");
    expect(ranked[1]?.id).toBe("999");
    expect(
      applyProductOrdering(
        all,
        prepared,
        scoreRecommendations(
          f.config,
          prepared.request,
          { ...f.model, rows: [] },
          now,
        ),
        now,
      ),
    ).toEqual(all);
    expect(() =>
      applyProductOrdering(
        all,
        prepared,
        { ...result, inputDigest: "0".repeat(64) },
        now,
      ),
    ).toThrow();
  } finally {
    await setup.cleanup();
  }
});
test("disabled extension, manual and pinned precedence never require recommendation files", async () => {
  const app = testApp(),
    subject = required(app.subjects[0]),
    all = products(),
    now = Date.now();
  for (const rule of [
    subject,
    { ...subject, pinnedProductId: "123" },
    {
      ...subject,
      manual: {
        productId: "123",
        title: "베개",
        url: "https://toss.im/fixture",
        reviewedAt: now - 1,
        reviewUntil: now + 60000,
      },
    },
  ]) {
    const enabled = rule === subject ? "false" : "true";
    expect(
      await rankSharelinkProducts(
        all,
        app,
        rule,
        {
          HOOKA_SHARELINK_RECOMMENDATIONS_ENABLED: enabled,
          HOOKA_RECOMMENDATIONS_DB_PATH: "/missing",
        },
        now,
      ),
    ).toEqual({ products: all });
  }
});
test("stale binding, expired model, missing DB and corrupt configuration fall back without mutation", async () => {
  const app = testApp(),
    subject = required(app.subjects[0]),
    setup = await temporarySetup();
  try {
    const now = Date.now(),
      f = await recommendationFixture(setup.directory, app, now),
      all = products();
    expect(
      (
        await rankSharelinkProducts(
          all,
          { ...app, revision: 2 },
          subject,
          f.env,
          now,
        )
      ).diagnostic?.reason,
    ).toBe("binding-mismatch");
    expect(
      (
        await rankSharelinkProducts(
          all,
          app,
          { ...subject, revision: 2 },
          f.env,
          now,
        )
      ).diagnostic?.reason,
    ).toBe("binding-mismatch");
    const before = await Bun.file(f.dbPath).arrayBuffer();
    expect(
      (await rankSharelinkProducts(all, app, subject, f.env, now + 86400001))
        .products,
    ).toEqual(all);
    expect(await Bun.file(f.dbPath).arrayBuffer()).toEqual(before);
    const missing = {
      ...f.env,
      HOOKA_RECOMMENDATIONS_DB_PATH: `${setup.directory}/missing.sqlite`,
    };
    expect(
      (await rankSharelinkProducts(all, app, subject, missing, now)).products,
    ).toEqual(all);
    expect(await Bun.file(missing.HOOKA_RECOMMENDATIONS_DB_PATH).exists()).toBe(
      false,
    );
    await Bun.write(f.configPath, "{}");
    expect(
      (await rankSharelinkProducts(all, app, subject, f.env, now)).products,
    ).toEqual(all);
    const db = new Database(f.dbPath, { readonly: true });
    expect(db.query("SELECT count(*) n FROM rec_decisions").get()).toEqual({
      n: 0,
    });
    db.close();
  } finally {
    await setup.cleanup();
  }
});
test("recommendation ordering cannot introduce excluded, sold-out, unrelated or pinned alternatives", () => {
  const subject = required(testApp().subjects[0]);
  const all = [
    ...products(),
    { ...required(products()[0]), id: "999", soldOut: true },
    { ...required(products()[0]), id: "998", title: "베개 커버" },
    { ...required(products()[0]), id: "997", categoryIds: ["99"] },
  ];
  expect(eligibleProducts(all, categories, subject)).toHaveLength(4);
  expect(
    eligibleProducts(all, categories, {
      ...subject,
      excludedProductIds: ["126"],
      pinnedProductId: "126",
    }),
  ).toEqual([]);
});

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined)
    throw Error("Missing fixture value");
  return value;
}
