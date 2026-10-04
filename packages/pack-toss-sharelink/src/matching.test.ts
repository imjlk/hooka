import { expect, test } from "bun:test";
import { matchProducts } from "./matching";
import type { Product } from "./provider";
import { testApp } from "./fixtures";
const categories = [
  {
    id: "10",
    children: [{ id: "11", children: [{ id: "12", children: [] }] }],
  },
];
const product = (overrides: Partial<Product> = {}): Product => ({
  id: "123",
  title: "편안한 베개",
  categoryIds: ["11"],
  soldOut: false,
  ...overrides,
});
function rule() {
  const value = testApp().subjects[0];
  if (!value) throw new Error("Missing rule fixture");
  return value;
}

test("matching requires both category descendants and normalized keywords", () => {
  expect(
    matchProducts([product({ title: "편안한 베 개" })], categories, rule()),
  ).toHaveLength(1);
  expect(
    matchProducts([product({ categoryIds: ["99"] })], categories, rule()),
  ).toEqual([]);
  expect(
    matchProducts([product({ title: "커피" })], categories, rule()),
  ).toEqual([]);
  expect(
    matchProducts([product()], categories, { ...rule(), categoryId: "99" }),
  ).toEqual([]);
});

test("excluded descendants, product IDs, words, stock and expiry take priority", () => {
  expect(
    matchProducts([product({ categoryIds: ["12"] })], categories, {
      ...rule(),
      excludedCategoryIds: ["11"],
    }),
  ).toEqual([]);
  expect(
    matchProducts([product()], categories, {
      ...rule(),
      excludedProductIds: ["123"],
    }),
  ).toEqual([]);
  expect(
    matchProducts(
      [
        product({ title: "베개 커버" }),
        product({ soldOut: true }),
        product({ endAt: Date.now() + 1000 }),
      ],
      categories,
      rule(),
    ),
  ).toEqual([]);
});

test("candidate list preserves provider order, removes duplicates, and bounds issuance to three", () => {
  const result = matchProducts(
    [
      product(),
      product(),
      product({ id: "124" }),
      product({ id: "125" }),
      product({ id: "126" }),
    ],
    categories,
    rule(),
  );
  expect(result.map((p) => p.id)).toEqual(["123", "124", "125"]);
});
